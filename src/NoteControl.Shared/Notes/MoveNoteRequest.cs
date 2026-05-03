namespace NoteControl.Shared.Notes;

/// <summary>
/// Request body for <c>PUT /api/vaults/{id}/note/move</c>. Renames or
/// relocates a note in one operation; rename is just "move to a new
/// path in the same parent folder".
/// </summary>
/// <param name="OldPath">Current canonical relative path of the note.</param>
/// <param name="NewPath">Target canonical relative path. Must end in <c>.md</c>.</param>
public sealed record MoveNoteRequest(string OldPath, string NewPath);
