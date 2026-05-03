namespace NoteControl.Server.Assets.Services;

/// <summary>
/// Manages assets — pasted/dropped images, videos, and other files
/// that go alongside a note.
///
/// Per the architecture decision: assets live in
/// <c>{noteBasename}.assets/</c> as a sibling folder to the note's
/// <c>.md</c> file. So a note at <c>Projects/Plan.md</c> stores its
/// assets in <c>Projects/Plan.assets/</c>. Markdown references
/// them by the relative path <c>Plan.assets/photo.png</c>.
///
/// Lifecycle hooks are deliberately part of this service rather than
/// embedded in <c>NoteService</c>. When a note is renamed / moved /
/// deleted, that service calls into us so we can keep the assets
/// folder in sync. Centralising the asset-folder rules here means
/// the convention (<c>basename.assets/</c>) is asserted in exactly
/// one place.
/// </summary>
public interface IAssetService
{
    /// <summary>
    /// Save a freshly-uploaded asset. Computes a collision-free
    /// filename (e.g. <c>image.png</c> → <c>image-2.png</c> if
    /// <c>image.png</c> already exists), creates the
    /// <c>.assets/</c> folder if missing, validates size + MIME,
    /// writes bytes to disk.
    /// </summary>
    Task<StoredAsset> SaveAsync(
        Guid vaultId,
        string notePath,
        string originalFileName,
        string contentType,
        Stream content,
        long contentLength,
        CancellationToken ct = default);

    /// <summary>
    /// Resolve an absolute path on disk for an asset that's
    /// referenced by its full canonical relative path within the
    /// vault. Used by the GET endpoint to stream the bytes back.
    /// Returns null if no file exists at that path.
    /// </summary>
    Task<AssetFile?> GetAsync(Guid vaultId, string assetPath, CancellationToken ct = default);

    /// <summary>
    /// Move the assets folder when a note is renamed. No-op if the
    /// note had no assets folder. Atomic on the same drive
    /// (Directory.Move).
    /// </summary>
    Task MoveAlongsideNoteAsync(
        Guid vaultId,
        string oldNotePath,
        string newNotePath,
        CancellationToken ct = default);

    /// <summary>
    /// Move the assets folder to the vault's trash alongside the
    /// note. No-op if the note had no assets folder. The trash
    /// path matches whatever <see cref="NoteControl.Server.Notes.Services.INoteService.DeleteAsync"/>
    /// uses for the note itself.
    /// </summary>
    Task TrashAlongsideNoteAsync(
        Guid vaultId,
        string notePath,
        string trashRelativeFolder,
        CancellationToken ct = default);
}

/// <summary>Result of <see cref="IAssetService.SaveAsync"/>.</summary>
public sealed record StoredAsset(
    string RelativeMarkdownPath,    // e.g. "Plan.assets/photo.png"
    string CanonicalAssetPath,      // e.g. "Projects/Plan.assets/photo.png"
    string OriginalFileName,
    string StoredFileName,
    long SizeBytes,
    string ContentType);

/// <summary>Result of <see cref="IAssetService.GetAsync"/>.</summary>
public sealed record AssetFile(
    string AbsolutePath,
    string ContentType,
    long SizeBytes);

/// <summary>
/// Caller-fixable errors. Status code maps directly to HTTP.
/// </summary>
public sealed class AssetException : Exception
{
    public int StatusCode { get; }
    public AssetException(string message, int statusCode = 400) : base(message)
    {
        StatusCode = statusCode;
    }
}
