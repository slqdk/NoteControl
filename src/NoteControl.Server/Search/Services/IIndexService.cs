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
