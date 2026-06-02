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
/// Versioning (replaces Ship 68's free-text version): a note's version
/// is two non-negative integers, <see cref="VersionMajor"/> and
/// <see cref="VersionMinor"/>, persisted on disk as a bare "major.minor"
/// string (e.g. `version: 1.2`). Defaults to 0.0 when the frontmatter
/// has no `version` key. The version is monotonic — the server rejects
/// any save that lowers it.
///
/// <see cref="State"/> is the note's lifecycle state, one of:
/// <list type="bullet">
///   <item><c>"not-versioned"</c> — the only valid state at version 0.0.
///     Derived, never user-selectable. The tree renders the plain note
///     icon.</item>
///   <item><c>"development"</c> — any version &gt; 0.0 that isn't
///     Released. Tree icon gets a yellow dot.</item>
///   <item><c>"released"</c> — selectable only at version &ge; 1.0. Tree
///     icon gets a green tick.</item>
/// </list>
/// <see cref="Version"/> is a derived "major.minor" convenience string
/// for read-only display and the docx export header — the two integer
/// fields are the source of truth.
/// </summary>
public sealed record FrontmatterDto(
    DateTimeOffset? Created,
    DateTimeOffset? Updated,
    IReadOnlyList<string> Tags,
    bool Locked,
    string? Font,
    int? FontSize,
    int? Width,
    int VersionMajor,
    int VersionMinor,
    string State,
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
/// Versioning (replaces Ship 68's free-text version): VersionMajor /
/// VersionMinor / State drive the per-note version state machine. Same
/// null semantics as the other property fields — null = leave alone,
/// non-null = set. The server enforces the invariants and rejects bad
/// transitions with 400:
/// <list type="bullet">
///   <item>Version is monotonic: a (major, minor) pair lower than the
///     note's current version is rejected. Equal is allowed (used for a
///     pure state change).</item>
///   <item>At version 0.0 the state is always "not-versioned"; sending
///     "development" or "released" at 0.0 is rejected.</item>
///   <item>"released" requires version &ge; 1.0.</item>
/// </list>
/// State is a free string on the wire (one of "not-versioned",
/// "development", "released") to avoid enum-serialisation coupling;
/// unknown values are rejected.
/// </summary>
public sealed record UpdateNoteRequest(
    string? Body = null,
    IReadOnlyList<string>? Tags = null,
    bool? Locked = null,
    string? Etag = null,
    string? Font = null,
    int? FontSize = null,
    int? Width = null,
    int? VersionMajor = null,
    int? VersionMinor = null,
    string? State = null);

/// <summary>
/// One row in a folder listing.
/// </summary>
public sealed record NoteSummaryDto(
    string Path,
    string Name,                      // filename without .md
    DateTimeOffset LastModified,
    long SizeBytes,
    // Versioning surface for the tree's per-note state badge. Defaulted so
    // callers that don't cheaply have these (e.g. the index-backed
    // recursive listing) can omit them — they then read as an unversioned
    // note (no badge), which is the safe default.
    int VersionMajor = 0,
    int VersionMinor = 0,
    string State = "not-versioned");

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
/// GET /api/vaults/{id}/note/history?path= — legacy snapshot-ring summary,
/// retained as a deprecated stub to soften the transition window between
/// Ship A (server) and Ship B (frontend). The server-side snapshot ring
/// was removed in favour of per-version release archives, so this
/// endpoint now always returns <c>Count = 0, Latest = null</c> — the
/// effect is that the legacy "Revert to last save" button disables
/// itself until the frontend stops calling /note/history altogether.
/// New code uses the archived releases endpoints instead.
/// </summary>
public sealed record NoteHistoryInfoDto(
    int Count,
    DateTimeOffset? Latest);

/// <summary>
/// GET /api/vaults/{id}/note/release?path= — legacy single-frozen-release
/// shape, retained as a deprecated stub to soften the transition window
/// between Ship A (server) and Ship B (frontend). New code uses
/// <see cref="ReleasedVersionsDto"/> via /note/releases.
///
/// In the new archived-releases model a note can carry many frozen
/// snapshots (one per past Released entry). The server now always
/// returns <c>Exists = false</c> here so the legacy recall affordance
/// hides itself; the frontend should migrate off this endpoint.
/// </summary>
public sealed record ReleaseInfoDto(
    bool Exists,
    int VersionMajor,
    int VersionMinor,
    DateTimeOffset? SavedAt,
    bool DevelopmentStashed);

/// <summary>
/// One archived released version of a note. The note's per-vault
/// release folder (<c>.notesapp/releases/&lt;encoded&gt;/</c>) holds one
/// frozen <c>v{major}.{minor}.md</c> file per past Released entry, and
/// each turns into one of these rows.
///
/// Snapshots are taken at the moment a note enters Released state and
/// are immutable thereafter — they record the content that was released
/// at that version. A subsequent unlock (Released → Under development,
/// always paired with a +1 minor bump) doesn't touch the previous
/// archive entries.
/// </summary>
public sealed record ReleasedVersionSummaryDto(
    int VersionMajor,
    int VersionMinor,
    DateTimeOffset SavedAt);

/// <summary>
/// GET /api/vaults/{id}/note/releases?path= — full list of archived
/// released versions for one note, newest first. Drives the Properties
/// panel's "Previous releases" list, which replaces the old "Revert to
/// last save" snapshot ring.
/// </summary>
public sealed record ReleasedVersionsDto(
    IReadOnlyList<ReleasedVersionSummaryDto> Archived);

/// <summary>
/// GET /api/vaults/{id}/note/releases/content?path=&amp;versionMajor=&amp;versionMinor=
/// — return the full content of one archived release for the
/// read-only viewer. Same shape as a live <see cref="NoteDto"/>; the
/// caller is expected to render it in a clearly-labelled read-only mode
/// and not attempt to save edits back through the normal PUT path.
///
/// The frontmatter in the response reflects the archived snapshot's own
/// frontmatter at the time of release — including its own version /
/// state — not the live note's current values.
/// </summary>
public sealed record ArchivedReleaseDto(
    string Path,
    int VersionMajor,
    int VersionMinor,
    string Body,
    FrontmatterDto Frontmatter,
    DateTimeOffset SavedAt);
