namespace NoteControl.Shared.Search;

/// <summary>
/// One hit returned from a vault search.
/// <list type="bullet">
///   <item><c>Path</c> — canonical forward-slash path within the vault (e.g. <c>"Projects/launch.md"</c>).</item>
///   <item><c>Title</c> — the note's H1 / frontmatter title / filename, in that order.</item>
///   <item><c>Snippet</c> — best-matching excerpt with U+0001 (start) / U+0002 (end)
///     control characters wrapping each matched term. C0 controls are used rather
///     than markdown markers (e.g. <c>**...**</c>) so the client can tell FTS5
///     emphasis apart from literal bold characters carried over from the source
///     markdown body. Empty for hits matched only by tag.</item>
///   <item><c>Updated</c> — last-modified timestamp from the file (ISO-8601 UTC).</item>
/// </list>
/// </summary>
public sealed record SearchResultDto(
    string Path,
    string Title,
    string Snippet,
    DateTimeOffset Updated);

/// <summary>
/// Wrapper response for <c>GET /api/vaults/{id}/search</c>.
/// <para>
/// <c>Indexing</c> is <c>true</c> if the index hasn't finished its initial
/// build yet; in that case <c>Results</c> may be incomplete and the client
/// should retry shortly. Once the build is finished it stays <c>false</c>
/// until the next manual rebuild.
/// </para>
/// <para>
/// <c>LooseMatch</c> is <c>true</c> when the strict AND query (every term must
/// appear in title or body) returned zero hits and the server fell back to an
/// OR query (any single term). The client uses this flag to decide whether
/// post-filtering by query-term coverage is safe — see SearchBox.tsx. Always
/// <c>false</c> for single-term queries (no fallback is possible) and for
/// queries that found at least one strict hit.
/// </para>
/// </summary>
public sealed record SearchResponseDto(
    IReadOnlyList<SearchResultDto> Results,
    bool Indexing,
    bool LooseMatch = false);

/// <summary>
/// Lightweight status payload returned from <c>POST /api/vaults/{id}/index/rebuild</c>
/// and queryable via <c>GET /api/vaults/{id}/index/status</c>.
/// </summary>
public sealed record IndexStatusDto(
    string State,           // "idle" | "indexing" | "error"
    int IndexedNotes,       // count of rows in `notes` after the last completed pass
    DateTimeOffset? LastBuildAt,
    string? LastError);     // populated when State == "error"
