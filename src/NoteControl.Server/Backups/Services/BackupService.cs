using System.Globalization;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Options;
using NoteControl.Server.Options;

namespace NoteControl.Server.Backups.Services;

/// <summary>
/// Backup engine. Walks the data root, copies every vault folder
/// and the <c>.server/</c> folder to a timestamped subdirectory of
/// the configured target path. SQLite databases are snapshotted
/// via <c>VACUUM INTO</c> so the result is guaranteed-consistent
/// even while the server is taking writes.
/// <para>
/// Retention pruning runs at the END of a successful backup —
/// failures don't trigger pruning, so a series of failed runs can
/// never destroy your prior backups.
/// </para>
/// <para>
/// One backup at a time. Concurrent <see cref="RunNowAsync"/>
/// calls return the in-progress status instead of starting a
/// second run.
/// </para>
/// </summary>
public interface IBackupService
{
    /// <summary>
    /// Run a backup synchronously — returns when the copy is done.
    /// For typical solo-user vaults that's seconds; for vaults with
    /// many notes it can be a minute or more. The HTTP endpoint
    /// long-polls.
    /// </summary>
    Task<BackupRunResult> RunNowAsync(CancellationToken ct = default);

    /// <summary>List existing backups in the target folder.</summary>
    IReadOnlyList<BackupRecord> List();

    /// <summary>Look up one backup by id (the timestamp folder name).</summary>
    BackupRecord? GetById(string id);

    /// <summary>Delete one backup (recursive folder remove).</summary>
    void DeleteOne(string id);

    /// <summary>
    /// Snapshot of the most recent run's status. Returned by the
    /// /status endpoint; used by the BackupsWindow status panel.
    /// </summary>
    BackupRunStatus GetStatus();
}

/// <summary>Outcome of a single run, returned to the caller.</summary>
public sealed record BackupRunResult(
    bool Success,
    string? BackupId,
    string? Error,
    long DurationMs,
    long BytesCopied);

/// <summary>Status snapshot for the UI.</summary>
public sealed record BackupRunStatus(
    bool Running,
    DateTimeOffset? LastRunAt,
    bool? LastRunSuccess,
    string? LastRunError,
    long? LastRunDurationMs,
    string? CurrentTargetPath,
    int BackupCount,
    long TotalBytes);

public sealed class BackupService : IBackupService
{
    // Format: 2026-04-29T03-30-00Z. Lex-sortable, Windows-safe
    // (no colons), UTC-explicit. The retention pruner relies on
    // this being lex-sortable to find the oldest folders.
    private const string IdFormat = "yyyy-MM-ddTHH-mm-ssZ";
    private const string ManifestFileName = "backup.manifest.json";

    private readonly IOptionsMonitor<StorageOptions> _storage;
    private readonly IOptionsMonitor<BackupOptions> _backup;
    private readonly ILogger<BackupService> _log;

    private readonly SemaphoreSlim _runLock = new(1, 1);

    // Last-run state. Mutable but only written under _runLock.
    // Reads of these fields are racy-but-harmless: a stale
    // "running" false right after a run starts is an acceptable
    // UI artefact.
    private DateTimeOffset? _lastRunAt;
    private bool? _lastRunSuccess;
    private string? _lastRunError;
    private long? _lastRunDurationMs;

    public BackupService(
        IOptionsMonitor<StorageOptions> storage,
        IOptionsMonitor<BackupOptions> backup,
        ILogger<BackupService> log)
    {
        _storage = storage;
        _backup = backup;
        _log = log;
    }

    // -----------------------------------------------------------------
    // Run
    // -----------------------------------------------------------------

    public async Task<BackupRunResult> RunNowAsync(CancellationToken ct = default)
    {
        var target = _backup.CurrentValue.TargetPath;
        if (string.IsNullOrWhiteSpace(target))
        {
            return new BackupRunResult(false, null,
                "Backup target path is not configured. Set it in Server Settings → Backups.",
                0, 0);
        }

        if (!await _runLock.WaitAsync(0, ct))
        {
            return new BackupRunResult(false, null,
                "A backup is already running.", 0, 0);
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var id = DateTimeOffset.UtcNow.ToString(IdFormat, CultureInfo.InvariantCulture);
        var dataRoot = _storage.CurrentValue.DataRoot;
        var backupRoot = Path.Combine(target, id);
        long bytesCopied = 0;

        try
        {
            // 1. Validate paths.
            if (!Directory.Exists(dataRoot))
            {
                throw new InvalidOperationException(
                    $"Data root '{dataRoot}' does not exist or isn't readable.");
            }
            Directory.CreateDirectory(target);
            Directory.CreateDirectory(backupRoot);

            _log.LogInformation("Backup {Id} starting → {Target}", id, backupRoot);

            // 2. Walk the data root. Each top-level entry is either
            //    a vault folder or the special .server/ folder. We
            //    treat .server specially (it has SQLite databases
            //    that need VACUUM INTO); vaults get plain copy
            //    plus VACUUM INTO for any nested .notesapp/index.db.
            //
            //    NOTE: we deliberately skip files we don't recognise
            //    at the data-root level. The data root should only
            //    contain known subfolders.
            foreach (var entry in Directory.EnumerateDirectories(dataRoot))
            {
                ct.ThrowIfCancellationRequested();
                var name = Path.GetFileName(entry);
                var dest = Path.Combine(backupRoot, name);

                bytesCopied += await CopyDirectoryAsync(entry, dest, ct);
            }

            // 3. Write a small manifest so callers / future tooling
            //    can identify a backup folder without parsing the
            //    folder name.
            await WriteManifestAsync(backupRoot, id, dataRoot, bytesCopied, ct);

            // 4. Retention pruning. Errors here don't fail the run —
            //    we already have a good backup; pruning is best-effort.
            try
            {
                PruneRetention(target);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Retention pruning failed but backup {Id} succeeded.", id);
            }

            sw.Stop();
            _lastRunAt = DateTimeOffset.UtcNow;
            _lastRunSuccess = true;
            _lastRunError = null;
            _lastRunDurationMs = sw.ElapsedMilliseconds;

            _log.LogInformation(
                "Backup {Id} succeeded ({Bytes} bytes, {Ms} ms).",
                id, bytesCopied, sw.ElapsedMilliseconds);

            return new BackupRunResult(true, id, null, sw.ElapsedMilliseconds, bytesCopied);
        }
        catch (Exception ex)
        {
            sw.Stop();
            _lastRunAt = DateTimeOffset.UtcNow;
            _lastRunSuccess = false;
            _lastRunError = ex.Message;
            _lastRunDurationMs = sw.ElapsedMilliseconds;

            _log.LogError(ex, "Backup {Id} failed.", id);

            // Try to clean up the half-finished folder so the next
            // run doesn't see it. Best-effort; if cleanup fails,
            // the user can delete it manually.
            try
            {
                if (Directory.Exists(backupRoot))
                {
                    Directory.Delete(backupRoot, recursive: true);
                }
            }
            catch { /* ignored */ }

            return new BackupRunResult(false, null, ex.Message, sw.ElapsedMilliseconds, bytesCopied);
        }
        finally
        {
            _runLock.Release();
        }
    }

    /// <summary>
    /// Copy <paramref name="source"/> to <paramref name="dest"/>
    /// recursively. SQLite files (anything ending in .db, .db-wal,
    /// .db-shm) get the special <c>VACUUM INTO</c> treatment so we
    /// produce a consistent snapshot even if the file is open
    /// elsewhere in this process. Everything else is a plain copy.
    /// <para>
    /// Returns <c>Task&lt;long&gt;</c> rather than just <c>long</c>
    /// so the call site can stay <c>await</c>-shaped — easier to
    /// retrofit if we ever switch to genuinely async file I/O.
    /// Today the work is sync (File.Copy + SQLite VACUUM INTO are
    /// both blocking calls); marking the method async would just
    /// produce a CS1998 "lacks await" warning.
    /// </para>
    /// </summary>
    private Task<long> CopyDirectoryAsync(string source, string dest, CancellationToken ct)
    {
        Directory.CreateDirectory(dest);
        long bytes = 0;

        foreach (var dir in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(source, dir);
            Directory.CreateDirectory(Path.Combine(dest, rel));
        }

        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            ct.ThrowIfCancellationRequested();
            var rel = Path.GetRelativePath(source, file);
            var target = Path.Combine(dest, rel);

            // SQLite WAL/SHM are sidecars and should be skipped —
            // VACUUM INTO produces a self-contained snapshot, so
            // copying them would just confuse the restored DB.
            if (file.EndsWith("-wal", StringComparison.OrdinalIgnoreCase) ||
                file.EndsWith("-shm", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (file.EndsWith(".db", StringComparison.OrdinalIgnoreCase))
            {
                bytes += SqliteSnapshot(file, target);
                continue;
            }

            // Plain copy. File.Copy is sync but already buffered;
            // for a pure-IO bound workload sync vs async is a wash.
            File.Copy(file, target, overwrite: true);
            bytes += new FileInfo(target).Length;
        }

        return Task.FromResult(bytes);
    }

    /// <summary>
    /// Use SQLite's <c>VACUUM INTO</c> to write a consistent
    /// snapshot of <paramref name="source"/> to <paramref name="dest"/>.
    /// This works regardless of whether the source database is
    /// currently open by readers or writers — it takes a shared
    /// read lock for the duration and produces a clean copy with
    /// no WAL/SHM sidecars needed.
    /// </summary>
    private static long SqliteSnapshot(string source, string dest)
    {
        // Open in read-only mode so we never accidentally modify
        // the live DB. Mode=ReadOnly + Cache=Shared lets us coexist
        // with the running server's connections.
        var connStr = new SqliteConnectionStringBuilder
        {
            DataSource = source,
            Mode = SqliteOpenMode.ReadOnly,
            Cache = SqliteCacheMode.Shared,
        }.ToString();

        // Make sure the destination doesn't exist — VACUUM INTO
        // refuses to overwrite.
        if (File.Exists(dest)) File.Delete(dest);

        using (var conn = new SqliteConnection(connStr))
        {
            conn.Open();
            using var cmd = conn.CreateCommand();
            // Parameters can't be used for VACUUM INTO's filename;
            // it's a literal in SQLite's grammar. We escape single
            // quotes by doubling them, the SQL standard way.
            var quoted = "'" + dest.Replace("'", "''") + "'";
            cmd.CommandText = $"VACUUM INTO {quoted};";
            cmd.ExecuteNonQuery();
        }

        return new FileInfo(dest).Length;
    }

    private static async Task WriteManifestAsync(
        string backupRoot, string id, string dataRoot, long bytes, CancellationToken ct)
    {
        var manifest = new
        {
            id,
            createdAt = DateTimeOffset.UtcNow,
            dataRoot,
            bytesCopied = bytes,
            schemaVersion = 1,
        };
        var path = Path.Combine(backupRoot, ManifestFileName);
        await using var fs = File.Create(path);
        await System.Text.Json.JsonSerializer.SerializeAsync(
            fs, manifest, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }, ct);
    }

    // -----------------------------------------------------------------
    // Listing / deletion
    // -----------------------------------------------------------------

    public IReadOnlyList<BackupRecord> List()
    {
        var target = _backup.CurrentValue.TargetPath;
        if (string.IsNullOrWhiteSpace(target) || !Directory.Exists(target))
        {
            return Array.Empty<BackupRecord>();
        }

        var results = new List<BackupRecord>();
        foreach (var dir in Directory.EnumerateDirectories(target))
        {
            var name = Path.GetFileName(dir);
            if (!TryParseId(name, out var createdAt)) continue;

            results.Add(new BackupRecord(
                Id: name,
                CreatedAt: createdAt,
                AbsolutePath: dir,
                SizeBytes: ComputeSize(dir),
                VaultFolders: ListVaultFolders(dir)));
        }
        // Most recent first — what the UI wants for the list view.
        results.Sort((a, b) => b.CreatedAt.CompareTo(a.CreatedAt));
        return results;
    }

    public BackupRecord? GetById(string id)
    {
        var target = _backup.CurrentValue.TargetPath;
        if (string.IsNullOrWhiteSpace(target)) return null;
        var dir = Path.Combine(target, id);
        if (!Directory.Exists(dir)) return null;
        if (!TryParseId(id, out var createdAt)) return null;

        return new BackupRecord(
            Id: id,
            CreatedAt: createdAt,
            AbsolutePath: dir,
            SizeBytes: ComputeSize(dir),
            VaultFolders: ListVaultFolders(dir));
    }

    public void DeleteOne(string id)
    {
        var record = GetById(id) ?? throw new FileNotFoundException(
            $"Backup '{id}' was not found.");
        Directory.Delete(record.AbsolutePath, recursive: true);
    }

    /// <summary>
    /// Walk the target folder and remove old backups according to
    /// <c>RetainDailyCount</c>. Weekly retention is honoured by
    /// keeping every Nth backup; for v1 we use the simpler rule
    /// "keep newest <c>RetainDailyCount</c>, delete the rest" and
    /// note <c>RetainWeeklyCount</c> as a stored-but-not-yet-applied
    /// value. (Adding proper weekly rotation is an obvious next
    /// iteration.)
    /// </summary>
    private void PruneRetention(string target)
    {
        var retainDaily = _backup.CurrentValue.RetainDailyCount;
        if (retainDaily <= 0) return;

        var all = Directory.EnumerateDirectories(target)
            .Select(d => new { Path = d, Name = Path.GetFileName(d) })
            .Where(x => TryParseId(x.Name, out _))
            .OrderByDescending(x => x.Name, StringComparer.Ordinal)
            .ToList();

        // Keep first N (most recent), delete the rest.
        for (int i = retainDaily; i < all.Count; i++)
        {
            try
            {
                Directory.Delete(all[i].Path, recursive: true);
                _log.LogInformation("Retention removed old backup {Id}", all[i].Name);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Could not remove old backup {Id}", all[i].Name);
            }
        }
    }

    // -----------------------------------------------------------------
    // Status
    // -----------------------------------------------------------------

    public BackupRunStatus GetStatus()
    {
        var list = List();
        return new BackupRunStatus(
            Running: _runLock.CurrentCount == 0,
            LastRunAt: _lastRunAt,
            LastRunSuccess: _lastRunSuccess,
            LastRunError: _lastRunError,
            LastRunDurationMs: _lastRunDurationMs,
            CurrentTargetPath: _backup.CurrentValue.TargetPath,
            BackupCount: list.Count,
            TotalBytes: list.Sum(b => b.SizeBytes));
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    private static bool TryParseId(string name, out DateTimeOffset created)
    {
        // 2026-04-29T03-30-00Z → parseable as DateTimeOffset after
        // restoring the colons. We only do this for retention/listing,
        // so a parse failure means "not one of our backups, skip."
        if (name.Length < IdFormat.Length)
        {
            created = default;
            return false;
        }
        // Replace the dashes between H, M, S back to colons.
        // Safer to do positional: characters 13 and 16 (the two
        // separators between time components).
        if (name.Length < 20 || name[10] != 'T' || !name.EndsWith("Z"))
        {
            created = default;
            return false;
        }
        var spliced = name.Substring(0, 13) + ":" + name.Substring(14, 2) + ":" + name.Substring(17);
        return DateTimeOffset.TryParse(
            spliced, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out created);
    }

    private static long ComputeSize(string dir)
    {
        long total = 0;
        try
        {
            foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
            {
                try { total += new FileInfo(f).Length; }
                catch { /* file disappeared, ignored */ }
            }
        }
        catch { /* directory disappeared, ignored */ }
        return total;
    }

    /// <summary>
    /// Walk a backup folder and return the relative paths of any
    /// vault folders inside (folders containing a markdown file or
    /// a <c>.notesapp/</c> subfolder). Used by the restore UI to
    /// populate the "which vault" dropdown.
    /// </summary>
    private static IReadOnlyList<string> ListVaultFolders(string backupRoot)
    {
        var found = new List<string>();
        // Vaults live at users/{username}/{vaultname}/ and
        // shared/{vaultname}/. We probe both subtrees.
        foreach (var top in new[] { "users", "shared" })
        {
            var topPath = Path.Combine(backupRoot, top);
            if (!Directory.Exists(topPath)) continue;

            foreach (var sub in Directory.EnumerateDirectories(topPath, "*", SearchOption.AllDirectories))
            {
                var notesApp = Path.Combine(sub, ".notesapp");
                if (Directory.Exists(notesApp))
                {
                    var rel = Path.GetRelativePath(backupRoot, sub).Replace('\\', '/');
                    found.Add(rel);
                }
            }
        }
        found.Sort(StringComparer.Ordinal);
        return found;
    }
}
