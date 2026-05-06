using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using NoteControl.Server.Data;
using NoteControl.Server.Vaults.Services;

namespace NoteControl.Server.Assets.Services;

/// <summary>
/// Filesystem-backed asset storage for template assets. See
/// <see cref="ITemplateAssetService"/> for the contract.
///
/// Convention: each template <c>{vault}/.notesapp/templates/X.md</c>
/// gets its own sibling folder <c>{vault}/.notesapp/templates/X.assets/</c>
/// for any uploaded images. Markdown image refs in the template
/// body look like <c>![](X.assets/photo.png)</c> — relative to the
/// template file's location, mirroring how note bodies reference
/// note assets.
///
/// Reuses <see cref="AssetFileHelpers"/> for filename sanitisation,
/// collision avoidance, URL encoding, and MIME mapping. The two
/// services intentionally share those rules so a paste from
/// "MyNote.md" copies to a template's asset folder under the same
/// conventions a paste-into-the-note would have followed.
/// </summary>
public sealed class TemplateAssetService : ITemplateAssetService
{
    private const string TemplatesSubfolder = ".notesapp/templates";
    private const string AssetsFolderSuffix = ".assets";

    /// <summary>
    /// Same name regex TemplateService uses. Duplicated here rather
    /// than imported because pulling a dependency on TemplateService
    /// just to share a regex would couple two services that don't
    /// otherwise interact. If the rule ever drifts between the two,
    /// a test should catch it.
    /// </summary>
    private static readonly System.Text.RegularExpressions.Regex NameRegex =
        new(@"^[A-Za-z0-9 _\-][A-Za-z0-9 _\-\.]{0,99}$",
            System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>
    /// Image-only allow-list for Ship 98. Templates can host images
    /// but not videos / PDFs / other binaries — the user-facing
    /// upload trigger (slash menu's Image item) only sends images,
    /// and broadening the policy now would commit us to a wider
    /// contract before we know it's wanted.
    /// </summary>
    private static readonly HashSet<string> AllowedContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/bmp",
        "image/svg+xml",
    };

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;
    private readonly AssetOptions _options;

    public TemplateAssetService(
        ServerDbContext db,
        IVaultPathResolver vaultPaths,
        IOptions<AssetOptions> options)
    {
        _db = db;
        _vaultPaths = vaultPaths;
        _options = options.Value;
    }

    public async Task<StoredAsset> SaveAsync(
        Guid vaultId,
        string templateName,
        string originalFileName,
        string contentType,
        Stream content,
        long contentLength,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(templateName))
        {
            throw new AssetException("templateName is required.");
        }
        if (!NameRegex.IsMatch(templateName))
        {
            throw new AssetException(
                "Template name must contain only letters, digits, dashes, " +
                "underscores, dots, or spaces (max 100 chars, no leading dot).");
        }
        if (string.IsNullOrWhiteSpace(originalFileName))
        {
            throw new AssetException("Filename is required.");
        }

        // Image-only policy. We check both the declared content
        // type (cheap, may be lied about by the client) and rely on
        // the file-extension MIME lookup the GET path uses for
        // serving. The declared check rejects clearly-wrong uploads
        // up-front; a determined caller could still send mislabeled
        // bytes, but they'd land on disk and be served back with the
        // browser-detected type — same risk surface as note assets.
        if (!AllowedContentTypes.Contains(contentType))
        {
            throw new AssetException(
                $"Templates accept image uploads only; got '{contentType}'.",
                statusCode: 415);
        }

        // Size check before any disk work.
        if (contentLength > _options.MaxUploadBytes)
        {
            throw new AssetException(
                $"File too large. Max upload is {_options.MaxUploadBytes:N0} bytes.",
                statusCode: 413);
        }

        // Resolve vault → templates folder → check the .md exists.
        var vault = await _db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Path })
            .FirstOrDefaultAsync(ct)
            ?? throw new AssetException("Vault not found.", statusCode: 404);

        var vaultRoot = _vaultPaths.Resolve(vault.Path);
        var templatesFolder = Path.Combine(vaultRoot, TemplatesSubfolder);
        var templateFile = Path.Combine(templatesFolder, templateName + ".md");
        if (!File.Exists(templateFile))
        {
            throw new AssetException("Template not found.", statusCode: 404);
        }

        // The asset folder lives next to the .md, named "<name>.assets".
        // Same convention as note assets — the basename is the
        // template name itself.
        var assetsFolderName = templateName + AssetsFolderSuffix;
        var assetsAbsolute = Path.Combine(templatesFolder, assetsFolderName);
        Directory.CreateDirectory(assetsAbsolute);

        var safeName = AssetFileHelpers.SanitiseFileName(originalFileName);
        if (string.IsNullOrWhiteSpace(safeName))
        {
            safeName = "file";
        }
        var storedName = AssetFileHelpers.NextAvailableName(assetsAbsolute, safeName);
        var storedAbsolute = Path.Combine(assetsAbsolute, storedName);

        // Same write-to-temp-then-rename pattern as AssetService:
        // avoids a half-written file at the final path if the
        // upload aborts.
        var tempAbsolute = storedAbsolute + ".uploading";
        try
        {
            await using (var fs = new FileStream(
                tempAbsolute, FileMode.Create, FileAccess.Write, FileShare.None,
                bufferSize: 81920, useAsync: true))
            {
                await content.CopyToAsync(fs, ct);
            }
            var actualSize = new FileInfo(tempAbsolute).Length;
            if (actualSize > _options.MaxUploadBytes)
            {
                File.Delete(tempAbsolute);
                throw new AssetException(
                    $"File too large. Max upload is {_options.MaxUploadBytes:N0} bytes.",
                    statusCode: 413);
            }
            File.Move(tempAbsolute, storedAbsolute);
        }
        catch
        {
            try { if (File.Exists(tempAbsolute)) File.Delete(tempAbsolute); } catch { /* swallow */ }
            throw;
        }

        // The template body references its assets using a path
        // RELATIVE TO THE TEMPLATE FILE: "<name>.assets/<file>".
        // That's the same shape note bodies use, so the markdown
        // looks identical and the rendering logic (frontend:
        // resolves <img src="..."> against the document's location;
        // server: GET /asset?path=...) doesn't need to know whether
        // the body it's rendering came from a note or a template.
        var relativeMarkdownPath =
            $"{AssetFileHelpers.UrlEncodeSegment(assetsFolderName)}/{AssetFileHelpers.UrlEncodeSegment(storedName)}";

        // Canonical vault-relative path. This is what the GET
        // endpoint uses to find the file again. For template assets
        // the canonical form is .notesapp/templates/<name>.assets/<file>.
        var canonicalAssetPath = $"{TemplatesSubfolder}/{assetsFolderName}/{storedName}";

        var storedSize = new FileInfo(storedAbsolute).Length;

        return new StoredAsset(
            RelativeMarkdownPath: relativeMarkdownPath,
            CanonicalAssetPath: canonicalAssetPath,
            OriginalFileName: originalFileName,
            StoredFileName: storedName,
            SizeBytes: storedSize,
            ContentType: contentType);
    }
}
