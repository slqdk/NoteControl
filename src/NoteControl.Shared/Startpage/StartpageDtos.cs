namespace NoteControl.Shared.Startpage;

/// <summary>
/// Per-vault startpage configuration. Persisted as
/// <c>{vault}/.notesapp/startpage.json</c>. Loaded by the client
/// when navigating to the startpage and saved (debounced ~500ms)
/// whenever the user changes any block.
///
/// Free-floating layout: each block carries its own absolute
/// position + size in pixels, relative to the top-left of the
/// startpage scrollable area. No grid. The frontend clamps values
/// to sane bounds before sending; the server stores them verbatim.
///
/// Backward compatibility note: <see cref="TaskAreas"/> was added
/// in step 42, <see cref="Links"/> in Ship 74. Existing files
/// written before each addition simply lack that field.
/// System.Text.Json fills missing reference-typed positional record
/// parameters with null, so the server's StartpageConfigService
/// normalises null → empty list after deserialising. The TYPE here
/// is non-nullable to keep downstream code simple; the
/// deserialisation seam is the only place the temporary-null
/// actually exists.
/// </summary>
public sealed record StartpageConfigDto(
    /// <summary>
    /// All RSS blocks on the page. Order is irrelevant (each block
    /// has an absolute Z position via id stability + render order),
    /// but we keep the list sorted by Id for deterministic JSON
    /// output so file diffs are readable.
    /// </summary>
    IReadOnlyList<RssBlockDto> Blocks,
    /// <summary>
    /// All task areas on the page (step 42). Free-floating
    /// containers, each holding its own ordered list of sticky
    /// notes. Same identity / sort-on-write semantics as Blocks.
    /// </summary>
    IReadOnlyList<TaskAreaDto> TaskAreas,
    /// <summary>
    /// All link blocks on the page (Ship 74). Free-floating
    /// containers, each holding up to 10 link entries (title +
    /// description + URL). Same identity / sort-on-write semantics
    /// as Blocks and TaskAreas.
    /// </summary>
    IReadOnlyList<LinkBlockDto> Links);

/// <summary>
/// One RSS block on the startpage. Identity is the (random,
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

    /// <summary>Position from the left edge of the startpage area, in pixels.</summary>
    int X,
    /// <summary>Position from the top edge of the startpage area, in pixels.</summary>
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
/// One free-floating task area on the startpage (step 42).
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

    /// <summary>Position from the left edge of the startpage area, in pixels.</summary>
    int X,
    /// <summary>Position from the top edge of the startpage area, in pixels.</summary>
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
/// One free-floating links block on the startpage (Ship 74). Acts
/// as a labelled container for an ordered list of links — typically
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

    /// <summary>Position from the left edge of the startpage area, in pixels.</summary>
    int X,
    /// <summary>Position from the top edge of the startpage area, in pixels.</summary>
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
/// One link entry inside a LinkBlock (Ship 74). Two-line visual:
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
