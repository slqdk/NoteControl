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
