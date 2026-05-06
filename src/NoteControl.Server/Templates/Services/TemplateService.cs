using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using NoteControl.Server.Assets.Services;
using NoteControl.Server.Data;
using NoteControl.Server.Notes.Services;
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
    private readonly INotePathResolver _notePaths;
    private readonly ILogger<TemplateService> _log;

    public TemplateService(
        ServerDbContext db,
        IVaultPathResolver vaultPaths,
        INotePathResolver notePaths,
        ILogger<TemplateService> log)
    {
        _db = db;
        _vaultPaths = vaultPaths;
        _notePaths = notePaths;
        _log = log;
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

    // ============================================================== CreateFromSelection

    public async Task<TemplateDto> CreateFromSelectionAsync(
        Guid vaultId,
        TemplateFromSelectionRequest request,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.SourceNotePath))
        {
            throw new TemplateException("sourceNotePath is required.");
        }

        // Resolve the source note up-front so we can fail fast if
        // the path is bad. Throws InvalidNotePathException for
        // syntactically bad paths; we surface as 400.
        string canonicalSource;
        try
        {
            canonicalSource = _notePaths.CanonicalizeNote(request.SourceNotePath);
        }
        catch (InvalidNotePathException ex)
        {
            throw new TemplateException(ex.Message, statusCode: 400);
        }

        var folder = await ResolveTemplatesFolderAsync(vaultId, ct);
        Directory.CreateDirectory(folder);

        // Resolve the source note's parent directory ON DISK — we
        // need this to find the source asset folder when copying
        // images. Do this BEFORE picking the template name (so a
        // missing source note 404s before we waste collision-check
        // work picking a name).
        var vault = await _db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Path })
            .FirstOrDefaultAsync(ct)
            ?? throw new TemplateException("Vault not found.", statusCode: 404);
        var vaultRoot = _vaultPaths.Resolve(vault.Path);
        var sourceNoteAbsolute = _notePaths.Resolve(vaultRoot, canonicalSource);
        if (!File.Exists(sourceNoteAbsolute))
        {
            throw new TemplateException("Source note not found.", statusCode: 404);
        }
        var sourceNoteParent = Path.GetDirectoryName(sourceNoteAbsolute)!;

        // Auto-name: "Template YYYY-MM-DD HHmm" using LOCAL time
        // (the user's frame of reference for "the meeting I just
        // had at 3pm" is local-time, not UTC). Collision-safe via
        // the existing helper convention (suffix -2, -3, ...).
        // Spaces in the name are fine — the template name regex
        // and the asset-folder convention both handle spaces.
        var baseName = $"Template {DateTime.Now:yyyy-MM-dd HHmm}";
        var name = PickAvailableTemplateName(folder, baseName);

        // Walk the markdown for image refs and copy each into the
        // template's asset folder, rewriting the path.
        var (rewrittenBody, copiedAny) = await CopyAssetsAndRewriteAsync(
            originalBody: request.Markdown ?? string.Empty,
            destBasename: name,
            destAssetsParent: folder,
            srcResolveFolder: sourceNoteParent,
            logContext: $"saving template '{name}' from selection",
            ct: ct);

        var file = Path.Combine(folder, name + ".md");
        await File.WriteAllTextAsync(file, rewrittenBody, ct);
        var lastModified = new FileInfo(file).LastWriteTimeUtc;

        if (copiedAny)
        {
            _log.LogInformation(
                "Created template '{TemplateName}' from selection in '{SourceNote}' (vault {VaultId}); copied images.",
                name, canonicalSource, vaultId);
        }
        else
        {
            _log.LogInformation(
                "Created template '{TemplateName}' from selection in '{SourceNote}' (vault {VaultId}); no images.",
                name, canonicalSource, vaultId);
        }

        return new TemplateDto(
            name,
            rewrittenBody,
            new DateTimeOffset(lastModified, TimeSpan.Zero));
    }

    // ============================================================== RenderForInsert

    public async Task<TemplateRenderResponse> RenderForInsertAsync(
        Guid vaultId,
        string templateName,
        string targetNotePath,
        CancellationToken ct = default)
    {
        ValidateName(templateName);
        if (string.IsNullOrWhiteSpace(targetNotePath))
        {
            throw new TemplateException("targetNotePath is required.");
        }

        // Resolve target note up-front so we fail fast on bad paths.
        string canonicalTarget;
        try
        {
            canonicalTarget = _notePaths.CanonicalizeNote(targetNotePath);
        }
        catch (InvalidNotePathException ex)
        {
            throw new TemplateException(ex.Message, statusCode: 400);
        }

        var templatesFolder = await ResolveTemplatesFolderAsync(vaultId, ct);
        var templateFile = Path.Combine(templatesFolder, templateName + ".md");
        if (!File.Exists(templateFile))
        {
            throw new TemplateException("Template not found.", statusCode: 404);
        }

        // Resolve target note's location on disk to find its parent
        // folder + basename — that's where assets get copied to.
        var vault = await _db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Path })
            .FirstOrDefaultAsync(ct)
            ?? throw new TemplateException("Vault not found.", statusCode: 404);
        var vaultRoot = _vaultPaths.Resolve(vault.Path);
        var targetNoteAbsolute = _notePaths.Resolve(vaultRoot, canonicalTarget);
        if (!File.Exists(targetNoteAbsolute))
        {
            // It's the CALLER's note — not having it on disk is a
            // 404, not a server error. The frontend will see this
            // when the user tries to insert a template into a note
            // that was deleted in another tab between mounting the
            // editor and clicking the slash menu item.
            throw new TemplateException("Target note not found.", statusCode: 404);
        }
        var targetNoteFileName = Path.GetFileName(targetNoteAbsolute);
        var targetBasename = targetNoteFileName.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
            ? targetNoteFileName[..^3]
            : targetNoteFileName;
        var targetNoteParent = Path.GetDirectoryName(targetNoteAbsolute)!;

        // Read the template body. Image refs in this body are
        // relative to the template file's location — i.e. relative
        // to the templates folder. So srcResolveFolder is
        // templatesFolder, NOT the vault root.
        var body = await File.ReadAllTextAsync(templateFile, ct);

        var (rewritten, copiedAny) = await CopyAssetsAndRewriteAsync(
            originalBody: body,
            destBasename: targetBasename,
            destAssetsParent: targetNoteParent,
            srcResolveFolder: templatesFolder,
            logContext: $"rendering template '{templateName}' for insert into '{canonicalTarget}'",
            ct: ct);

        if (copiedAny)
        {
            _log.LogInformation(
                "Rendered template '{TemplateName}' for insert into '{TargetNote}' (vault {VaultId}); copied images.",
                templateName, canonicalTarget, vaultId);
        }
        // No log entry for the no-images case — that's the common
        // path and the access log already records the endpoint hit.

        return new TemplateRenderResponse(rewritten);
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
    /// Pick a non-colliding template name based on the desired
    /// base name, suffixing with " (2)", " (3)", etc. on collision.
    /// We use parens not dashes (different from filename-collision
    /// suffixing in AssetFileHelpers) because template NAMES are
    /// user-visible whereas asset filenames are not — and "Template
    /// 2026-05-06 1430 (2)" reads more naturally than
    /// "Template 2026-05-06 1430-2".
    /// </summary>
    private static string PickAvailableTemplateName(string folder, string baseName)
    {
        var candidate = Path.Combine(folder, baseName + ".md");
        if (!File.Exists(candidate))
        {
            return baseName;
        }
        for (int i = 2; i < 1000; i++)
        {
            var name = $"{baseName} ({i})";
            candidate = Path.Combine(folder, name + ".md");
            if (!File.Exists(candidate))
            {
                return name;
            }
        }
        // Astronomically unlikely fallback. Append seconds.
        return $"{baseName} ({DateTime.UtcNow:HHmmss})";
    }

    /// <summary>
    /// Walk the markdown for image references, copy each referenced
    /// image from the source folder into the destination
    /// <c>&lt;destBasename&gt;.assets/</c> folder under
    /// <see cref="destAssetsParent"/>, and rewrite the markdown
    /// image paths to point at the new location.
    ///
    /// Used by both Ship 98b ("save selection as template" — source
    /// is the source note's folder, destination is the new
    /// template's asset folder) and Ship 98c ("render template for
    /// insert" — source is the templates folder, destination is the
    /// target note's asset folder).
    ///
    /// Image refs supported: <c>![alt](src)</c> and
    /// <c>![alt](src "title")</c>. Both standard CommonMark image
    /// syntax forms.
    ///
    /// Per-image disposition:
    ///   - Absolute URLs (http://, https://, data:, blob:) are
    ///     preserved as-is.
    ///   - Relative paths that don't resolve to a file on disk,
    ///     or that try to traverse outside <see cref="srcResolveFolder"/>,
    ///     are dropped from the body (the entire <c>![alt](src)</c>
    ///     reference) and a warning is logged. We deliberately don't
    ///     keep the broken ref because a body with broken images is
    ///     more confusing than one missing them.
    /// </summary>
    /// <param name="originalBody">The markdown to walk.</param>
    /// <param name="destBasename">The basename of the destination
    /// "owner" — for Ship B this is the new template's name; for
    /// Ship C it's the target note's basename. Determines the
    /// rewritten path's <c>&lt;basename&gt;.assets/</c> prefix.</param>
    /// <param name="destAssetsParent">The folder under which the
    /// destination <c>.assets/</c> folder lives. For Ship B this is
    /// the templates folder; for Ship C it's the target note's
    /// parent folder.</param>
    /// <param name="srcResolveFolder">The folder against which
    /// image refs in <paramref name="originalBody"/> are resolved.
    /// For Ship B this is the source note's parent folder; for
    /// Ship C it's the templates folder (since template refs are
    /// relative to the template file itself).</param>
    /// <param name="logContext">Free-text description of the
    /// operation for log messages — e.g. "saving template 'Foo'"
    /// or "rendering template 'Foo' for insert". Folded into the
    /// warning lines so the operator can tell which call site
    /// generated which warning.</param>
    private async Task<(string body, bool copiedAny)> CopyAssetsAndRewriteAsync(
        string originalBody,
        string destBasename,
        string destAssetsParent,
        string srcResolveFolder,
        string logContext,
        CancellationToken ct)
    {
        if (string.IsNullOrEmpty(originalBody))
        {
            return (originalBody, false);
        }

        var assetsFolderName = destBasename + AssetsFolderSuffix;
        var assetsAbsolute = Path.Combine(destAssetsParent, assetsFolderName);
        // Don't pre-create the folder — only do it lazily inside
        // the loop below if we actually find an image to copy.
        // This keeps no-image bodies from leaving an empty .assets
        // folder lying around.

        var copiedAny = false;
        var rewritten = originalBody;

        // Markdown image regex: ![alt](src) or ![alt](src "title").
        // Captures: 1=alt text, 2=src, 3=optional title (with quotes).
        // Non-greedy on alt and src so a line with multiple images
        // doesn't gobble across boundaries.
        var mdImageRx = new System.Text.RegularExpressions.Regex(
            @"!\[(?<alt>[^\]]*)\]\((?<src>[^)\s]+)(?:\s+""(?<title>[^""]*)"")?\)",
            System.Text.RegularExpressions.RegexOptions.Compiled);

        // We iterate matches in REVERSE order so that splice-out
        // operations (when we drop a broken ref) don't shift
        // subsequent match offsets.
        var matches = mdImageRx.Matches(rewritten)
            .Cast<System.Text.RegularExpressions.Match>()
            .OrderByDescending(m => m.Index)
            .ToList();

        foreach (var match in matches)
        {
            ct.ThrowIfCancellationRequested();

            var src = match.Groups["src"].Value;
            var alt = match.Groups["alt"].Value;
            var title = match.Groups["title"].Value;

            // Absolute URL or data URL — leave untouched.
            if (IsAbsoluteOrDataUrl(src))
            {
                continue;
            }

            // Resolve the source file on disk. The src is
            // URL-encoded (per the markdown convention); decode
            // each segment before joining with the filesystem
            // separator.
            var decodedSrc = string.Join('/',
                src.TrimStart('.', '/').Split('/').Select(seg =>
                {
                    try { return Uri.UnescapeDataString(seg); }
                    catch { return seg; }
                }));

            string sourceAbsolute;
            try
            {
                var combined = Path.Combine(srcResolveFolder,
                    decodedSrc.Replace('/', Path.DirectorySeparatorChar));
                sourceAbsolute = Path.GetFullPath(combined);
            }
            catch
            {
                _log.LogWarning(
                    "Could not resolve image src '{Src}' while {Op}; dropping.",
                    src, logContext);
                rewritten = rewritten.Remove(match.Index, match.Length);
                continue;
            }

            // Anti-traversal: source path must remain under the
            // configured resolve folder.
            if (!sourceAbsolute.StartsWith(srcResolveFolder, StringComparison.OrdinalIgnoreCase))
            {
                _log.LogWarning(
                    "Image src '{Src}' resolves outside resolve folder while {Op}; dropping.",
                    src, logContext);
                rewritten = rewritten.Remove(match.Index, match.Length);
                continue;
            }

            if (!File.Exists(sourceAbsolute))
            {
                _log.LogWarning(
                    "Image src '{Src}' (resolved to '{Absolute}') does not exist on disk while {Op}; dropping.",
                    src, sourceAbsolute, logContext);
                rewritten = rewritten.Remove(match.Index, match.Length);
                continue;
            }

            // Lazily create the destination asset folder on first
            // successful resolve.
            Directory.CreateDirectory(assetsAbsolute);

            var originalFileName = Path.GetFileName(sourceAbsolute);
            var safeName = AssetFileHelpers.SanitiseFileName(originalFileName);
            if (string.IsNullOrEmpty(safeName)) safeName = "image";
            var storedName = AssetFileHelpers.NextAvailableName(assetsAbsolute, safeName);
            var destAbsolute = Path.Combine(assetsAbsolute, storedName);

            try
            {
                File.Copy(sourceAbsolute, destAbsolute, overwrite: false);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex,
                    "Failed to copy image '{Source}' → '{Dest}' while {Op}; dropping ref.",
                    sourceAbsolute, destAbsolute, logContext);
                rewritten = rewritten.Remove(match.Index, match.Length);
                continue;
            }

            // Build the new markdown image ref. URL-encode segments
            // to match the convention AssetService uses for its
            // markdown emit.
            var newSrc = $"{AssetFileHelpers.UrlEncodeSegment(assetsFolderName)}/{AssetFileHelpers.UrlEncodeSegment(storedName)}";
            var newImg = string.IsNullOrEmpty(title)
                ? $"![{alt}]({newSrc})"
                : $"![{alt}]({newSrc} \"{title}\")";

            rewritten = rewritten.Remove(match.Index, match.Length)
                .Insert(match.Index, newImg);
            copiedAny = true;
        }

        await Task.CompletedTask;
        return (rewritten, copiedAny);
    }

    private static bool IsAbsoluteOrDataUrl(string src)
    {
        return src.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || src.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            || src.StartsWith("data:", StringComparison.OrdinalIgnoreCase)
            || src.StartsWith("blob:", StringComparison.OrdinalIgnoreCase);
    }

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
