using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using NoteControl.Server.Data;
using NoteControl.Server.Notes.Services;
using NoteControl.Server.Vaults.Services;

namespace NoteControl.Server.Assets.Services;

/// <summary>
/// Filesystem-backed asset storage. See <see cref="IAssetService"/>
/// for the contract.
///
/// Path safety: write paths (SaveAsync, MoveAlongsideNoteAsync,
/// TrashAlongsideNoteAsync) all go through
/// <see cref="INotePathResolver"/> which canonicalises and rejects
/// path traversal, absolute paths, and the reserved
/// <c>.notesapp/</c> subtree. The READ path (GetAsync) does its
/// own validation inline because, since Ship 98, asset GETs must
/// also serve files under <c>.notesapp/templates/&lt;name&gt;.assets/</c>
/// — paths the resolver intentionally rejects for note operations.
/// The same anti-traversal protections apply (Path.GetFullPath +
/// IsUnderRoot), and the load-bearing safety rule is that the path
/// must contain a <c>.assets/</c> segment, restricting reads to
/// genuine asset folders.
/// </summary>
public sealed class AssetService : IAssetService
{
    private const string AssetsFolderSuffix = ".assets";

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;
    private readonly INotePathResolver _notePaths;
    private readonly AssetOptions _options;

    public AssetService(
        ServerDbContext db,
        IVaultPathResolver vaultPaths,
        INotePathResolver notePaths,
        IOptions<AssetOptions> options)
    {
        _db = db;
        _vaultPaths = vaultPaths;
        _notePaths = notePaths;
        _options = options.Value;
    }

    // ============================================================== Save

    public async Task<StoredAsset> SaveAsync(
        Guid vaultId,
        string notePath,
        string originalFileName,
        string contentType,
        Stream content,
        long contentLength,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(notePath))
        {
            throw new AssetException("notePath is required.");
        }
        if (string.IsNullOrWhiteSpace(originalFileName))
        {
            throw new AssetException("Filename is required.");
        }

        // Size check before any disk work.
        if (contentLength > _options.MaxUploadBytes)
        {
            throw new AssetException(
                $"File too large. Max upload is {_options.MaxUploadBytes:N0} bytes.",
                statusCode: 413);
        }

        // Resolve the note → assets folder. Throws if notePath is
        // syntactically invalid; we surface as 400.
        string canonicalNote;
        try
        {
            canonicalNote = _notePaths.CanonicalizeNote(notePath);
        }
        catch (InvalidNotePathException ex)
        {
            throw new AssetException(ex.Message, statusCode: 400);
        }

        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);
        var noteAbsolute = _notePaths.Resolve(vaultRoot, canonicalNote);
        if (!File.Exists(noteAbsolute))
        {
            throw new AssetException("Note does not exist.", statusCode: 404);
        }

        // basename = note filename minus ".md".
        var noteFileName = Path.GetFileName(noteAbsolute);
        var basename = noteFileName.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
            ? noteFileName[..^3]
            : noteFileName;
        var assetsFolderName = basename + AssetsFolderSuffix;
        var noteParent = Path.GetDirectoryName(noteAbsolute)!;
        var assetsAbsolute = Path.Combine(noteParent, assetsFolderName);

        Directory.CreateDirectory(assetsAbsolute);

        // Sanitise the original filename. Drop path separators (a
        // malicious browser could send "../escape.txt"), strip
        // characters illegal on Windows.
        var safeName = AssetFileHelpers.SanitiseFileName(originalFileName);
        if (string.IsNullOrWhiteSpace(safeName))
        {
            safeName = "file";
        }

        // Resolve collisions: foo.png → foo-2.png → foo-3.png ...
        var storedName = AssetFileHelpers.NextAvailableName(assetsAbsolute, safeName);
        var storedAbsolute = Path.Combine(assetsAbsolute, storedName);

        // Stream-copy into a temp file first, then rename. This
        // avoids leaving a half-written file at the final path if
        // the upload aborts. Same drive, so the rename is atomic.
        var tempAbsolute = storedAbsolute + ".uploading";
        try
        {
            await using (var fs = new FileStream(
                tempAbsolute, FileMode.Create, FileAccess.Write, FileShare.None,
                bufferSize: 81920, useAsync: true))
            {
                await content.CopyToAsync(fs, ct);
            }
            // Re-check size after the copy in case Content-Length lied.
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
            // Clean up partial temp file on any failure.
            try { if (File.Exists(tempAbsolute)) File.Delete(tempAbsolute); } catch { /* swallow */ }
            throw;
        }

        // Compute the relative-to-note markdown path. The markdown
        // file references its assets like
        //   ![alt](Plan.assets/photo.png)
        //
        // We URL-encode each path SEGMENT (folder name, file name)
        // but keep the slashes literal. This matters when the note's
        // basename or the asset filename contains characters that
        // would otherwise break standard markdown image syntax —
        // most commonly spaces. Without encoding, "My Note.assets/x.png"
        // produces `![](My Note.assets/x.png)` which CommonMark
        // parsers reject (the URL ends at the first space).
        // With encoding, "My%20Note.assets/x.png" parses cleanly,
        // round-trips through tiptap-markdown's load+save cycle,
        // and the browser decodes back to the real path when
        // fetching.
        var relativeMarkdownPath = $"{AssetFileHelpers.UrlEncodeSegment(assetsFolderName)}/{AssetFileHelpers.UrlEncodeSegment(storedName)}";

        // Canonical vault-relative path. This is what the GET
        // endpoint uses to find the file again.
        var canonicalAssetPath = JoinCanonical(parentOf(canonicalNote), assetsFolderName, storedName);

        var storedSize = new FileInfo(storedAbsolute).Length;

        return new StoredAsset(
            RelativeMarkdownPath: relativeMarkdownPath,
            CanonicalAssetPath: canonicalAssetPath,
            OriginalFileName: originalFileName,
            StoredFileName: storedName,
            SizeBytes: storedSize,
            ContentType: contentType);
    }

    // ============================================================== Get

    public async Task<AssetFile?> GetAsync(Guid vaultId, string assetPath, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(assetPath))
        {
            return null;
        }

        // Normalise separators and strip leading/trailing slashes —
        // does NOT enforce the .notesapp rejection rule, because we
        // explicitly want to accept template-asset paths that live
        // inside .notesapp/templates/<name>.assets/<file>.
        //
        // Two valid path shapes after Ship 98:
        //   1. <subfolders>/<basename>.assets/<file>
        //         — note assets (the original behaviour).
        //   2. .notesapp/templates/<name>.assets/<file>
        //         — template assets (Ship 98).
        //
        // Both end with "/<something>.assets/<filename>", which is
        // what the .assets/ membership check below validates. The
        // crucial safety constraint — "the path must end inside an
        // .assets/ folder" — is preserved across both shapes; an
        // attacker can't ask for .notesapp/index.db this way, only
        // for files that are literally under a .assets/ folder.
        var normalised = assetPath.Replace('\\', '/').Trim('/');
        while (normalised.Contains("//", StringComparison.Ordinal))
        {
            normalised = normalised.Replace("//", "/", StringComparison.Ordinal);
        }
        if (normalised.Length == 0)
        {
            return null;
        }

        // Reject path traversal segments anywhere in the path. Same
        // protection CanonicalizeFolder gives us, applied directly
        // here so we don't have to route through it (which would
        // reject .notesapp/ paths and lock us out of templates).
        var segments = normalised.Split('/');
        foreach (var seg in segments)
        {
            if (seg == "." || seg == ".." || seg.Length == 0)
            {
                return null;
            }
            // Reject segments containing characters that aren't
            // valid in either Windows or Linux filenames. Slashes
            // were already split out; everything else passes through
            // and Path.GetFullPath would reject anything dangerous
            // anyway, but cheap to check up-front.
            foreach (var invalid in Path.GetInvalidFileNameChars())
            {
                if (seg.Contains(invalid))
                {
                    return null;
                }
            }
        }

        // The .assets/ membership check is the LOAD-BEARING safety
        // rule for this endpoint: an asset path MUST contain a
        // ".assets/" segment, so the only files reachable through
        // this method are inside such a folder. Without this, a
        // caller could ask for .notesapp/index.db, server.db, or
        // any other vault-internal file.
        if (!normalised.Contains($"{AssetsFolderSuffix}/", StringComparison.Ordinal))
        {
            return null;
        }

        // For template-asset paths, also require the prefix shape
        // .notesapp/templates/ to exist. Belt-and-braces: the .assets/
        // check above already guarantees the suffix part, but checking
        // the prefix means a caller can't smuggle a non-template path
        // that happens to contain ".assets/" somewhere.
        if (normalised.StartsWith(".notesapp/", StringComparison.Ordinal) &&
            !normalised.StartsWith(".notesapp/templates/", StringComparison.Ordinal))
        {
            return null;
        }

        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);

        // Resolve the path manually rather than via INotePathResolver
        // (which would reject .notesapp/...). The Path.GetFullPath +
        // IsUnder check below is the same anti-traversal guard
        // INotePathResolver applies internally.
        var rootFull = Path.GetFullPath(vaultRoot);
        var combined = Path.Combine(rootFull, normalised.Replace('/', Path.DirectorySeparatorChar));
        var absolute = Path.GetFullPath(combined);

        if (!IsUnderRoot(absolute, rootFull))
        {
            return null;
        }

        if (!File.Exists(absolute))
        {
            return null;
        }

        var size = new FileInfo(absolute).Length;
        var contentType = AssetFileHelpers.MimeFromExtension(Path.GetExtension(absolute));
        return new AssetFile(absolute, contentType, size);
    }

    /// <summary>
    /// Same is-this-path-under-the-root check INotePathResolver does
    /// internally. Inlined here because we resolve template-asset
    /// paths without going through that resolver (it would reject
    /// the leading .notesapp segment).
    /// </summary>
    private static bool IsUnderRoot(string candidate, string rootFull)
    {
        // Path.GetFullPath has already normalised both. Trailing
        // separator on the root makes string.StartsWith correct
        // (without it, "/vaultA" would match "/vaultAB").
        var rootWithSep = rootFull.EndsWith(Path.DirectorySeparatorChar)
            ? rootFull
            : rootFull + Path.DirectorySeparatorChar;
        return candidate.Equals(rootFull.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)
            || candidate.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase);
    }

    // ============================================================== Lifecycle

    public async Task MoveAlongsideNoteAsync(
        Guid vaultId,
        string oldNotePath,
        string newNotePath,
        CancellationToken ct = default)
    {
        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);

        var oldAssets = AssetsFolderForNote(vaultRoot, oldNotePath);
        if (!Directory.Exists(oldAssets))
        {
            return;     // no-op
        }
        var newAssets = AssetsFolderForNote(vaultRoot, newNotePath);
        if (Directory.Exists(newAssets))
        {
            // Edge case: target assets folder already exists.
            // Don't merge — that's surprising. Caller should have
            // validated newNotePath doesn't collide before calling.
            // Best we can do here is throw so the caller can decide.
            throw new AssetException(
                "An assets folder already exists at the new note location.",
                statusCode: 409);
        }

        var newAssetsParent = Path.GetDirectoryName(newAssets);
        if (!string.IsNullOrEmpty(newAssetsParent))
        {
            Directory.CreateDirectory(newAssetsParent);
        }

        Directory.Move(oldAssets, newAssets);
    }

    public async Task TrashAlongsideNoteAsync(
        Guid vaultId,
        string notePath,
        string trashRelativeFolder,
        CancellationToken ct = default)
    {
        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);
        var sourceAssets = AssetsFolderForNote(vaultRoot, notePath);
        if (!Directory.Exists(sourceAssets))
        {
            return;     // no assets to trash
        }

        // Trash root is .notesapp/trash. We mirror the assets folder
        // name there but suffixed with a timestamp (mirroring how
        // NoteService trashes notes) so concurrent deletes don't
        // collide.
        var trashRoot = Path.Combine(vaultRoot, ".notesapp", "trash");
        Directory.CreateDirectory(trashRoot);

        var sourceFolderName = Path.GetFileName(sourceAssets);
        var stamped = $"{sourceFolderName}.{DateTime.UtcNow:yyyyMMddHHmmss}";

        // The caller passes in trashRelativeFolder so we can keep
        // the assets next to the trashed note (matches Note's own
        // trash convention). For now we keep it simple: drop in
        // trash root with a timestamped name.
        _ = trashRelativeFolder; // reserved for future per-note-trash layout

        var destination = Path.Combine(trashRoot, stamped);
        try
        {
            Directory.Move(sourceAssets, destination);
        }
        catch
        {
            // Trash failure is non-fatal — note is already deleted.
            // Leave the assets where they are; a future cleanup job
            // can sweep them.
        }
    }

    // ============================================================== Helpers

    private async Task<string> ResolveVaultRootAsync(Guid vaultId, CancellationToken ct)
    {
        var vault = await _db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Path })
            .FirstOrDefaultAsync(ct)
            ?? throw new AssetException("Vault not found.", statusCode: 404);
        return _vaultPaths.Resolve(vault.Path);
    }

    private string AssetsFolderForNote(string vaultRoot, string notePath)
    {
        var canonical = _notePaths.CanonicalizeNote(notePath);
        var noteAbsolute = _notePaths.Resolve(vaultRoot, canonical);
        var noteFile = Path.GetFileName(noteAbsolute);
        var basename = noteFile.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
            ? noteFile[..^3]
            : noteFile;
        var parent = Path.GetDirectoryName(noteAbsolute)!;
        return Path.Combine(parent, basename + AssetsFolderSuffix);
    }

    private static string parentOf(string path)
    {
        var idx = path.LastIndexOf('/');
        return idx < 0 ? "" : path[..idx];
    }

    private static string JoinCanonical(string parent, string folderName, string fileName)
    {
        if (string.IsNullOrEmpty(parent))
        {
            return $"{folderName}/{fileName}";
        }
        return $"{parent}/{folderName}/{fileName}";
    }
}

/// <summary>
/// Bound to the <c>Assets</c> section of <c>appsettings.json</c>.
/// </summary>
public sealed class AssetOptions
{
    /// <summary>
    /// Maximum size per uploaded file, in bytes. Default: 500 MB.
    /// </summary>
    public long MaxUploadBytes { get; set; } = 500L * 1024 * 1024;
}
