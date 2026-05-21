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
///
/// Ship 68: Version is a free-text per-note string surfaced in the
/// Properties panel and rendered into the docx export header. Defaults
/// to "v0.0" if the on-disk frontmatter doesn't have it (the codec
/// fills the default on Split, so the wire DTO always has a value).
/// Free text by design — the user might use "v0.0", "1.2.3-rc1",
/// "draft", or even TwinCAT-style "PRJ-22.A" identifiers.
/// </summary>
public sealed record FrontmatterDto(
    DateTimeOffset? Created,
    DateTimeOffset? Updated,
    IReadOnlyList<string> Tags,
    bool Locked,
    string? Font,
    int? FontSize,
    int? Width,
    string Version,
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
/// PUT /api/vaults/{id}/note — overwrite an existing note. The server merges
/// with existing frontmatter (bumping `updated`, replacing fields the request
/// supplied non-null, preserving Extra). If <see cref="Etag"/> is supplied and
/// does not match the current on-disk hash, the write is rejected with 412.
///
/// Body semantics:
/// <list type="bullet">
///   <item><description><c>null</c> (the default) — "leave the body alone".
///     The server reads the existing body from disk, keeps it byte-for-byte,
///     and only rewrites the frontmatter. This is the path the Properties
///     panel uses when toggling Locked, editing Tags, changing the per-note
///     Version, or adjusting per-note appearance — none of those should
///     touch the body, and they MUST NOT overwrite it with a stale snapshot
///     the panel happens to be holding.</description></item>
///   <item><description>Non-null (including empty string) — "this is the
///     new body". The server replaces the body verbatim. This is the path
///     the editor itself uses on every save, paired with an <see cref="Etag"/>
///     to detect concurrent writes.</description></item>
/// </list>
///
/// The nullable Body was introduced after a real data-loss bug: the panel
/// sent a stale <c>body</c> alongside the field it actually wanted to
/// change, and the server unconditionally overwrote the on-disk body with
/// it. With Body nullable and defaulting to null, "I'm only updating a
/// property" becomes the literal shape of the request, and the server
/// enforces "no body field → don't touch the body" as the only safe path.
///
/// Step 14: Font / FontSize / Width are nullable for the same reason as
/// Tags/Locked — null means "leave alone", non-null replaces. To clear a
/// previously-set value, send an empty string for Font, or 0 for FontSize /
/// Width — the server treats those as "remove from frontmatter".
///
/// Ship 68: Version is the free-text per-note version string. Same null
/// semantics — null = leave alone, non-null = replace. Empty string is
/// treated as "reset to default v0.0" rather than "remove": the field is
/// always present on disk after a write (that's the backfill contract:
/// any save persists v0.0 to a previously-unversioned note).
/// </summary>
public sealed record UpdateNoteRequest(
    string? Body = null,
    IReadOnlyList<string>? Tags = null,
    bool? Locked = null,
    string? Etag = null,
    string? Font = null,
    int? FontSize = null,
    int? Width = null,
    string? Version = null);

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
///
/// <see cref="CoverUrl"/> is non-null when this folder has a cover image
/// uploaded via <c>POST /folder/cover</c>; it embeds a cache-busting
/// mtime so a re-upload produces a different URL. Null means the folder
/// has no cover and the frontend should render nothing.
/// </summary>
public sealed record FolderListingDto(
    string Path,                      // "" for vault root
    IReadOnlyList<FolderSummaryDto> Subfolders,
    IReadOnlyList<NoteSummaryDto> Notes,
    IReadOnlyList<NoteSummaryDto> RecentlyUpdated,
    string? CoverUrl = null);

/// <summary>
/// GET /api/vaults/{id}/note/history?path= — a summary of how much
/// undo-history is available for one note. Drives the Properties
/// panel's "Revert to last save" button (enable/disable + tooltip).
///
/// <see cref="Count"/> is the number of snapshots on disk for this
/// note, 0..10 (capped server-side). <see cref="Latest"/> is the
/// timestamp of the most-recently-written snapshot, or null when
/// there are none. The endpoint deliberately does NOT return the
/// full snapshot list — the UI only ever pops the most recent, so
/// any listing would be busy work.
/// </summary>
public sealed record NoteHistoryInfoDto(
    int Count,
    DateTimeOffset? Latest);
