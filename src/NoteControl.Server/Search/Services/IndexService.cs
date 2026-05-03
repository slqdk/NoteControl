using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Data;
using NoteControl.Server.Vaults.Services;
using NoteControl.Shared.Search;

namespace NoteControl.Server.Search.Services;

/// <summary>
/// Default <see cref="IIndexService"/> implementation backed by per-vault
/// SQLite + FTS5 (see <see cref="IndexConnectionPool"/>).
/// <para>
/// All operations resolve <c>vaultId → vault row → absolute root</c>
/// before delegating to the pool. The pool itself is a singleton;
/// the resolution lives here in scoped land where <see cref="ServerDbContext"/>
/// is available.
/// </para>
/// </summary>
public sealed class IndexService : IIndexService
{
    // Keep snippet excerpts short; FTS5's snippet() takes start/end markers
    // and a token budget. The double-asterisks match the spec's choice for
    // markdown-friendly highlighting.
    private const string SnippetStartMark = "**";
    private const string SnippetEndMark = "**";
    private const int SnippetTokenBudget = 32;
    private const int DefaultSearchLimit = 50;
    private const int MaxSearchLimit = 200;

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;
    private readonly IIndexConnectionPool _pool;
    private readonly IIndexBuildState _buildState;

    public IndexService(
        ServerDbContext db,
        IVaultPathResolver vaultPaths,
        IIndexConnectionPool pool,
        IIndexBuildState buildState)
    {
        _db = db;
        _vaultPaths = vaultPaths;
        _pool = pool;
        _buildState = buildState;
    }

    // ----------------------------------------------------------------- Upsert

    public async Task UpsertAsync(Guid vaultId, IndexedNote note, CancellationToken ct = default)
    {
        var root = await ResolveVaultRootAsync(vaultId, ct).ConfigureAwait(false);
        await using var lease = await _pool.EnterAsync(vaultId, root, ct).ConfigureAwait(false);
        await using var tx = (SqliteTransaction)await lease.Connection.BeginTransactionAsync(ct).ConfigureAwait(false);

        await UpsertWithinTransactionAsync(lease.Connection, tx, note, ct).ConfigureAwait(false);

        await tx.CommitAsync(ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Insert/replace a single note row + its tags. Caller owns the
    /// transaction so this can be batched (rebuild path).
    /// </summary>
    private static async Task UpsertWithinTransactionAsync(
        SqliteConnection conn,
        SqliteTransaction tx,
        IndexedNote note,
        CancellationToken ct)
    {
        // INSERT...ON CONFLICT(path) DO UPDATE keeps the FTS triggers happy:
        // an UPDATE through this path fires the notes_au trigger, which
        // delete-then-inserts the FTS row.
        await using (var cmd = conn.CreateCommand())
        {
            cmd.Transaction = tx;
            cmd.CommandText = """
                INSERT INTO notes (path, title, created, updated, body_text, frontmatter)
                VALUES ($path, $title, $created, $updated, $body, $fm)
                ON CONFLICT(path) DO UPDATE SET
                    title       = excluded.title,
                    created     = excluded.created,
                    updated     = excluded.updated,
                    body_text   = excluded.body_text,
                    frontmatter = excluded.frontmatter;
                """;
            cmd.Parameters.AddWithValue("$path", note.Path);
            cmd.Parameters.AddWithValue("$title", note.Title);
            cmd.Parameters.AddWithValue("$created", (object?)note.Created?.ToString("O") ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$updated", note.Updated.ToString("O"));
            cmd.Parameters.AddWithValue("$body", note.BodyText);
            cmd.Parameters.AddWithValue("$fm", (object?)note.FrontmatterJson ?? DBNull.Value);
            await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }

        // Tags: simplest correct strategy is delete-all-then-insert. Tag
        // counts per note are tiny so the cost is negligible.
        await using (var del = conn.CreateCommand())
        {
            del.Transaction = tx;
            del.CommandText = "DELETE FROM tags WHERE note_path = $p;";
            del.Parameters.AddWithValue("$p", note.Path);
            await del.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }

        if (note.Tags.Count > 0)
        {
            await using var ins = conn.CreateCommand();
            ins.Transaction = tx;
            ins.CommandText = "INSERT OR IGNORE INTO tags (note_path, tag) VALUES ($p, $t);";
            var pParam = ins.Parameters.Add("$p", SqliteType.Text);
            var tParam = ins.Parameters.Add("$t", SqliteType.Text);
            foreach (var tag in note.Tags)
            {
                pParam.Value = note.Path;
                tParam.Value = tag;
                await ins.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            }
        }
    }

    // ----------------------------------------------------------------- Delete

    public async Task DeleteAsync(Guid vaultId, string notePath, CancellationToken ct = default)
    {
        var root = await ResolveVaultRootAsync(vaultId, ct).ConfigureAwait(false);
        await using var lease = await _pool.EnterAsync(vaultId, root, ct).ConfigureAwait(false);

        // FK on tags.note_path is ON DELETE CASCADE so a single delete
        // takes care of both tables. The notes_ad trigger removes from FTS.
        await using var cmd = lease.Connection.CreateCommand();
        cmd.CommandText = "DELETE FROM notes WHERE path = $p;";
        cmd.Parameters.AddWithValue("$p", notePath);
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    // ----------------------------------------------------------------- Search

    public async Task<SearchResponseDto> SearchAsync(
        Guid vaultId,
        string? query,
        string? tag,
        string folderPath,
        int limit,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(query) && string.IsNullOrWhiteSpace(tag))
        {
            throw new IndexException("Either 'q' or 'tag' must be provided.");
        }

        var clampedLimit = limit <= 0 ? DefaultSearchLimit : Math.Min(limit, MaxSearchLimit);

        var root = await ResolveVaultRootAsync(vaultId, ct).ConfigureAwait(false);
        await using var lease = await _pool.EnterAsync(vaultId, root, ct).ConfigureAwait(false);

        // Folder-prefix filter. Empty folderPath means whole vault.
        var prefix = string.IsNullOrEmpty(folderPath) ? "" : folderPath + "/";

        var results = !string.IsNullOrWhiteSpace(query)
            ? await SearchByQueryAsync(lease.Connection, query, tag, prefix, clampedLimit, ct).ConfigureAwait(false)
            : await SearchByTagAsync(lease.Connection, tag!, prefix, clampedLimit, ct).ConfigureAwait(false);

        return new SearchResponseDto(results, _buildState.IsBuilding(vaultId));
    }

    private static async Task<List<SearchResultDto>> SearchByQueryAsync(
        SqliteConnection conn,
        string rawQuery,
        string? tag,
        string prefix,
        int limit,
        CancellationToken ct)
    {
        // Build an FTS5 MATCH expression that ANDs the user's terms together.
        // We don't expose the raw FTS5 syntax (NEAR, column filters, etc.) —
        // user terms are quoted to make every term a phrase, which keeps
        // characters like '-' and ':' from being interpreted as operators.
        var match = BuildMatchExpression(rawQuery);
        if (match.Length == 0)
        {
            return new List<SearchResultDto>();
        }

        // The query joins:
        //   notes_fts (matched + ranked) → notes (for path / title / updated)
        //   → optionally tags (for the tag filter)
        // snippet() returns up to SnippetTokenBudget tokens around the
        // best match, with the configured highlighting markers.
        var sql = """
            SELECT
                n.path,
                n.title,
                snippet(notes_fts, 2, $startMark, $endMark, '…', $budget) AS snip,
                n.updated
            FROM notes_fts
            JOIN notes n ON n.rowid = notes_fts.rowid
        """;

        if (!string.IsNullOrEmpty(tag))
        {
            sql += "\nJOIN tags t ON t.note_path = n.path AND t.tag = $tag";
        }

        sql += "\nWHERE notes_fts MATCH $match";

        if (prefix.Length > 0)
        {
            sql += "\n  AND n.path LIKE $prefix || '%'";
        }

        sql += "\nORDER BY rank\nLIMIT $limit;";

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.AddWithValue("$match", match);
        cmd.Parameters.AddWithValue("$startMark", SnippetStartMark);
        cmd.Parameters.AddWithValue("$endMark", SnippetEndMark);
        cmd.Parameters.AddWithValue("$budget", SnippetTokenBudget);
        cmd.Parameters.AddWithValue("$limit", limit);
        if (!string.IsNullOrEmpty(tag))
        {
            cmd.Parameters.AddWithValue("$tag", tag);
        }
        if (prefix.Length > 0)
        {
            cmd.Parameters.AddWithValue("$prefix", prefix);
        }

        return await ReadResultsAsync(cmd, ct).ConfigureAwait(false);
    }

    private static async Task<List<SearchResultDto>> SearchByTagAsync(
        SqliteConnection conn,
        string tag,
        string prefix,
        int limit,
        CancellationToken ct)
    {
        // Tag-only search: no FTS, no snippet. Newest first.
        var sql = """
            SELECT n.path, n.title, '' AS snip, n.updated
            FROM tags t
            JOIN notes n ON n.path = t.note_path
            WHERE t.tag = $tag
        """;

        if (prefix.Length > 0)
        {
            sql += "\n  AND n.path LIKE $prefix || '%'";
        }

        sql += "\nORDER BY n.updated DESC\nLIMIT $limit;";

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.AddWithValue("$tag", tag);
        cmd.Parameters.AddWithValue("$limit", limit);
        if (prefix.Length > 0)
        {
            cmd.Parameters.AddWithValue("$prefix", prefix);
        }

        return await ReadResultsAsync(cmd, ct).ConfigureAwait(false);
    }

    private static async Task<List<SearchResultDto>> ReadResultsAsync(SqliteCommand cmd, CancellationToken ct)
    {
        var results = new List<SearchResultDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await reader.ReadAsync(ct).ConfigureAwait(false))
        {
            var path = reader.GetString(0);
            var title = reader.GetString(1);
            var snippet = reader.IsDBNull(2) ? "" : reader.GetString(2);
            var updatedStr = reader.GetString(3);

            DateTimeOffset.TryParse(updatedStr, out var updated);
            results.Add(new SearchResultDto(path, title, snippet, updated));
        }
        return results;
    }

    /// <summary>
    /// Convert a user-entered query into a safe FTS5 MATCH expression.
    /// Each whitespace-separated term is quoted (so it's treated as a
    /// phrase literal, not parsed for operators) and ANDed together.
    /// Returns an empty string if no usable terms remain.
    /// </summary>
    private static string BuildMatchExpression(string rawQuery)
    {
        var terms = rawQuery
            .Split(new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);

        var parts = new List<string>(terms.Length);
        foreach (var term in terms)
        {
            // A double-quoted FTS5 term escapes embedded quotes by doubling.
            var escaped = term.Replace("\"", "\"\"");
            parts.Add($"\"{escaped}\"");
        }
        return string.Join(" AND ", parts);
    }

    // ----------------------------------------------------------------- Rebuild

    public async Task<int> RebuildAsync(Guid vaultId, CancellationToken ct = default)
    {
        var root = await ResolveVaultRootAsync(vaultId, ct).ConfigureAwait(false);

        _buildState.MarkBuilding(vaultId);
        try
        {
            await using var lease = await _pool.EnterAsync(vaultId, root, ct).ConfigureAwait(false);
            await using var tx = (SqliteTransaction)await lease.Connection.BeginTransactionAsync(ct).ConfigureAwait(false);

            // Truncate. Triggers cascade into FTS automatically.
            await using (var clear = lease.Connection.CreateCommand())
            {
                clear.Transaction = tx;
                clear.CommandText = "DELETE FROM notes;";
                await clear.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            }

            int count = 0;
            foreach (var note in EnumerateVaultNotes(root, ct))
            {
                await UpsertWithinTransactionAsync(lease.Connection, tx, note, ct).ConfigureAwait(false);
                count++;
            }

            await tx.CommitAsync(ct).ConfigureAwait(false);
            _buildState.MarkBuilt(vaultId, count);
            return count;
        }
        catch (Exception ex)
        {
            _buildState.MarkError(vaultId, ex.Message);
            throw;
        }
    }

    /// <summary>
    /// Walk the vault root, yielding one <see cref="IndexedNote"/> per
    /// <c>.md</c> file outside <c>.notesapp/</c>. Errors on individual
    /// files are logged and skipped — one bad file shouldn't fail the
    /// whole rebuild.
    /// </summary>
    private static IEnumerable<IndexedNote> EnumerateVaultNotes(string vaultRoot, CancellationToken ct)
    {
        if (!Directory.Exists(vaultRoot))
        {
            yield break;
        }

        var enumOpts = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
        };

        foreach (var fullPath in Directory.EnumerateFiles(vaultRoot, "*.md", enumOpts))
        {
            ct.ThrowIfCancellationRequested();

            var relative = Path.GetRelativePath(vaultRoot, fullPath).Replace('\\', '/');

            // Skip the index folder itself and anything under it (trash etc.).
            if (relative.StartsWith(".notesapp/", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            IndexedNote? indexed = null;
            try
            {
                indexed = NoteFileReader.Read(fullPath, relative);
            }
            catch
            {
                // Swallow — one corrupt file shouldn't poison the whole build.
                // A future iteration can surface these to the audit log.
            }
            if (indexed is not null)
            {
                yield return indexed;
            }
        }
    }

    // ----------------------------------------------------------------- Status

    public async Task<IndexStatusDto> GetStatusAsync(Guid vaultId, CancellationToken ct = default)
    {
        var root = await ResolveVaultRootAsync(vaultId, ct).ConfigureAwait(false);
        await using var lease = await _pool.EnterAsync(vaultId, root, ct).ConfigureAwait(false);

        await using var cmd = lease.Connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM notes;";
        var count = Convert.ToInt32(await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false));

        return _buildState.Snapshot(vaultId, count);
    }

    // ----------------------------------------------------------------- ListNotes

    public async Task<IReadOnlyList<IndexedNote>> ListNotesAsync(
        Guid vaultId,
        string folderPath,
        int limit,
        CancellationToken ct = default)
    {
        var clampedLimit = limit <= 0 ? 100 : Math.Min(limit, MaxSearchLimit);

        var root = await ResolveVaultRootAsync(vaultId, ct).ConfigureAwait(false);
        await using var lease = await _pool.EnterAsync(vaultId, root, ct).ConfigureAwait(false);

        var prefix = string.IsNullOrEmpty(folderPath) ? "" : folderPath + "/";

        // Read just the columns the recursive folder view consumes
        // (path / title / updated). Body text, frontmatter JSON, and
        // tags are returned as empty values — we deliberately don't
        // pay the cost of joining and reading them since the only
        // current caller doesn't use them. If a future caller needs
        // the full IndexedNote, add the joins here.
        var sql = "SELECT path, title, created, updated FROM notes";
        if (prefix.Length > 0)
        {
            sql += " WHERE path LIKE $prefix || '%'";
        }
        sql += " ORDER BY updated DESC LIMIT $limit;";

        await using var cmd = lease.Connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.AddWithValue("$limit", clampedLimit);
        if (prefix.Length > 0)
        {
            cmd.Parameters.AddWithValue("$prefix", prefix);
        }

        var results = new List<IndexedNote>();
        await using var reader = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await reader.ReadAsync(ct).ConfigureAwait(false))
        {
            var path = reader.GetString(0);
            var title = reader.GetString(1);
            DateTimeOffset? created = null;
            if (!reader.IsDBNull(2))
            {
                if (DateTimeOffset.TryParse(reader.GetString(2), out var c)) created = c;
            }
            DateTimeOffset.TryParse(reader.GetString(3), out var updated);

            results.Add(new IndexedNote(
                Path: path,
                Title: title,
                Created: created,
                Updated: updated,
                BodyText: string.Empty,        // not loaded; see comment above
                FrontmatterJson: null,         // not loaded
                Tags: Array.Empty<string>())); // not loaded
        }
        return results;
    }

    // ----------------------------------------------------------------- helpers

    private async Task<string> ResolveVaultRootAsync(Guid vaultId, CancellationToken ct)
    {
        var vault = await _db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Path })
            .FirstOrDefaultAsync(ct)
            .ConfigureAwait(false)
            ?? throw new IndexException("Vault not found.", statusCode: 404);

        return _vaultPaths.Resolve(vault.Path);
    }
}
