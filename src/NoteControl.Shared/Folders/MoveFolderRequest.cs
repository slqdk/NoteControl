namespace NoteControl.Shared.Folders;

/// <summary>
/// Request body for <c>PUT /api/vaults/{id}/folder/move</c>. Renames
/// or relocates a folder, taking all its contents with it.
/// </summary>
/// <param name="OldPath">Current canonical relative path of the folder.</param>
/// <param name="NewPath">Target canonical relative path.</param>
public sealed record MoveFolderRequest(string OldPath, string NewPath);
