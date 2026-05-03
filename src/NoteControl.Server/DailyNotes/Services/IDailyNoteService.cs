using NoteControl.Shared.DailyNotes;

namespace NoteControl.Server.DailyNotes.Services;

/// <summary>
/// Open-or-create today's daily note in the given vault.
///
/// Path layout: <c>Daily Notes/YYYY/MM-MonthName/YYYY-MM-DD.md</c>,
/// e.g. <c>Daily Notes/2026/04-April/2026-04-28.md</c>. The format
/// gives users an organised tree (one folder per month) while
/// still being clear from the filename alone what date it is.
///
/// If a template named "daily" exists in the vault and we're
/// creating the note for the first time, the note's body is
/// seeded from the template. The note then carries no special
/// connection to the template — editing the template later
/// doesn't propagate to existing daily notes.
/// </summary>
public interface IDailyNoteService
{
    Task<DailyNoteResponse> OpenOrCreateTodayAsync(
        Guid vaultId,
        CancellationToken ct = default);
}
