using System.Collections.Concurrent;
using Microsoft.Data.Sqlite;

namespace NoteControl.Server.Search.Services;

/// <summary>
/// Per-vault SQLite connection cache plus a per-vault async write lock.
/// <para>
/// SQLite connections in <c>Microsoft.Data.Sqlite</c> are not thread-safe
/// for concurrent commands. We could open one per request, but for an
/// FTS5 workload that's needlessly expensive — instead we keep a single
/// long-lived connection per vault and serialise all access through
/// <see cref="EnterAsync"/>. The per-vault scoping means searches in
/// vault A don't block writes in vault B.
/// </para>
/// <para>
/// WAL mode (set in <see cref="IndexSchema.ConnectionPragmas"/>) means
/// that even though we serialise on the C# side, multiple processes (or
/// future read-parallel paths) wouldn't deadlock the file.
/// </para>
/// <para>
/// Why does <see cref="EnterAsync"/> take a <c>vaultRoot</c> rather than
/// resolving it from a <c>vaultId</c>? The pool is a singleton and so
/// can't depend on the scoped <c>ServerDbContext</c> needed to look up
/// the vault row. Callers (which already hold a scoped context) pass
/// the absolute root in.
/// </para>
/// </summary>
public interface IIndexConnectionPool : IAsyncDisposable
{
    /// <summary>
    /// Acquire the per-vault lock and a ready-to-use connection.
    /// Dispose the returned <see cref="IndexConnectionLease"/> to release
    /// the lock. The connection itself is owned by the pool and stays open.
    /// </summary>
    /// <param name="vaultRoot">Absolute path to the vault folder.</param>
    Task<IndexConnectionLease> EnterAsync(Guid vaultId, string vaultRoot, CancellationToken ct = default);

    /// <summary>
    /// Drop the cached connection for a vault (e.g. after the vault's
    /// folder has been deleted). Subsequent <see cref="EnterAsync"/> calls
    /// will reopen.
    /// </summary>
    Task EvictAsync(Guid vaultId);
}

/// <summary>
/// Holds the lock + connection for one vault. Returned by
/// <see cref="IIndexConnectionPool.EnterAsync"/>; dispose to release.
/// </summary>
public sealed class IndexConnectionLease : IAsyncDisposable
{
    private readonly SemaphoreSlim _gate;
    private bool _disposed;

    public SqliteConnection Connection { get; }

    internal IndexConnectionLease(SqliteConnection connection, SemaphoreSlim gate)
    {
        Connection = connection;
        _gate = gate;
    }

    public ValueTask DisposeAsync()
    {
        if (!_disposed)
        {
            _disposed = true;
            _gate.Release();
        }
        return ValueTask.CompletedTask;
    }
}

public sealed class IndexConnectionPool : IIndexConnectionPool
{
    // One entry per known vault. Created lazily on first EnterAsync.
    private readonly ConcurrentDictionary<Guid, VaultEntry> _entries = new();

    // Single global gate around the dictionary itself for the create-or-get
    // path. Ordinary Enter calls don't take this — only the slow path that
    // opens a fresh connection.
    private readonly SemaphoreSlim _createGate = new(1, 1);

    public async Task<IndexConnectionLease> EnterAsync(Guid vaultId, string vaultRoot, CancellationToken ct = default)
    {
        var entry = await GetOrCreateEntryAsync(vaultId, vaultRoot, ct).ConfigureAwait(false);
        await entry.Gate.WaitAsync(ct).ConfigureAwait(false);
        return new IndexConnectionLease(entry.Connection, entry.Gate);
    }

    public async Task EvictAsync(Guid vaultId)
    {
        if (_entries.TryRemove(vaultId, out var entry))
        {
            // Acquire the gate before disposing so we don't pull the
            // connection out from under an active operation.
            await entry.Gate.WaitAsync().ConfigureAwait(false);
            try
            {
                await entry.Connection.DisposeAsync().ConfigureAwait(false);
            }
            finally
            {
                entry.Gate.Release();
                entry.Gate.Dispose();
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var (_, entry) in _entries)
        {
            await entry.Connection.DisposeAsync().ConfigureAwait(false);
            entry.Gate.Dispose();
        }
        _entries.Clear();
        _createGate.Dispose();
    }

    private async Task<VaultEntry> GetOrCreateEntryAsync(Guid vaultId, string vaultRoot, CancellationToken ct)
    {
        if (_entries.TryGetValue(vaultId, out var existing))
        {
            return existing;
        }

        await _createGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // Double-check under the lock.
            if (_entries.TryGetValue(vaultId, out existing))
            {
                return existing;
            }

            var dbPath = Path.Combine(vaultRoot, ".notesapp", "index.db");
            Directory.CreateDirectory(Path.GetDirectoryName(dbPath)!);

            var conn = new SqliteConnection($"Data Source={dbPath};");
            await conn.OpenAsync(ct).ConfigureAwait(false);

            // Run pragmas + schema. These are idempotent; running on every
            // connection open would be redundant after the first time, but
            // we only open once per vault per process so it's free.
            await using (var pragmas = conn.CreateCommand())
            {
                pragmas.CommandText = IndexSchema.ConnectionPragmas;
                await pragmas.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            }
            await using (var schema = conn.CreateCommand())
            {
                schema.CommandText = IndexSchema.CreateAll;
                await schema.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            }
            await using (var ver = conn.CreateCommand())
            {
                ver.CommandText = $"PRAGMA user_version = {IndexSchema.SchemaVersion};";
                await ver.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            }

            var entry = new VaultEntry(conn, new SemaphoreSlim(1, 1));
            _entries[vaultId] = entry;
            return entry;
        }
        finally
        {
            _createGate.Release();
        }
    }

    private sealed record VaultEntry(SqliteConnection Connection, SemaphoreSlim Gate);
}
