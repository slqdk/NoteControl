namespace NoteControl.Shared.Assignments;

/// <summary>
/// Per-vault assignments list. Persisted as
/// <c>{vault}/.notesapp/assignments.json</c>. Loaded once when the
/// user clicks the "Assignments" row in the tree; saved (debounced
/// ~500ms) whenever the user adds, edits, or deletes an assignment.
///
/// The shape is intentionally flat — one list of assignments, each
/// carrying its own category. The UI groups by category at render
/// time, with the category-display order pinned (Short Term →
/// Long Term → Development). Persisting one flat list avoids
/// migrations if the category set ever changes; we'd just stop
/// rendering rows in the removed category.
///
/// Concurrency / atomic-write semantics mirror StartpageConfigDto's
/// service (temp file + rename). Same single-user assumption — no
/// optimistic-locking dance.
/// </summary>
public sealed record AssignmentsConfigDto(
    /// <summary>
    /// Schema version. Current value is 1. Server is the authority;
    /// clients don't need to send the right value on PUT, the server
    /// stamps it on write.
    /// </summary>
    int Version,

    /// <summary>
    /// All assignments in this vault, in stored order. Render order
    /// inside a category is the order assignments appear here, so a
    /// future drag-to-reorder feature has a place to put its result.
    /// Categories themselves are NOT ordered by this list — the UI
    /// pins the three category buckets (short → long → dev).
    /// </summary>
    IReadOnlyList<AssignmentDto> Assignments);

/// <summary>
/// One assignment row.
///
/// Identity is the client-generated <see cref="Id"/>. The server
/// treats it as opaque text and uses it for nothing — but having a
/// stable id means a future "edit one assignment" PATCH endpoint
/// (rather than the current "PUT the whole list") wouldn't need a
/// schema change.
/// </summary>
public sealed record AssignmentDto(
    /// <summary>
    /// Stable id, generated client-side. Same pattern the startpage
    /// DTOs use — see <see cref="NoteControl.Shared.Startpage.RssBlockDto.Id"/>.
    /// </summary>
    string Id,

    /// <summary>
    /// Category key. One of:
    ///   <c>"short"</c> — Short Term (red bucket, top of the page)
    ///   <c>"long"</c>  — Long Term (yellow bucket, middle)
    ///   <c>"dev"</c>   — Development (blue bucket, bottom)
    /// The server treats any other value as opaque and stores it
    /// verbatim, but the client falls back to "short" for unknown
    /// values when rendering. Keeping the value as a short string
    /// rather than an int means a hand-edit of the JSON file reads
    /// cleanly without a key.
    /// </summary>
    string Category,

    /// <summary>
    /// One-line headline / subject of the assignment. Empty allowed —
    /// the client renders a placeholder when so.
    /// </summary>
    string Subject,

    /// <summary>
    /// Multi-line body / details. Empty allowed.
    /// </summary>
    string Details);
