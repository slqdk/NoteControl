using NoteControl.Shared.Search;

namespace NoteControl.Server.Search.Services;

/// <summary>
/// Per-vault index operations. One <see cref="IndexService"/> instance
/// is scoped per request, but the underlying SQLite connections are
/// pooled per-vault (see <see cref="IndexConnectionPool"/>).
/// <para>
/// The index lives at <c>{vaultRoot}/.notesapp/index.db</c>. It is a
/// pure cache derived from the markdown files on disk and may be
/// deleted at any time; on the next call <see cref="EnsureOpenAsync"/>
/// recreates the schema and triggers a rebuild.
/// </para>
/// </summary>
public interface IIndexService
{
    /// <summary>
    /// Insert or replace the row for a single note. Called by
    /// <see cref="INoteIndexer"/> after a successful save.
    /// </summary>
    Task UpsertAsync(Guid vaultId, IndexedNote note, CancellationToken ct = default);

    /// <summary>Remove a note by path (idempotent — no-op if absent).</summary>
    Task DeleteAsync(Guid vaultId, string notePath, CancellationToken ct = default);

    /// <summary>
    /// Run a search. <paramref name="query"/> is the user's raw query
    /// (whitespace-separated terms). At least one of <paramref name="query"/>
    /// or <paramref name="tag"/> must be non-null/non-empty; the endpoint
    /// layer enforces that.
    /// </summary>
    /// <param name="folderPath">If non-empty, restrict to notes whose path
    ///   starts with <c>{folderPath}/</c>. Empty means whole vault.</param>
    Task<SearchResponseDto> SearchAsync(
        Guid vaultId,
        string? query,
        string? tag,
        string folderPath,
        int limit,
        CancellationToken ct = default);

    /// <summary>
    /// Drop and rebuild the index by walking the vault on disk. Returns
    /// the number of notes indexed. Safe to call concurrently with
    /// reads — readers see the old data until the rebuild commits.
    /// </summary>
    Task<int> RebuildAsync(Guid vaultId, CancellationToken ct = default);

    /// <summary>Quick status snapshot for the UI.</summary>
    Task<IndexStatusDto> GetStatusAsync(Guid vaultId, CancellationToken ct = default);

    /// <summary>
    /// List notes under a folder (recursive), most-recently-updated first.
    /// Used by the folder page's "all notes under this folder" recursive
    /// view — see <c>FolderRecursiveEndpoints</c>.
    /// <para>
    /// <paramref name="folderPath"/> is the canonical forward-slash
    /// folder path (empty string = whole vault). Limit is clamped to
    /// a sane range internally; pass 100 for the default.
    /// </para>
    /// </summary>
    Task<IReadOnlyList<IndexedNote>> ListNotesAsync(
        Guid vaultId,
        string folderPath,
        int limit,
        CancellationToken ct = default);

    /// <summary>
    /// Like <see cref="ListNotesAsync"/> but each returned entry also
    /// carries the note's version/state from its on-disk frontmatter.
    /// <para>
    /// Implementation reads the first ~8KB of each .md file to parse
    /// frontmatter — same per-note cost as the non-recursive
    /// <see cref="NoteControl.Server.Notes.Services.NoteService"/> folder
    /// listing already pays. Errors on individual files are swallowed and
    /// the row falls through as <see cref="FrontmatterCodec.StateNotVersioned"/>
    /// so a single corrupt note doesn't poison the listing.
    /// </para>
    /// <para>
    /// Why not store version/state in the index DB? The index is
    /// invalidated by a schema bump, and the current build doesn't
    /// auto-rebuild on bump — adding columns would require wiring that
    /// path first. The per-file read is fast enough on local disk
    /// (200 × 8KB ≈ 1.6 MB) that the simpler approach wins. Revisit if
    /// the recursive list grows past a few hundred entries.
    /// </para>
    /// </summary>
    Task<IReadOnlyList<NoteListingEntry>> ListNotesWithVersionAsync(
        Guid vaultId,
        string folderPath,
        int limit,
        CancellationToken ct = default);
}

/// <summary>
/// All the fields the indexer needs about a note — produced by
/// <see cref="INoteIndexer"/> from the parsed file contents.
/// </summary>
/// <param name="Path">Canonical forward-slash relative path inside the vault.</param>
/// <param name="Title">H1 / frontmatter title / filename, in that order.</param>
/// <param name="Created">From frontmatter; null if absent.</param>
/// <param name="Updated">File mtime.</param>
/// <param name="BodyText">Frontmatter-stripped body, used for FTS.</param>
/// <param name="FrontmatterJson">Raw frontmatter map serialised to JSON, for
///   future use (filters, etc.). Not currently searched.</param>
/// <param name="Tags">Tag list from frontmatter; may be empty.</param>
public sealed record IndexedNote(
    string Path,
    string Title,
    DateTimeOffset? Created,
    DateTimeOffset Updated,
    string BodyText,
    string? FrontmatterJson,
    IReadOnlyList<string> Tags);

/// <summary>
/// A folder-listing row enriched with version + lifecycle state. Returned
/// by <see cref="IIndexService.ListNotesWithVersionAsync"/>. Mirrors the
/// fields the FolderPage's "all notes under X" view actually consumes;
/// keep this lean so the per-file frontmatter sniff stays the dominant cost
/// rather than wire serialisation.
/// </summary>
/// <param name="Path">Canonical forward-slash relative path inside the vault.</param>
/// <param name="Title">Display title (from H1 / frontmatter / filename).</param>
/// <param name="Updated">Last-modified timestamp from the index (file mtime).</param>
/// <param name="VersionMajor">Major component of <c>version: M.m</c>. 0 if not versioned.</param>
/// <param name="VersionMinor">Minor component. 0 if not versioned.</param>
/// <param name="State">One of <c>not-versioned</c> / <c>development</c> / <c>released</c>.</param>
public sealed record NoteListingEntry(
    string Path,
    string Title,
    DateTimeOffset Updated,
    int VersionMajor,
    int VersionMinor,
    string State);

/// <summary>
/// Thrown for caller-fixable errors (bad query syntax, etc.). Mapped to
/// HTTP 400 by the endpoints layer.
/// </summary>
public sealed class IndexException : Exception
{
    public int StatusCode { get; }
    public IndexException(string message, int statusCode = 400) : base(message)
    {
        StatusCode = statusCode;
    }
}
