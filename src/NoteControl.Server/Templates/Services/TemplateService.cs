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
///
/// Asset-folder lifecycle (Ship 98): each template <c>X.md</c> may
/// have a sibling <c>X.assets/</c> folder for uploaded images.
/// Rename and Delete here keep the asset folder in sync — rename
/// also rewrites image refs inside the body so the markdown
/// continues to point at the right place. Pre-Ship-98 templates
/// had no asset folders; the rename/delete code is a no-op for
/// those.
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
    /// Suffix for a template's asset folder, sibling to the .md file.
    /// Same convention notes use (<c>NoteName.assets/</c>); kept as
    /// a constant rather than imported from AssetService to avoid
    /// coupling the two services on a string they happen to share.
    /// </summary>
    private const string AssetsFolderSuffix = ".assets";

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
        var isRename = !string.Equals(name, request.Name, StringComparison.Ordinal);
        var body = request.Body ?? string.Empty;

        if (isRename)
        {
            // Refuse if target .md exists already.
            if (File.Exists(newFile))
            {
                throw new TemplateException(
                    $"A template named '{request.Name}' already exists.",
                    statusCode: 409);
            }

            // Refuse if the target asset folder already exists too —
            // we'd otherwise merge two templates' asset folders, which
            // is surprising. (Same posture AssetService takes for
            // note rename: don't merge.)
            var oldAssetsFolder = Path.Combine(folder, name + AssetsFolderSuffix);
            var newAssetsFolder = Path.Combine(folder, request.Name + AssetsFolderSuffix);
            if (Directory.Exists(newAssetsFolder))
            {
                throw new TemplateException(
                    $"An asset folder already exists for '{request.Name}'.",
                    statusCode: 409);
            }

            // Rename .md first, asset folder second. Either order
            // works on success; doing .md first means a partial
            // failure leaves the user with a renamed template that
            // still references its old asset folder name in the
            // body — surfacing the problem visually (broken images
            // in the editor) so the user knows something went wrong,
            // rather than silently keeping the old .md alive while
            // the assets disappear.
            File.Move(oldFile, newFile);

            if (Directory.Exists(oldAssetsFolder))
            {
                try
                {
                    Directory.Move(oldAssetsFolder, newAssetsFolder);
                }
                catch
                {
                    // Roll back the .md move so we don't leave a
                    // half-renamed pair. If THIS fails too the user
                    // is left with the original old name (and the
                    // exception bubbles up) — better than a torn state.
                    try { File.Move(newFile, oldFile); } catch { /* swallow */ }
                    throw;
                }
            }

            // Rewrite image refs in the body. The frontend has the
            // body with refs pointing at "<oldName>.assets/...";
            // those need to become "<newName>.assets/..." so the
            // post-save markdown matches the new on-disk folder.
            //
            // Both the URL-encoded and unencoded forms of the name
            // are rewritten. tiptap-markdown emits image src values
            // URL-encoded (per AssetService.UrlEncodeSegment), so
            // the encoded form is what we'll see in practice — but
            // a hand-edited template could contain the unencoded
            // form, and rewriting both costs us essentially nothing.
            body = RewriteAssetRefs(body, name, request.Name);
        }

        await File.WriteAllTextAsync(newFile, body, ct);
        var lastModified = new FileInfo(newFile).LastWriteTimeUtc;
        return new TemplateDto(
            request.Name,
            body,
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

        // Asset folder cleanup — best-effort. If the folder is
        // locked or otherwise undeletable, we log nothing here
        // (the .md is already gone, the user-visible delete
        // succeeded). The orphan folder can be cleaned by hand or
        // a future sweep job. Same posture AssetService takes for
        // trash failures.
        var assetsFolder = Path.Combine(folder, name + AssetsFolderSuffix);
        if (Directory.Exists(assetsFolder))
        {
            try
            {
                Directory.Delete(assetsFolder, recursive: true);
            }
            catch { /* swallow — orphan folder, not fatal */ }
        }

        await Task.CompletedTask;
    }

    // ============================================================== Helpers

    /// <summary>
    /// Rewrite "<oldName>.assets/" → "<newName>.assets/" everywhere in
    /// a template body, in both URL-encoded and unencoded forms. The
    /// rewrite is a string replace — there's a tiny risk that a
    /// template contains a literal occurrence of "OldName.assets/"
    /// in unrelated text (e.g. inside a code block discussing the
    /// previous template's assets) and we'd accidentally rewrite
    /// that too. The risk is low (asset folder names are an
    /// implementation detail users rarely reference in prose) and
    /// the alternative — parsing the markdown to walk only image
    /// nodes — is disproportionate work for the payoff.
    /// </summary>
    private static string RewriteAssetRefs(string body, string oldName, string newName)
    {
        if (string.IsNullOrEmpty(body)) return body;

        // Both the unencoded form (raw template name) and the
        // URL-encoded form (which is what tiptap-markdown emits when
        // the body is serialised). Encoding is segment-level: spaces
        // become %20, etc. Both forms get rewritten so we cover the
        // whole observable space.
        var oldRawMarker = oldName + AssetsFolderSuffix + "/";
        var newRawMarker = newName + AssetsFolderSuffix + "/";
        var oldEncMarker = Uri.EscapeDataString(oldName + AssetsFolderSuffix) + "/";
        var newEncMarker = Uri.EscapeDataString(newName + AssetsFolderSuffix) + "/";

        var rewritten = body.Replace(oldRawMarker, newRawMarker, StringComparison.Ordinal);
        if (!string.Equals(oldEncMarker, oldRawMarker, StringComparison.Ordinal))
        {
            rewritten = rewritten.Replace(oldEncMarker, newEncMarker, StringComparison.Ordinal);
        }
        return rewritten;
    }

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
