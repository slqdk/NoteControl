using FluentAssertions;
using Microsoft.Data.Sqlite;
using NoteControl.Server.Search.Services;
using Xunit;

namespace NoteControl.Tests.Search;

/// <summary>
/// Focused unit tests on the SQLite/FTS5 layer, bypassing HTTP and DI.
/// We construct an <see cref="IndexConnectionPool"/> directly and drive
/// it with a vault id that maps to a temp folder, sidestepping the
/// vault registry lookup that the HTTP integration tests cover.
/// <para>
/// Each test uses its own temp folder to keep the SqliteConnections
/// isolated; the pool is disposed in the test fixture's IDisposable
/// implementation.
/// </para>
/// </summary>
public sealed class IndexServiceLowLevelTests : IDisposable
{
    private readonly string _root;
    private readonly IndexConnectionPool _pool = new();
    private readonly Guid _vaultId = Guid.NewGuid();

    public IndexServiceLowLevelTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "nc-index-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
    }

    public void Dispose()
    {
        // Drop the connection first so the WAL files release their handles,
        // then nuke the temp directory. Some Windows AVs hold the file open
        // briefly, so we tolerate the cleanup failing.
        _pool.DisposeAsync().AsTask().GetAwaiter().GetResult();
        try { Directory.Delete(_root, recursive: true); } catch { /* best-effort */ }
    }

    [Fact]
    public async Task Schema_is_created_on_first_open()
    {
        await using var lease = await _pool.EnterAsync(_vaultId, _root);

        // Spot-check: the notes_fts virtual table should exist.
        await using var cmd = lease.Connection.CreateCommand();
        cmd.CommandText = "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = 'notes_fts';";
        var name = await cmd.ExecuteScalarAsync();
        name.Should().Be("notes_fts");
    }

    [Fact]
    public async Task Upsert_then_query_returns_the_row()
    {
        // Insert a note via raw SQL and confirm the FTS triggers fire.
        await using (var lease = await _pool.EnterAsync(_vaultId, _root))
        {
            await using var insert = lease.Connection.CreateCommand();
            insert.CommandText = """
                INSERT INTO notes (path, title, updated, body_text)
                VALUES ('a.md', 'A', '2026-01-01T00:00:00Z', 'lorem ipsum dolor sit amet');
                """;
            await insert.ExecuteNonQueryAsync();
        }

        await using (var lease = await _pool.EnterAsync(_vaultId, _root))
        {
            await using var query = lease.Connection.CreateCommand();
            query.CommandText = "SELECT path FROM notes_fts WHERE notes_fts MATCH 'lorem';";
            var path = await query.ExecuteScalarAsync();
            path.Should().Be("a.md");
        }
    }

    [Fact]
    public async Task Update_trigger_replaces_FTS_content()
    {
        await using (var lease = await _pool.EnterAsync(_vaultId, _root))
        {
            await using var insert = lease.Connection.CreateCommand();
            insert.CommandText = """
                INSERT INTO notes (path, title, updated, body_text)
                VALUES ('a.md', 'A', '2026-01-01T00:00:00Z', 'first version with apple');
                """;
            await insert.ExecuteNonQueryAsync();

            await using var update = lease.Connection.CreateCommand();
            update.CommandText = """
                UPDATE notes SET body_text = 'second version with banana' WHERE path = 'a.md';
                """;
            await update.ExecuteNonQueryAsync();
        }

        await using (var lease = await _pool.EnterAsync(_vaultId, _root))
        {
            await using var oldHit = lease.Connection.CreateCommand();
            oldHit.CommandText = "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'apple';";
            (await oldHit.ExecuteScalarAsync()).Should().Be(0L);

            await using var newHit = lease.Connection.CreateCommand();
            newHit.CommandText = "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'banana';";
            (await newHit.ExecuteScalarAsync()).Should().Be(1L);
        }
    }

    [Fact]
    public async Task Delete_cascades_tags_and_FTS()
    {
        await using (var lease = await _pool.EnterAsync(_vaultId, _root))
        {
            await using var seed = lease.Connection.CreateCommand();
            seed.CommandText = """
                INSERT INTO notes (path, title, updated, body_text)
                VALUES ('a.md', 'A', '2026-01-01T00:00:00Z', 'doomed text');
                INSERT INTO tags (note_path, tag) VALUES ('a.md', 'todo');
                """;
            await seed.ExecuteNonQueryAsync();

            await using var del = lease.Connection.CreateCommand();
            del.CommandText = "DELETE FROM notes WHERE path = 'a.md';";
            await del.ExecuteNonQueryAsync();
        }

        await using (var lease = await _pool.EnterAsync(_vaultId, _root))
        {
            await using var tagCount = lease.Connection.CreateCommand();
            tagCount.CommandText = "SELECT COUNT(*) FROM tags WHERE note_path = 'a.md';";
            (await tagCount.ExecuteScalarAsync()).Should().Be(0L,
                because: "ON DELETE CASCADE on the FK should remove orphan tag rows");

            await using var ftsCount = lease.Connection.CreateCommand();
            ftsCount.CommandText = "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'doomed';";
            (await ftsCount.ExecuteScalarAsync()).Should().Be(0L);
        }
    }

    [Fact]
    public async Task User_version_is_stamped_on_create()
    {
        await using var lease = await _pool.EnterAsync(_vaultId, _root);
        await using var cmd = lease.Connection.CreateCommand();
        cmd.CommandText = "PRAGMA user_version;";
        var version = (long)(await cmd.ExecuteScalarAsync())!;
        version.Should().Be(IndexSchema.SchemaVersion);
    }
}
