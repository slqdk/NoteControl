namespace NoteControl.Shared.Folders;

/// <summary>
/// Request body for <c>POST /api/vaults/{id}/folder</c>.
/// </summary>
/// <param name="Path">
/// Canonical relative path of the folder to create (forward slashes,
/// no trailing slash). Empty string is rejected — you can't create
/// the vault root.
/// </param>
public sealed record CreateFolderRequest(string Path);

/// <summary>
/// Response body returned after a successful folder operation.
/// Mirrors the canonical path back so the client can use it without
/// having to re-canonicalise locally.
/// </summary>
public sealed record FolderDto(string Path);
