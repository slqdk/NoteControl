namespace NoteControl.Server.Folders.Services;

/// <summary>
/// Per-folder cover image storage. One image per folder, stored as
/// <c>&lt;folder&gt;/.folder-cover.&lt;ext&gt;</c>. See
/// <see cref="FolderCoverService"/> for the storage rationale.
/// </summary>
public interface IFolderCoverService
{
    /// <summary>
    /// Synchronous probe for the existence of a cover at the given
    /// folder. Doesn't open the file or touch the database; cheap
    /// enough that <see cref="Notes.Services.NoteService.ListFolderAsync"/>
    /// calls it for every listing to populate <c>CoverUrl</c>.
    /// </summary>
    /// <param name="vaultRoot">Resolved absolute vault root.</param>
    /// <param name="canonicalFolderPath">Canonical folder path (forward slashes; empty = root).</param>
    /// <param name="absolutePath">Set to the file's absolute path on success.</param>
    /// <param name="lastWriteUtc">Set to the file's mtime on success (used for cache-busting).</param>
    /// <returns>True if a cover file exists.</returns>
    bool TryGetExistingCover(
        string vaultRoot,
        string canonicalFolderPath,
        out string absolutePath,
        out DateTime lastWriteUtc);

    /// <summary>
    /// Resolve the cover file for the given folder, returning its
    /// absolute path + content type + size if one exists, or null.
    /// Used by the GET endpoint to stream the bytes.
    /// </summary>
    Task<FolderCoverFile?> GetAsync(Guid vaultId, string canonicalFolderPath, CancellationToken ct = default);

    /// <summary>
    /// Save (or replace) the cover for the given folder. Enforces
    /// image-only content types and the configured max upload size.
    /// Removes any prior cover of a different extension as part of
    /// the same operation so the folder never holds two covers.
    /// </summary>
    Task<FolderCoverInfo> SaveAsync(
        Guid vaultId,
        string canonicalFolderPath,
        string originalFileName,
        string contentType,
        Stream content,
        long contentLength,
        CancellationToken ct = default);

    /// <summary>
    /// Delete the cover for the given folder (any accepted extension).
    /// Returns true if anything was removed, false if there was no
    /// cover to begin with.
    /// </summary>
    Task<bool> DeleteAsync(Guid vaultId, string canonicalFolderPath, CancellationToken ct = default);
}

/// <summary>Resolved cover file ready for <see cref="Microsoft.AspNetCore.Http.Results.File(string, string?, string?, bool)"/>.</summary>
public sealed record FolderCoverFile(string AbsolutePath, string ContentType, long SizeBytes);

/// <summary>Metadata about a saved cover, returned to the upload caller.</summary>
public sealed record FolderCoverInfo(long SizeBytes, string ContentType, DateTime LastWriteUtc);

/// <summary>Caller-fixable errors. <c>StatusCode</c> drives the HTTP response.</summary>
public sealed class FolderCoverException : Exception
{
    public int StatusCode { get; }
    public FolderCoverException(string message, int statusCode = 400) : base(message)
    {
        StatusCode = statusCode;
    }
}
