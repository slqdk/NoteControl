namespace NoteControl.Server.Assets.Services;

/// <summary>
/// Asset upload for templates — the analogue of
/// <see cref="IAssetService"/> for note assets, but writing into
/// <c>.notesapp/templates/&lt;name&gt;.assets/</c> instead of
/// <c>&lt;noteBasename&gt;.assets/</c>.
///
/// The READ path (GET) is shared with note assets via
/// <see cref="IAssetService.GetAsync"/> — same endpoint, same
/// validation, same response. Only the WRITE side differs because
/// the destination folder is computed from a template name rather
/// than a note path.
///
/// Why a separate service rather than overloading
/// <see cref="IAssetService.SaveAsync"/>? The two callers have
/// disjoint identity (notePath vs templateName), disjoint folder
/// resolution rules, and disjoint validation (templates can't host
/// arbitrary file types — image-only is the policy). A separate
/// service makes the HTTP surface one-to-one with the storage
/// concept and keeps each method's preconditions clean.
/// </summary>
public interface ITemplateAssetService
{
    /// <summary>
    /// Save a freshly-uploaded asset into a template's asset folder.
    /// Computes a collision-free filename, creates the
    /// <c>&lt;name&gt;.assets/</c> folder if missing, validates size,
    /// writes bytes to disk.
    ///
    /// Returns a <see cref="StoredAsset"/> whose
    /// <see cref="StoredAsset.RelativeMarkdownPath"/> is the path
    /// the template body should reference (e.g.
    /// <c>MyTemplate.assets/photo.png</c>).
    ///
    /// Errors: 404 if the template doesn't exist, 400 for bad
    /// names / non-image content types (per the image-only policy
    /// for Ship 98), 413 for over-size uploads.
    /// </summary>
    Task<StoredAsset> SaveAsync(
        Guid vaultId,
        string templateName,
        string originalFileName,
        string contentType,
        Stream content,
        long contentLength,
        CancellationToken ct = default);
}
