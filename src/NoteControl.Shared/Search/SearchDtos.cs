namespace NoteControl.Shared.Search;

/// <summary>
/// One hit returned from a vault search.
/// <list type="bullet">
///   <item><c>Path</c> — canonical forward-slash path within the vault (e.g. <c>"Projects/launch.md"</c>).</item>
///   <item><c>Title</c> — the note's H1 / frontmatter title / filename, in that order.</item>
///   <item><c>Snippet</c> — best-matching excerpt with <c>**...**</c> around the matched terms.
///     Empty for hits matched only by tag.</item>
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
/// </summary>
public sealed record SearchResponseDto(
    IReadOnlyList<SearchResultDto> Results,
    bool Indexing);

/// <summary>
/// Lightweight status payload returned from <c>POST /api/vaults/{id}/index/rebuild</c>
/// and queryable via <c>GET /api/vaults/{id}/index/status</c>.
/// </summary>
public sealed record IndexStatusDto(
    string State,           // "idle" | "indexing" | "error"
    int IndexedNotes,       // count of rows in `notes` after the last completed pass
    DateTimeOffset? LastBuildAt,
    string? LastError);     // populated when State == "error"
