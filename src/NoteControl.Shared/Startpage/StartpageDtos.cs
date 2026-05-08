namespace NoteControl.Shared.Startpage;

/// <summary>
/// Per-vault startpage configuration. Persisted as
/// <c>{vault}/.notesapp/startpage.json</c>. Loaded by the client
/// when navigating to any dashboard and saved (debounced ~500ms)
/// whenever the user changes any block on any dashboard.
///
/// Multi-dashboard layout (Ship: dashboards): each vault carries
/// an ordered list of named dashboards. Each dashboard owns its
/// own free-floating canvas of blocks. The legacy single-canvas
/// shape (top-level <c>blocks</c>/<c>taskAreas</c>/<c>links</c>)
/// is read-tolerated by the server's StartpageConfigService and
/// silently lifted into a single dashboard named "Dashboard" the
/// first time it loads — the next save writes the new
/// versioned shape and the legacy keys disappear.
///
/// Free-floating layout: each block carries its own absolute
/// position + size in pixels, relative to the top-left of the
/// dashboard's scrollable area. No grid. The frontend clamps
/// values to sane bounds before sending; the server stores them
/// verbatim.
/// </summary>
public sealed record StartpageConfigDto(
    /// <summary>
    /// Schema version. Current value is 2 (multi-dashboard).
    /// Version 1 was the implicit pre-dashboards single-canvas
    /// shape and lives only on disk in older files; the server
    /// upgrades v1 files to v2 in memory on read. Bump on any
    /// breaking change to the shape.
    /// </summary>
    int Version,
    /// <summary>
    /// Ordered list of dashboards in this vault. Always at least
    /// one — the server seeds a default "Dashboard" entry on first
    /// load, and the UI prevents deletion of the last remaining
    /// dashboard. Order is user-meaningful (it's the order rows
    /// appear in the tree); persisted in the array order, NOT
    /// sorted by id like blocks/areas/links inside a dashboard.
    /// </summary>
    IReadOnlyList<DashboardDto> Dashboards);

/// <summary>
/// One dashboard inside a vault. Owns a free-floating canvas of
/// blocks (RSS feeds, task areas, link blocks) — the same three
/// block types that used to live on the per-vault startpage.
/// Identity is the (random, client-generated) <see cref="Id"/>;
/// stable across renames and reorders.
///
/// Backward compatibility: <see cref="Blocks"/>, <see cref="TaskAreas"/>,
/// and <see cref="Links"/> all use the same DTO types as the legacy
/// flat shape, so a v1→v2 upgrade is a pure shape change — no field
/// rewriting inside individual blocks.
/// </summary>
public sealed record DashboardDto(
    /// <summary>
    /// Stable id, generated client-side via crypto.randomUUID()
    /// when the dashboard is created. Used as the URL segment
    /// (<c>/vaults/{vaultId}/dashboards/{dashboardId}</c>) and as
    /// the React key. Server treats it as opaque.
    /// </summary>
    string Id,

    /// <summary>
    /// User-given dashboard name. Shown as the row label in the
    /// tree. Default for the first dashboard is "Dashboard". The
    /// frontend rejects empty/whitespace-only renames; the server
    /// stores whatever it's given (so a hand-edited file with an
    /// empty name round-trips cleanly).
    /// </summary>
    string Name,

    /// <summary>
    /// All RSS blocks on this dashboard. Order is irrelevant
    /// (each block has an absolute position via x/y), but we keep
    /// the list sorted by Id for deterministic JSON output so
    /// file diffs are readable.
    /// </summary>
    IReadOnlyList<RssBlockDto> Blocks,
    /// <summary>
    /// All task areas on this dashboard. Free-floating containers,
    /// each holding its own ordered list of sticky notes. Same
    /// identity / sort-on-write semantics as Blocks.
    /// </summary>
    IReadOnlyList<TaskAreaDto> TaskAreas,
    /// <summary>
    /// All link blocks on this dashboard. Free-floating containers,
    /// each holding up to 10 link entries (title + description +
    /// URL). Same identity / sort-on-write semantics as Blocks
    /// and TaskAreas.
    /// </summary>
    IReadOnlyList<LinkBlockDto> Links,
    /// <summary>
    /// All Motion calculator blocks on this dashboard. Optional
    /// (nullable) so older v2 files written before this field
    /// existed still deserialise cleanly. The service normalises
    /// null to an empty list on read and on write.
    /// </summary>
    IReadOnlyList<MotionBlockDto>? MotionBlocks = null);

/// <summary>
/// One RSS block on a dashboard. Identity is the (random,
/// client-generated) <see cref="Id"/> string — stable across
/// reorders so the React keyed-render doesn't churn.
/// </summary>
public sealed record RssBlockDto(
    /// <summary>
    /// Stable id, generated client-side via crypto.randomUUID().
    /// Used as React key + as the cache key for fetched feed
    /// content. Server treats it as opaque.
    /// </summary>
    string Id,

    /// <summary>
    /// Display title above the feed items. Falls back to the
    /// feed's own &lt;title&gt; on the client when empty, but the
    /// server doesn't substitute — empty is a valid stored value.
    /// </summary>
    string Title,

    /// <summary>
    /// RSS or Atom feed URL. Empty when the block was just added
    /// and the user hasn't typed a URL yet.
    /// </summary>
    string FeedUrl,

    /// <summary>Position from the left edge of the dashboard area, in pixels.</summary>
    int X,
    /// <summary>Position from the top edge of the dashboard area, in pixels.</summary>
    int Y,
    /// <summary>Block width in pixels. Clamped client-side to [200, 1200].</summary>
    int Width,
    /// <summary>Block height in pixels. Clamped client-side to [150, 1200].</summary>
    int Height,

    /// <summary>
    /// Headline font size in pixels for each item. Default 14;
    /// clamped client-side to [10, 24].
    /// </summary>
    int HeadlineSize,

    /// <summary>
    /// Number of words from the item description to show as a
    /// preview snippet under the headline. 0 = no preview.
    /// Clamped client-side to [0, 200].
    /// </summary>
    int PreviewWords,

    /// <summary>
    /// Maximum items to render per block. Larger feeds get
    /// truncated client-side. Clamped to [1, 100]. The block
    /// content scrolls if it doesn't all fit visually.
    /// </summary>
    int MaxItems);

/// <summary>
/// Normalized feed payload returned by
/// <c>GET /api/vaults/{id}/startpage/feed?url=...</c>. The server
/// fetches + parses the source URL (RSS 2.0 or Atom 1.0), maps
/// into this shape, and serves from a short in-memory cache.
/// </summary>
public sealed record FeedDto(
    /// <summary>Feed-level title (channel/title for RSS, feed/title for Atom).</summary>
    string Title,
    /// <summary>Feed-level link to the source website (channel/link).</summary>
    string? Link,
    /// <summary>Items in the order the feed presented them (newest first by convention).</summary>
    IReadOnlyList<FeedItemDto> Items);

/// <summary>
/// One item from a feed, post-normalization. Atom and RSS map
/// here through different paths but the resulting shape is the
/// same so the client doesn't have to special-case formats.
/// </summary>
public sealed record FeedItemDto(
    /// <summary>Item title — required by both RSS and Atom; rare empties replaced with "(untitled)".</summary>
    string Title,
    /// <summary>Direct link to the article. Null when the feed didn't supply one.</summary>
    string? Link,
    /// <summary>
    /// Plain-text excerpt of the description/summary, with HTML
    /// stripped server-side so the client can safely render it.
    /// May be empty if the feed only carries titles.
    /// </summary>
    string Summary,
    /// <summary>
    /// Publish date if present in the feed item, otherwise null.
    /// Atom: updated/published; RSS: pubDate. Always UTC.
    /// </summary>
    DateTimeOffset? PublishedAt);

/// <summary>
/// One free-floating task area on a dashboard.
/// Acts as a container for an ordered list of sticky notes. The
/// notes stack vertically inside the area; the area itself moves
/// and resizes like an RSS block.
/// </summary>
public sealed record TaskAreaDto(
    /// <summary>Stable id, generated client-side via crypto.randomUUID().</summary>
    string Id,

    /// <summary>
    /// User-given title shown in the area header. May be empty;
    /// the client renders a placeholder ("(untitled)") when so.
    /// </summary>
    string Title,

    /// <summary>Position from the left edge of the dashboard area, in pixels.</summary>
    int X,
    /// <summary>Position from the top edge of the dashboard area, in pixels.</summary>
    int Y,
    /// <summary>Area width in pixels. Clamped client-side to [220, 800].</summary>
    int Width,
    /// <summary>Area height in pixels. Clamped client-side to [180, 1200].</summary>
    int Height,

    /// <summary>
    /// Notes inside this area, in display order (top to bottom).
    /// Reordered by drag in the UI. Persisted in this exact order.
    /// </summary>
    IReadOnlyList<StickyNoteDto> Notes);

/// <summary>
/// One sticky note inside a TaskArea. Has a headline (single
/// line, prominent), a body of free text, a colour from a fixed
/// palette, and a done flag that strikes through the text when
/// set.
/// </summary>
public sealed record StickyNoteDto(
    /// <summary>Stable id, generated client-side.</summary>
    string Id,

    /// <summary>Single-line title.</summary>
    string Headline,

    /// <summary>Multi-line free text body.</summary>
    string Content,

    /// <summary>
    /// Colour key from a fixed palette. The client validates
    /// against its palette and falls back to "yellow" on any
    /// unrecognised value. Stored as a key (not a hex code) so
    /// the visual palette can be retuned without rewriting
    /// every saved note.
    /// </summary>
    string Color,

    /// <summary>
    /// True when the user has marked the note done. The note
    /// stays in place; the client renders strikethrough +
    /// reduced opacity. Toggle-able from the note's checkbox.
    /// </summary>
    bool Done);

/// <summary>
/// One free-floating links block on a dashboard. Acts as a
/// labelled container for an ordered list of links — typically
/// grouped thematically (e.g. "News", "Automation", "Reference"),
/// with up to 10 entries each. Mirrors <see cref="TaskAreaDto"/>'s
/// shape: same drag/resize semantics, same id stability rules. The
/// only differences are the children type (LinkItemDto, not
/// StickyNoteDto) and the entry cap.
///
/// The 10-item cap is enforced client-side (the "+ Add link" button
/// hides at 10). The server doesn't enforce it — that would be a
/// hostile breaking change to a valid hand-edit. We round-trip
/// whatever's in the file.
/// </summary>
public sealed record LinkBlockDto(
    /// <summary>Stable id, generated client-side via crypto.randomUUID().</summary>
    string Id,

    /// <summary>
    /// User-given title shown in the block header (e.g. "News",
    /// "Automation"). May be empty; the client renders a
    /// placeholder when so.
    /// </summary>
    string Title,

    /// <summary>Position from the left edge of the dashboard area, in pixels.</summary>
    int X,
    /// <summary>Position from the top edge of the dashboard area, in pixels.</summary>
    int Y,
    /// <summary>Block width in pixels. Clamped client-side to [220, 800].</summary>
    int Width,
    /// <summary>Block height in pixels. Clamped client-side to [180, 1200].</summary>
    int Height,

    /// <summary>
    /// Links inside this block, in display order. Reordered by drag
    /// in the UI. Persisted in this exact order. Cap of 10 is
    /// enforced client-side only (see record summary).
    /// </summary>
    IReadOnlyList<LinkItemDto> Items);

/// <summary>
/// One link entry inside a LinkBlock. Two-line visual:
/// title (bold), description (smaller, muted) below it. Clicking
/// anywhere on the entry navigates to <see cref="Url"/> in a new
/// tab.
/// </summary>
public sealed record LinkItemDto(
    /// <summary>Stable id, generated client-side.</summary>
    string Id,

    /// <summary>
    /// Single-line link title (e.g. "DR Nyheder"). Falls back to
    /// the URL itself when empty, but the field is stored as the
    /// user typed — empty is a valid stored value.
    /// </summary>
    string Title,

    /// <summary>
    /// Optional one-liner description shown under the title (e.g.
    /// "Danish public-service news"). Empty is fine — the
    /// description row simply doesn't render in that case.
    /// </summary>
    string Description,

    /// <summary>
    /// The URL to open. The client validates loosely (must look
    /// like a URL with a scheme); server treats it as opaque text.
    /// Empty is allowed for newly-added entries before the user
    /// types a value.
    /// </summary>
    string Url);

/// <summary>
/// One Motion-profile calculator block on a dashboard. Renders a
/// jerk-limited S-curve solver UI (form on the left, velocity chart
/// + result cells on the right). The DTO carries the user's choice
/// of solver mode (A/B/C), the persisted input values, and the
/// chart-overlay toggle states.
///
/// Inputs are stored as a free-form Dictionary&lt;string, double&gt;
/// rather than a strongly-typed-per-mode shape. Trade-off:
///   - We give up compile-time guarantees that mode B has aMax/dMax
///     etc., but...
///   - The DTO stays one record (not three), the JSON shape is one
///     stable object, and the file is hand-editable without a mode
///     switch in the schema.
///
/// Identity / sort-on-write semantics match the other block types:
/// stable client-generated id, sorted by id on write so file diffs
/// stay clean.
/// </summary>
public sealed record MotionBlockDto(
    /// <summary>Stable id, generated client-side via crypto.randomUUID().</summary>
    string Id,

    /// <summary>
    /// Solver mode: "A" (Time → Dynamics), "B" (Dynamics → Time),
    /// or "C" (Dynamics + Limits → Velocity). Set at insert-time
    /// and stable for the block's life. Server treats any other
    /// value as opaque text.
    /// </summary>
    string Mode,

    /// <summary>Position from the left edge of the dashboard area, in pixels.</summary>
    int X,
    /// <summary>Position from the top edge of the dashboard area, in pixels.</summary>
    int Y,
    /// <summary>Block width in pixels. Clamped client-side to [380, 1400].</summary>
    int Width,
    /// <summary>Block height in pixels. Clamped client-side to [320, 1200].</summary>
    int Height,

    /// <summary>
    /// Per-mode input values. Keys depend on Mode:
    ///   A: T, D, accFrac, dynFrac
    ///   B: aMax, dMax, jerk, D, vMax
    ///   C: aMax, dMax, jerk, Dmax, Ttot
    /// Values are doubles (units/seconds; fractions in [0..1]).
    /// Server stores verbatim — no per-mode validation.
    /// </summary>
    IReadOnlyDictionary<string, double> Inputs,

    /// <summary>Whether the chart's acceleration overlay is on.</summary>
    bool ShowAcc,
    /// <summary>Whether the chart's jerk overlay is on.</summary>
    bool ShowJerk);
