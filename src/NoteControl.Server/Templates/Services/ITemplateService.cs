using NoteControl.Shared.Templates;

namespace NoteControl.Server.Templates.Services;

/// <summary>
/// Manages per-vault templates stored under
/// <c>{vault}/.notesapp/templates/*.md</c>.
///
/// Templates are plain markdown files just like notes — but kept in
/// a hidden location so they don't clutter the user's tree. The
/// filename (minus <c>.md</c>) is the template's identity; renaming
/// = save-as-new + delete-old. Names follow the same canonicalisation
/// rules as notes (no slashes, no traversal, no reserved chars).
/// </summary>
public interface ITemplateService
{
    Task<IReadOnlyList<TemplateSummaryDto>> ListAsync(Guid vaultId, CancellationToken ct = default);
    Task<TemplateDto?> GetAsync(Guid vaultId, string name, CancellationToken ct = default);
    Task<TemplateDto> CreateAsync(Guid vaultId, TemplateUpsertRequest request, CancellationToken ct = default);
    Task<TemplateDto> UpdateAsync(Guid vaultId, string name, TemplateUpsertRequest request, CancellationToken ct = default);
    Task DeleteAsync(Guid vaultId, string name, CancellationToken ct = default);

    /// <summary>
    /// Ship 98b: create a new template from a selection in an
    /// existing note. The server picks an auto-name based on the
    /// current local time (<c>Template YYYY-MM-DD HHmm</c>) with a
    /// numeric suffix on collision, walks the markdown for image
    /// references, copies each referenced image from the source
    /// note's asset folder into the new template's asset folder
    /// (collision-safe), and rewrites the markdown image paths to
    /// point at the new location.
    ///
    /// Images that can't be resolved (file missing on disk) are
    /// dropped from the saved markdown — keeping the image syntax
    /// would render as a broken image in the template editor; the
    /// rest of the selection is kept. Server logs a warning for
    /// each dropped image.
    /// </summary>
    Task<TemplateDto> CreateFromSelectionAsync(
        Guid vaultId,
        TemplateFromSelectionRequest request,
        CancellationToken ct = default);
}

/// <summary>
/// Caller-fixable errors. Status code maps directly to HTTP.
/// </summary>
public sealed class TemplateException : Exception
{
    public int StatusCode { get; }
    public TemplateException(string message, int statusCode = 400) : base(message)
    {
        StatusCode = statusCode;
    }
}
