namespace NoteControl.Shared.DailyNotes;

/// <summary>
/// Response from <c>POST /api/vaults/{id}/daily/today</c>.
///
/// <para>
/// <see cref="Path"/> is the canonical path to the note ("Daily
/// Notes/2026/04-April/2026-04-28.md") that the client uses to
/// navigate to the editor.
/// </para>
/// <para>
/// <see cref="Created"/> is true if the server created the note as
/// part of this call, false if it already existed. The frontend
/// uses this to show a small toast like "Today's note opened" vs
/// "Today's note created from template".
/// </para>
/// <para>
/// <see cref="AppliedTemplate"/> names the template that was used
/// to seed the body, or null if no daily template exists. Only set
/// when Created is true (existing notes don't get re-seeded).
/// </para>
/// </summary>
public sealed record DailyNoteResponse(
    string Path,
    bool Created,
    string? AppliedTemplate);
