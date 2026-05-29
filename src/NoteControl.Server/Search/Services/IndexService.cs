using System.Text;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Data;
using NoteControl.Server.Notes.Frontmatter;
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
    // Snippet emphasis markers. We must NOT use markdown-friendly
    // characters here ("**", "__", "*", "_") because note bodies
    // frequently contain those as actual markdown — and FTS5's
    // snippet() function returns the raw text inside the matched
    // passage, so any literal markdown markers in that passage come
    // through unchanged and the client cannot tell "FTS5 wrapped
    // this match" from "the source markdown said this was bold".
    //
    // C0 control characters (\u0001 STX, \u0002 SOT) cannot appear
    // in user-typed markdown notes — they would have to be inserted
    // by a script or via copy-paste from a binary file — so they
    // are an unambiguous signal that "FTS5 put this here, not the
    // user". The frontend's snippet-to-HTML converter looks for
    // these specific characters to insert <strong> tags.
    private const string SnippetStartMark = "\u0001";
    private const string SnippetEndMark = "\u0002";
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

        List<SearchResultDto> results;
        bool looseMatch = false;
        if (!string.IsNullOrWhiteSpace(query))
        {
            // Two-pass strategy for free-text queries:
            //   1. Strict AND across all whitespace-separated terms
            //      (preserves the prior behaviour — phrase-like matching
            //      where every term must appear).
            //   2. If pass 1 returned zero hits AND the query has 2+
            //      terms, retry with OR so any single term still
            //      surfaces something. Single-term queries skip pass 2
            //      because OR-of-one is the same query.
            //
            // This makes "ax5000 dr" find notes that contain either
            // "ax5000" or "dr" when no note contains both, matching the
            // user expectation of "treat word 2 as a new criterion if
            // the strict query finds nothing".
            //
            // We signal which pass produced the hits by setting
            // LooseMatch=true on the response when pass 2 ran. The
            // client uses that flag to decide whether to post-filter
            // results by coverage of the original query terms (it can
            // safely tighten the OR set; tightening AND results would
            // be wrong because the snippet window may not contain
            // every term that matched in the full body).
            results = await SearchByQueryAsync(
                lease.Connection, query, tag, prefix, clampedLimit, useOr: false, ct).ConfigureAwait(false);

            if (results.Count == 0 && HasMultipleTerms(query))
            {
                results = await SearchByQueryAsync(
                    lease.Connection, query, tag, prefix, clampedLimit, useOr: true, ct).ConfigureAwait(false);
                looseMatch = results.Count > 0;
            }
        }
        else
        {
            results = await SearchByTagAsync(lease.Connection, tag!, prefix, clampedLimit, ct).ConfigureAwait(false);
        }

        return new SearchResponseDto(results, _buildState.IsBuilding(vaultId), looseMatch);
    }

    /// <summary>
    /// True when the raw query has at least two whitespace-separated
    /// terms — the threshold at which the OR fallback kicks in.
    /// Single-term queries skip the retry because OR-of-one matches
    /// the same set as AND-of-one.
    /// </summary>
    private static bool HasMultipleTerms(string rawQuery)
    {
        var sep = new[] { ' ', '\t', '\r', '\n' };
        return rawQuery.Split(sep, StringSplitOptions.RemoveEmptyEntries).Length >= 2;
    }

    private static async Task<List<SearchResultDto>> SearchByQueryAsync(
        SqliteConnection conn,
        string rawQuery,
        string? tag,
        string prefix,
        int limit,
        bool useOr,
        CancellationToken ct)
    {
        // Build an FTS5 MATCH expression from the user's terms. With
        // useOr=false the terms are ANDed (strict match); useOr=true
        // ORs them (any single term hits). We don't expose the raw
        // FTS5 syntax (NEAR, column filters, etc.) — user terms are
        // quoted to make every term a phrase, which keeps characters
        // like '-' and ':' from being interpreted as operators.
        var match = BuildMatchExpression(rawQuery, useOr);
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
    /// phrase literal, not parsed for operators) and joined with AND
    /// or OR depending on <paramref name="useOr"/>. Returns an empty
    /// string if no usable terms remain.
    /// </summary>
    private static string BuildMatchExpression(string rawQuery, bool useOr)
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
        return string.Join(useOr ? " OR " : " AND ", parts);
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

    // ----------------------------------------------------------------- ListNotesWithVersion

    /// <summary>
    /// Same shape as <see cref="ListNotesAsync"/> but each row carries
    /// the note's version/state pulled from on-disk frontmatter. Used by
    /// the FolderPage recursive listing to group rows by lifecycle state
    /// (released → development → not-versioned).
    /// <para>
    /// Strategy: do the cheap index SELECT for path/title/updated first,
    /// then sniff frontmatter for each result file (8KB prefix read).
    /// On lightserver SSD with the default limit of 100 this is ~800KB of
    /// I/O — well under the noise floor for a folder-page paint. Failures
    /// on individual files fall through as "not-versioned" so the listing
    /// is robust to a mid-write file or a corrupt frontmatter block.
    /// </para>
    /// </summary>
    public async Task<IReadOnlyList<NoteListingEntry>> ListNotesWithVersionAsync(
        Guid vaultId,
        string folderPath,
        int limit,
        CancellationToken ct = default)
    {
        // Resolve the vault root once. The SQL side and the per-row
        // sniff both need it; doing it twice (via two ListNotesAsync-
        // style helpers) would mean two DB roundtrips. We inline the
        // query against the connection pool below instead.
        var root = await ResolveVaultRootAsync(vaultId, ct).ConfigureAwait(false);
        var clampedLimit = limit <= 0 ? 100 : Math.Min(limit, MaxSearchLimit);

        // SQL side: same SELECT as ListNotesAsync. We deliberately
        // don't share the implementation via composition here — that
        // would either force a second vault-root resolution or require
        // a new private helper that takes a pre-resolved root, and the
        // duplication is small enough (one short SQL string) that
        // splitting it isn't worth the indirection.
        //
        // We explicitly DISPOSE the lease before the per-file sniff
        // loop below — holding it across N file reads (cold cache:
        // tens of ms each) would serialise concurrent index writes
        // for the whole vault for the duration of the listing, which
        // is unacceptable when the user is also saving notes.
        var bareRows = new List<(string Path, string Title, DateTimeOffset Updated)>();
        var prefix = string.IsNullOrEmpty(folderPath) ? "" : folderPath + "/";
        await using (var lease = await _pool.EnterAsync(vaultId, root, ct).ConfigureAwait(false))
        {
            var sql = "SELECT path, title, updated FROM notes";
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

            await using var reader = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                var p = reader.GetString(0);
                var t = reader.GetString(1);
                DateTimeOffset.TryParse(reader.GetString(2), out var u);
                bareRows.Add((p, t, u));
            }
        }
        // lease released here — sniff loop below runs lease-free.
        var enriched = new List<NoteListingEntry>(bareRows.Count);
        foreach (var row in bareRows)
        {
            ct.ThrowIfCancellationRequested();

            var (vMaj, vMin, state) = await SniffFrontmatterVersionStateAsync(
                root, row.Path, ct).ConfigureAwait(false);

            enriched.Add(new NoteListingEntry(
                Path: row.Path,
                Title: row.Title,
                Updated: row.Updated,
                VersionMajor: vMaj,
                VersionMinor: vMin,
                State: state));
        }

        return enriched;
    }

    /// <summary>
    /// Read just enough of a note file to extract its version/state from
    /// frontmatter. Caps the read at 8KB — frontmatter blocks larger than
    /// that are pathological and we'd rather miss the metadata than spend
    /// I/O reading megabyte notes.
    /// <para>
    /// Mirrors the logic in <c>NoteService.ReadVersionStateAsync</c> but
    /// lives here because the recursive endpoint goes through
    /// <see cref="IIndexService"/> rather than <see cref="NoteControl.Server.Notes.Services.NoteService"/>.
    /// If both paths grow more callers, promote this to a shared helper.
    /// </para>
    /// </summary>
    private static async Task<(int Major, int Minor, string State)> SniffFrontmatterVersionStateAsync(
        string vaultRoot,
        string relativePath,
        CancellationToken ct)
    {
        const int prefixCap = 8 * 1024;
        try
        {
            // ToOSPath: the wire path uses forward slashes (canonical
            // form); the filesystem may want backslashes on Windows.
            var absolutePath = Path.Combine(
                vaultRoot,
                relativePath.Replace('/', Path.DirectorySeparatorChar));

            // FileShare.ReadWrite so a concurrent save by the editor
            // doesn't fail our sniff with a sharing violation. The
            // worst case here is a torn read of a mid-write file —
            // we catch broadly below and fall back to not-versioned.
            string prefix;
            await using (var fs = new FileStream(
                absolutePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                var len = (int)Math.Min(fs.Length, prefixCap);
                if (len == 0)
                {
                    return (0, 0, FrontmatterCodec.StateNotVersioned);
                }
                var buf = new byte[len];
                var read = await fs.ReadAsync(buf.AsMemory(0, len), ct).ConfigureAwait(false);
                // Strip a leading BOM if an externally-edited file has one;
                // our own writes never do.
                prefix = Encoding.UTF8.GetString(buf, 0, read).TrimStart('\uFEFF');
            }
            var (fm, _) = FrontmatterCodec.Split(prefix);
            return (fm.VersionMajor, fm.VersionMinor, fm.State);
        }
        catch
        {
            // Unreadable / locked / mid-write / missing — treat as
            // unversioned. The listing must not fail because one note
            // couldn't be sniffed.
            return (0, 0, FrontmatterCodec.StateNotVersioned);
        }
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
