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
/// Path safety: every user-supplied path goes through
/// <see cref="INotePathResolver"/> which canonicalises and rejects
/// path traversal, absolute paths, and the reserved
/// <c>.notesapp/</c> subtree. We never combine raw user strings
/// with the vault root.
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
        var safeName = SanitiseFileName(originalFileName);
        if (string.IsNullOrWhiteSpace(safeName))
        {
            safeName = "file";
        }

        // Resolve collisions: foo.png → foo-2.png → foo-3.png ...
        var storedName = NextAvailableName(assetsAbsolute, safeName);
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
        var relativeMarkdownPath = $"{UrlEncodeSegment(assetsFolderName)}/{UrlEncodeSegment(storedName)}";

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

        // We don't use CanonicalizeNote here because asset files
        // aren't .md. Reuse CanonicalizeFolder which validates
        // path-traversal but doesn't enforce extensions.
        string canonicalAsset;
        try
        {
            canonicalAsset = _notePaths.CanonicalizeFolder(assetPath);
        }
        catch (InvalidNotePathException)
        {
            return null;
        }

        // Extra safety: reject anything that escapes the assets
        // convention. An asset path must contain a ".assets/"
        // segment somewhere — otherwise it's some other vault file
        // we don't intend to serve via this endpoint.
        if (!canonicalAsset.Contains($"{AssetsFolderSuffix}/", StringComparison.Ordinal))
        {
            return null;
        }

        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);
        var absolute = _notePaths.ResolveFolder(vaultRoot, canonicalAsset);

        if (!File.Exists(absolute))
        {
            return null;
        }

        var size = new FileInfo(absolute).Length;
        var contentType = MimeFromExtension(Path.GetExtension(absolute));
        return new AssetFile(absolute, contentType, size);
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

    /// <summary>
    /// Strip path separators and characters Windows / Linux
    /// can't use in filenames. Keep dots, dashes, underscores,
    /// spaces — anything reasonable.
    /// </summary>
    private static string SanitiseFileName(string raw)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var sb = new System.Text.StringBuilder(raw.Length);
        foreach (var c in raw)
        {
            if (Array.IndexOf(invalid, c) < 0 && c != '/' && c != '\\')
            {
                sb.Append(c);
            }
        }
        var result = sb.ToString().Trim().TrimStart('.');
        return result;
    }

    /// <summary>
    /// Find a non-colliding filename in the target folder.
    /// "image.png" → "image.png" if free, else "image-2.png",
    /// "image-3.png", ... up to a sane upper bound.
    /// </summary>
    private static string NextAvailableName(string folder, string desired)
    {
        var path = Path.Combine(folder, desired);
        if (!File.Exists(path))
        {
            return desired;
        }

        var stem = Path.GetFileNameWithoutExtension(desired);
        var ext = Path.GetExtension(desired);
        for (int i = 2; i < 10_000; i++)
        {
            var candidate = $"{stem}-{i}{ext}";
            if (!File.Exists(Path.Combine(folder, candidate)))
            {
                return candidate;
            }
        }
        // Fallback — astronomically unlikely. Use a timestamp.
        return $"{stem}-{DateTime.UtcNow:yyyyMMddHHmmssfff}{ext}";
    }

    private static string parentOf(string path)
    {
        var idx = path.LastIndexOf('/');
        return idx < 0 ? "" : path[..idx];
    }

    /// <summary>
    /// URL-encode a single path segment (folder or filename) for use
    /// inside markdown image/link syntax. Uses
    /// <see cref="Uri.EscapeDataString"/> which encodes spaces as
    /// <c>%20</c> and handles other reserved characters per RFC 3986.
    /// We escape DATA (the segment) not a full URL — slashes are not
    /// part of the input here.
    ///
    /// CommonMark's image syntax <c>![alt](url)</c> ends the URL at
    /// the first unescaped space, so any segment containing a space
    /// MUST be encoded for the markdown to round-trip correctly
    /// through load → save → reload.
    /// </summary>
    private static string UrlEncodeSegment(string segment)
    {
        return Uri.EscapeDataString(segment);
    }

    private static string JoinCanonical(string parent, string folderName, string fileName)
    {
        if (string.IsNullOrEmpty(parent))
        {
            return $"{folderName}/{fileName}";
        }
        return $"{parent}/{folderName}/{fileName}";
    }

    /// <summary>
    /// Map a file extension to a MIME type for the Content-Type
    /// response header. Conservative list — anything unknown gets
    /// <c>application/octet-stream</c> which the browser handles
    /// as a download.
    /// </summary>
    private static string MimeFromExtension(string extension)
    {
        var ext = extension.ToLowerInvariant().TrimStart('.');
        return ext switch
        {
            "png" => "image/png",
            "jpg" or "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "svg" => "image/svg+xml",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            "mkv" => "video/x-matroska",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "ogg" => "audio/ogg",
            "pdf" => "application/pdf",
            "txt" => "text/plain",
            "md" => "text/markdown",
            "json" => "application/json",
            "xml" => "application/xml",
            "csv" => "text/csv",
            "doc" => "application/msword",
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xls" => "application/vnd.ms-excel",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "ppt" => "application/vnd.ms-powerpoint",
            "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "zip" => "application/zip",
            _ => "application/octet-stream",
        };
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
