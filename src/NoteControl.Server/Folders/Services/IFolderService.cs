namespace NoteControl.Server.Folders.Services;

/// <summary>
/// Folder-level operations. Folders in NoteControl are normally
/// implicit — they appear in listings as soon as a note exists at a
/// nested path. This service adds explicit folder management:
///
///   - Create empty folders (so the user can have a place to put
///     notes before any notes exist).
///   - Delete empty folders.
///   - (Future: rename / move folders; not part of this step.)
///
/// Empty folders are realised on disk by writing a marker file at
/// <c>{folder}/.notesapp/folder-marker</c>. The marker is hidden from
/// listings because the existing folder-listing code already filters
/// out the <c>.notesapp/</c> subtree.
/// </summary>
public interface IFolderService
{
    /// <summary>
    /// Create the folder at <paramref name="canonicalPath"/> in the
    /// given vault. Idempotent — no error if it already exists.
    /// Throws <see cref="FolderException"/> for invalid paths or
    /// collisions with an existing note of the same name.
    /// </summary>
    Task CreateAsync(Guid vaultId, string canonicalPath, CancellationToken ct = default);

    /// <summary>
    /// Delete the folder at <paramref name="canonicalPath"/>. Refuses
    /// (409 via <see cref="FolderException"/>) if the folder contains
    /// any notes or non-empty subfolders. The user must empty the
    /// folder first.
    /// </summary>
    Task DeleteAsync(Guid vaultId, string canonicalPath, CancellationToken ct = default);

    /// <summary>
    /// Move (or rename) a folder. All notes and subfolders move with it.
    /// Refuses if:
    ///   - the destination path already exists
    ///   - the destination is nested under the source (can't move a
    ///     folder into itself)
    ///   - either path is invalid or the source doesn't exist
    /// </summary>
    Task MoveAsync(Guid vaultId, string oldCanonicalPath, string newCanonicalPath, CancellationToken ct = default);
}

/// <summary>
/// Caller-fixable errors. Status code maps to the HTTP response.
/// </summary>
public sealed class FolderException : Exception
{
    public int StatusCode { get; }
    public FolderException(string message, int statusCode = 400) : base(message)
    {
        StatusCode = statusCode;
    }
}
