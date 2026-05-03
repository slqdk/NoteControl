namespace NoteControl.Shared.Notes;

/// <summary>
/// Parsed YAML frontmatter. The named fields are the ones the app
/// understands; everything else lives in <see cref="Extra"/>, key-by-key
/// (no nested objects are flattened — those keys' values are JSON-serialised
/// strings of the YAML subtree). On write, Extra round-trips verbatim.
///
/// Step 14: Font / FontSize / Width let each note override the editor's
/// look. Null = "use the default" (whatever the CSS picks). Width is in
/// pixels and is constrained client-side to ≥ 700 (the default page
/// width) — the server doesn't enforce a minimum, just round-trips
/// the value.
/// </summary>
public sealed record FrontmatterDto(
    DateTimeOffset? Created,
    DateTimeOffset? Updated,
    IReadOnlyList<string> Tags,
    bool Locked,
    string? Font,
    int? FontSize,
    int? Width,
    IReadOnlyDictionary<string, string> Extra);

/// <summary>
/// A single note's content plus parsed frontmatter and an ETag derived from
/// the on-disk content, for optimistic concurrency on writes.
/// </summary>
public sealed record NoteDto(
    string Path,
    string Body,
    FrontmatterDto Frontmatter,
    string Etag,
    DateTimeOffset LastModified);

/// <summary>
/// POST /api/vaults/{id}/note — create a new note. Body is plain markdown
/// without a frontmatter block; the server prepends a fresh frontmatter.
/// </summary>
public sealed record CreateNoteRequest(
    string Path,
    string Body,
    IReadOnlyList<string>? Tags = null);

/// <summary>
/// PUT /api/vaults/{id}/note — overwrite an existing note. Body is plain
/// markdown without frontmatter; the server merges with existing frontmatter
/// (bumping `updated`, replacing fields the request supplied non-null,
/// preserving Extra). If <see cref="Etag"/> is supplied and does not match
/// the current on-disk hash, the write is rejected with 412.
///
/// Step 14: Font / FontSize / Width are nullable for the same reason as
/// Tags/Locked — null means "leave alone", non-null replaces. To clear a
/// previously-set value, send an empty string for Font, or 0 for FontSize /
/// Width — the server treats those as "remove from frontmatter".
/// </summary>
public sealed record UpdateNoteRequest(
    string Body,
    IReadOnlyList<string>? Tags = null,
    bool? Locked = null,
    string? Etag = null,
    string? Font = null,
    int? FontSize = null,
    int? Width = null);

/// <summary>
/// One row in a folder listing.
/// </summary>
public sealed record NoteSummaryDto(
    string Path,
    string Name,                      // filename without .md
    DateTimeOffset LastModified,
    long SizeBytes);

/// <summary>
/// One subfolder of a folder listing.
/// </summary>
public sealed record FolderSummaryDto(
    string Path,
    string Name,
    int NoteCount);                   // direct children only, not recursive

/// <summary>
/// GET /api/vaults/{id}/folder — what's at this path.
/// Recently-updated lists notes from this folder *and all descendants*,
/// most recent first, capped at 10 (spec's "recent" rule).
/// </summary>
public sealed record FolderListingDto(
    string Path,                      // "" for vault root
    IReadOnlyList<FolderSummaryDto> Subfolders,
    IReadOnlyList<NoteSummaryDto> Notes,
    IReadOnlyList<NoteSummaryDto> RecentlyUpdated);
