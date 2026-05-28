using NoteControl.Shared.Startpage;

namespace NoteControl.Shared.NoteWidgets;

/// <summary>
/// Per-vault store of note-attached widgets. Persisted as
/// <c>{vault}/.notesapp/note-widgets.json</c>. Loaded once when a
/// note opens in the editor; saved (debounced ~500ms) whenever a
/// widget is added, edited, or removed on any note.
///
/// Why a sidecar instead of inline-in-the-markdown:
///   - Note widgets are interactive React surfaces (an animated
///     motor compare, an RSS feed, a Motion calculator). They have
///     no faithful markdown representation, so embedding them in the
///     <c>.md</c> body would either bloat the file with serialized
///     JSON-in-HTML or lose state on round-trip through the source
///     view / docx export.
///   - Keeping them out of the body removes the body-overwrite hazard
///     the Properties panel already guards against (see
///     UpdateNoteRequest.Body docs): widget edits never touch the
///     note body or its etag, so a stale editor snapshot can't clobber
///     a widget change and vice-versa.
///
/// Caveat (documented in the ship notes, surfaced to the user):
/// because widgets live in the sidecar and NOT in the <c>.md</c>,
/// they are invisible in the source view and in docx/.md export, and
/// they do not travel if the bare <c>.md</c> file is copied out of the
/// vault. They are bound to the note by its path — renaming/moving a
/// note via the app re-keys this file (handled by the move flow);
/// moving the file by hand on disk orphans its widgets.
///
/// Concurrency / atomic-write semantics mirror
/// AssignmentsConfigService / StartpageConfigService (temp file +
/// rename, single-user last-write-wins).
/// </summary>
public sealed record NoteWidgetsConfigDto(
    /// <summary>
    /// Schema version. Current value is 1. The server is the
    /// authority — clients don't need to send the right value on
    /// PUT; the server stamps it on write.
    /// </summary>
    int Version,

    /// <summary>
    /// Map of note path → that note's ordered widget list. The key
    /// is the note's vault-relative path with <c>/</c> separators and
    /// the <c>.md</c> extension, exactly as it appears elsewhere in
    /// the API (see NoteDto.Path). Notes with no widgets are simply
    /// absent from the map rather than carrying an empty array, so
    /// the file stays small for vaults that barely use widgets.
    /// </summary>
    IReadOnlyDictionary<string, IReadOnlyList<NoteWidgetDto>> ByNote);

/// <summary>
/// One widget attached to a note, rendered in the note view above
/// the editor (the band above the note's top rule). The widget's
/// concrete payload is carried in exactly one of the typed payload
/// fields, selected by <see cref="Kind"/>.
///
/// Why reuse the Startpage block DTOs as payloads rather than
/// inventing fresh ones: the four existing widget types (RSS, Task,
/// Links, Motion) already have battle-tested React components whose
/// prop contract is <c>{ block/area, onChange(patch), onDelete }</c>.
/// Embedding the same DTO lets the note-widget layer reuse those
/// components verbatim — no second persistence shape, no second
/// renderer. New note-native widgets (e.g. the motor compare) add a
/// new <see cref="Kind"/> value and a new payload field; the older
/// kinds are untouched.
///
/// The x/y/width/height the block DTOs carry are meaningful on the
/// free-floating dashboard canvas but NOT in the note view, where
/// widgets stack vertically. The note-widget renderer ignores x/y
/// (no absolute positioning) and may still honour width/height for
/// the widget's own sizing. The fields are kept on the payload so the
/// same DTO and component work in both contexts; the note view simply
/// doesn't position by them.
/// </summary>
public sealed record NoteWidgetDto(
    /// <summary>
    /// Stable id, generated client-side via crypto.randomUUID().
    /// React key + identity for edit/delete. Server treats it as
    /// opaque. Distinct from any id on the embedded payload — the
    /// payload's own id is irrelevant in the note context but kept
    /// intact so the shared component keys cleanly.
    /// </summary>
    string Id,

    /// <summary>
    /// Discriminator selecting which payload field is populated:
    ///   <c>"rss"</c>    → <see cref="Rss"/>
    ///   <c>"task"</c>   → <see cref="Task"/>
    ///   <c>"links"</c>  → <see cref="Links"/>
    ///   <c>"motion"</c> → <see cref="Motion"/>
    /// Unknown kinds are stored verbatim and skipped by the client
    /// renderer (forward-compat: a newer build can add a kind an
    /// older build simply won't draw, rather than 500-ing).
    /// </summary>
    string Kind,

    /// <summary>RSS feed payload. Non-null iff <see cref="Kind"/> is "rss".</summary>
    RssBlockDto? Rss = null,

    /// <summary>Task area payload. Non-null iff <see cref="Kind"/> is "task".</summary>
    TaskAreaDto? Task = null,

    /// <summary>Links block payload. Non-null iff <see cref="Kind"/> is "links".</summary>
    LinkBlockDto? Links = null,

    /// <summary>Motion calculator payload. Non-null iff <see cref="Kind"/> is "motion".</summary>
    MotionBlockDto? Motion = null,

    /// <summary>
    /// Synchronous/asynchronous motor-compare payload. Non-null iff
    /// <see cref="Kind"/> is "motor". Unlike the other four payloads
    /// this is a note-native widget (no dashboard counterpart), so its
    /// DTO lives in this namespace rather than Startpage.
    /// </summary>
    MotorBlockDto? Motor = null,

    /// <summary>
    /// Unit-converter payload. Non-null iff <see cref="Kind"/> is
    /// "convert". Note-native widget.
    /// </summary>
    ConvertBlockDto? Convert = null);

/// <summary>
/// Configuration for the live unit-converter widget. A category is
/// selected (force, torque, mass, inertia, length, rotational speed)
/// and the user edits any unit field; all the other fields in that
/// category update instantly.
///
/// Persistence model: rather than store per-unit text (which would
/// invite rounding drift on round-trip), we store ONE base-SI value per
/// category in <see cref="Values"/>, keyed by category id. Each unit
/// field on screen is then value × (base / unitFactor) at render time.
/// Switching categories preserves each category's value because they're
/// all kept in the map. The active category is <see cref="Category"/>.
///
/// The unit factors themselves live entirely in the frontend — the
/// server treats this payload as opaque data, so adding a unit or a
/// category is a frontend-only change with no DTO bump.
///
/// x/y/width/height mirror the other note widgets.
/// </summary>
public sealed record ConvertBlockDto(
    /// <summary>Stable id (client-generated). Opaque to the server.</summary>
    string Id,

    /// <summary>Dashboard-canvas coordinate; ignored in the note stack.</summary>
    double X = 0,

    /// <summary>Dashboard-canvas coordinate; ignored in the note stack.</summary>
    double Y = 0,

    /// <summary>Widget width in px (host overrides via measurement in-note).</summary>
    double Width = 460,

    /// <summary>Widget height in px.</summary>
    double Height = 360,

    /// <summary>
    /// Active category id. One of the frontend category ids
    /// ("force", "torque", "mass", "inertia", "length", "rotspeed").
    /// Unknown values fall back to the first category in the UI.
    /// </summary>
    string Category = "force",

    /// <summary>
    /// Base-SI value per category, keyed by category id. The base unit
    /// is the SI unit of that category (N, N·m, kg, kg·m², m, rad/s).
    /// A category absent from the map is treated as 0. Kept as a map so
    /// each category remembers its own value across switches.
    /// </summary>
    IReadOnlyDictionary<string, double>? Values = null);

/// <summary>
/// Configuration for the synchronous vs. asynchronous motor comparison
/// widget. An interactive teaching animation: a rotating stator field
/// drives a synchronous rotor (locked to the field, zero slip) beside
/// an asynchronous rotor (lags the field by the slip, which grows with
/// mechanical load).
///
/// The two machines share pole-pairs and line frequency so the
/// comparison is fair — same field, same synchronous speed — and the
/// only visible difference is the async rotor falling behind under
/// load. Physics is intentionally simplified for intuition, not
/// accuracy: synchronous speed n_s = 60·f / p [rpm] (p = pole pairs),
/// and slip s = (load/100) · sRatedPct/100, clamped to [0, sMax]. The
/// async rotor speed is n_r = n_s · (1 − s).
///
/// x/y/width/height mirror the other note widgets: x/y are ignored in
/// the note stack, width/height drive the widget's own layout (the
/// host measures width and owns the resize handle).
/// </summary>
public sealed record MotorBlockDto(
    /// <summary>Stable id (client-generated). Opaque to the server.</summary>
    string Id,

    /// <summary>Dashboard-canvas coordinate; ignored in the note stack.</summary>
    double X = 0,

    /// <summary>Dashboard-canvas coordinate; ignored in the note stack.</summary>
    double Y = 0,

    /// <summary>Widget width in px (host overrides via measurement in-note).</summary>
    double Width = 720,

    /// <summary>Widget height in px.</summary>
    double Height = 460,

    /// <summary>Pole pairs (p). Shared by both machines. 1..12 in the UI.</summary>
    int PolePairs = 1,

    /// <summary>Line frequency in Hz. Shared. Slider 0..100.</summary>
    double FrequencyHz = 50,

    /// <summary>
    /// Mechanical load as a percent 0..100. Drives the async slip via
    /// the linear model; the sync machine ignores it (no slip).
    /// </summary>
    double LoadPct = 50,

    /// <summary>
    /// Rated slip percent at full load (typical real induction motors
    /// sit at 1..6 %). The async slip scales linearly toward this with
    /// load. Default 6.
    /// </summary>
    double RatedSlipPct = 6,

    /// <summary>Whether the animation is currently running.</summary>
    bool Running = true);
