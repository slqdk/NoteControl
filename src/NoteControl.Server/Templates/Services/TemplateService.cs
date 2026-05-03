using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Data;
using NoteControl.Server.Vaults.Services;
using NoteControl.Shared.Templates;

namespace NoteControl.Server.Templates.Services;

/// <summary>
/// Filesystem-backed template store. See <see cref="ITemplateService"/>
/// for the contract.
///
/// Path safety: every supplied template name is validated against a
/// strict regex (alphanumerics, dashes, underscores, spaces). No
/// path separators allowed. We never combine raw user strings with
/// the templates folder path without validation.
/// </summary>
public sealed class TemplateService : ITemplateService
{
    /// <summary>
    /// Folder under the vault root where templates live.
    /// Mirrors the convention used elsewhere
    /// (<c>.notesapp/index.db</c>, <c>.notesapp/trash/</c>).
    /// </summary>
    private const string TemplatesSubfolder = ".notesapp/templates";

    /// <summary>
    /// Allowed template name characters. Letters, digits, dash,
    /// underscore, space. Length 1-100. Disallows leading dots so
    /// users can't write hidden filenames.
    /// </summary>
    private static readonly System.Text.RegularExpressions.Regex NameRegex =
        new(@"^[A-Za-z0-9 _\-][A-Za-z0-9 _\-\.]{0,99}$",
            System.Text.RegularExpressions.RegexOptions.Compiled);

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;

    public TemplateService(ServerDbContext db, IVaultPathResolver vaultPaths)
    {
        _db = db;
        _vaultPaths = vaultPaths;
    }

    // ============================================================== List

    public async Task<IReadOnlyList<TemplateSummaryDto>> ListAsync(
        Guid vaultId,
        CancellationToken ct = default)
    {
        var folder = await ResolveTemplatesFolderAsync(vaultId, ct);
        if (!Directory.Exists(folder))
        {
            return Array.Empty<TemplateSummaryDto>();
        }

        var results = new List<TemplateSummaryDto>();
        foreach (var path in Directory.EnumerateFiles(folder, "*.md", SearchOption.TopDirectoryOnly))
        {
            var name = Path.GetFileNameWithoutExtension(path);
            if (string.IsNullOrEmpty(name)) continue;
            var info = new FileInfo(path);
            results.Add(new TemplateSummaryDto(
                Name: name,
                LastModified: new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero)));
        }
        // Alphabetical for stable display order.
        results.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        return results;
    }

    // ============================================================== Get

    public async Task<TemplateDto?> GetAsync(
        Guid vaultId,
        string name,
        CancellationToken ct = default)
    {
        ValidateName(name);
        var folder = await ResolveTemplatesFolderAsync(vaultId, ct);
        var file = Path.Combine(folder, name + ".md");
        if (!File.Exists(file)) return null;

        var body = await File.ReadAllTextAsync(file, ct);
        var lastModified = new FileInfo(file).LastWriteTimeUtc;
        return new TemplateDto(name, body, new DateTimeOffset(lastModified, TimeSpan.Zero));
    }

    // ============================================================== Create

    public async Task<TemplateDto> CreateAsync(
        Guid vaultId,
        TemplateUpsertRequest request,
        CancellationToken ct = default)
    {
        ValidateName(request.Name);
        var folder = await ResolveTemplatesFolderAsync(vaultId, ct);
        Directory.CreateDirectory(folder);

        var file = Path.Combine(folder, request.Name + ".md");
        if (File.Exists(file))
        {
            throw new TemplateException(
                $"A template named '{request.Name}' already exists.",
                statusCode: 409);
        }

        await File.WriteAllTextAsync(file, request.Body ?? string.Empty, ct);
        var lastModified = new FileInfo(file).LastWriteTimeUtc;
        return new TemplateDto(
            request.Name,
            request.Body ?? string.Empty,
            new DateTimeOffset(lastModified, TimeSpan.Zero));
    }

    // ============================================================== Update

    public async Task<TemplateDto> UpdateAsync(
        Guid vaultId,
        string name,
        TemplateUpsertRequest request,
        CancellationToken ct = default)
    {
        ValidateName(name);
        ValidateName(request.Name);

        var folder = await ResolveTemplatesFolderAsync(vaultId, ct);
        var oldFile = Path.Combine(folder, name + ".md");
        if (!File.Exists(oldFile))
        {
            throw new TemplateException("Template not found.", statusCode: 404);
        }

        var newFile = Path.Combine(folder, request.Name + ".md");
        if (!string.Equals(name, request.Name, StringComparison.Ordinal))
        {
            // Renaming the template — refuse if target exists already.
            if (File.Exists(newFile))
            {
                throw new TemplateException(
                    $"A template named '{request.Name}' already exists.",
                    statusCode: 409);
            }
            // Atomic rename + body write. Move first so the target
            // file's identity matches the new name, then overwrite
            // its body.
            File.Move(oldFile, newFile);
        }

        await File.WriteAllTextAsync(newFile, request.Body ?? string.Empty, ct);
        var lastModified = new FileInfo(newFile).LastWriteTimeUtc;
        return new TemplateDto(
            request.Name,
            request.Body ?? string.Empty,
            new DateTimeOffset(lastModified, TimeSpan.Zero));
    }

    // ============================================================== Delete

    public async Task DeleteAsync(Guid vaultId, string name, CancellationToken ct = default)
    {
        ValidateName(name);
        var folder = await ResolveTemplatesFolderAsync(vaultId, ct);
        var file = Path.Combine(folder, name + ".md");
        if (!File.Exists(file))
        {
            throw new TemplateException("Template not found.", statusCode: 404);
        }
        File.Delete(file);
        await Task.CompletedTask;
    }

    // ============================================================== Helpers

    private async Task<string> ResolveTemplatesFolderAsync(Guid vaultId, CancellationToken ct)
    {
        var vault = await _db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Path })
            .FirstOrDefaultAsync(ct)
            ?? throw new TemplateException("Vault not found.", statusCode: 404);

        var vaultRoot = _vaultPaths.Resolve(vault.Path);
        return Path.Combine(vaultRoot, TemplatesSubfolder);
    }

    private static void ValidateName(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            throw new TemplateException("Template name is required.");
        }
        if (!NameRegex.IsMatch(name))
        {
            throw new TemplateException(
                "Template name must contain only letters, digits, dashes, " +
                "underscores, dots, or spaces (max 100 chars, no leading dot).");
        }
    }
}
