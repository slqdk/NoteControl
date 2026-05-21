using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using NoteControl.Server.Assets.Services;
using NoteControl.Server.Data;
using NoteControl.Server.Notes.Services;
using NoteControl.Server.Vaults.Services;

namespace NoteControl.Server.Folders.Services;

/// <summary>
/// Per-folder cover image storage.
///
/// One cover image per folder, stored as a hidden dotfile at the
/// folder's root: <c>&lt;folder&gt;/.folder-cover.&lt;ext&gt;</c>. The vault
/// root is a folder too — its cover lives at the vault root.
///
/// Why a dotfile inside the folder rather than a centralised
/// <c>.notesapp/folder-covers/...</c> store?
/// <list type="bullet">
///   <item><description>Move-with-folder for free. <see cref="FolderService.MoveAsync"/>
///     calls <see cref="Directory.Move"/>; the cover comes along because
///     it's IN the folder. No descendant-cover sync logic required.</description></item>
///   <item><description>Vault portability stays intact — copying a vault
///     folder elsewhere brings every cover with it.</description></item>
///   <item><description>No effect on folder listings: the listing code only
///     enumerates <c>*.md</c> files and non-<c>.notesapp</c>/<c>.assets</c>
///     subdirectories. A <c>.folder-cover.png</c> is invisible to listings.</description></item>
///   <item><description>No effect on the "is folder empty" check that
///     gates delete: it only counts <c>*.md</c> files and non-<c>.notesapp</c>
///     subfolders. A cover-only folder is still deletable; the cover gets
///     nuked along with the folder. Sensible.</description></item>
/// </list>
///
/// Image-only policy enforced server-side: PNG/JPEG/GIF/WebP/BMP/SVG.
/// Same limit set as note assets via <see cref="AssetOptions.MaxUploadBytes"/>.
///
/// Path safety: every write/read here resolves the folder path through
/// <see cref="INotePathResolver.ResolveFolder"/> (anti-traversal,
/// rejects <c>.notesapp</c> etc.) and then composes the cover file
/// name onto the resolved directory. We never combine raw user input
/// with the vault root.
/// </summary>
public sealed class FolderCoverService : IFolderCoverService
{
    /// <summary>
    /// Hidden filename stem. Extension determined per-upload from the
    /// uploaded image's content type.
    /// </summary>
    private const string CoverFileStem = ".folder-cover";

    /// <summary>
    /// Image extensions the server accepts. Lower-case, no leading dot.
    /// Mirrors the template-asset image policy.
    /// </summary>
    private static readonly HashSet<string> AcceptedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"
    };

    /// <summary>
    /// Same content-type allow-list the template asset endpoint uses.
    /// Browsers and platforms vary on what they send for SVG so we
    /// accept both <c>image/svg+xml</c> and the unqualified form.
    /// </summary>
    private static readonly HashSet<string> AcceptedContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/gif",
        "image/webp",
        "image/bmp",
        "image/svg+xml",
        "image/svg",
    };

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;
    private readonly INotePathResolver _notePaths;
    private readonly AssetOptions _options;

    public FolderCoverService(
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

    // ============================================================== Probe

    /// <inheritdoc/>
    public bool TryGetExistingCover(
        string vaultRoot,
        string canonicalFolderPath,
        out string absolutePath,
        out DateTime lastWriteUtc)
    {
        absolutePath = string.Empty;
        lastWriteUtc = default;

        string folderAbsolute;
        try
        {
            folderAbsolute = _notePaths.ResolveFolder(vaultRoot, canonicalFolderPath);
        }
        catch (InvalidNotePathException)
        {
            return false;
        }

        if (!Directory.Exists(folderAbsolute))
        {
            return false;
        }

        // We don't know which extension the user uploaded, so scan the
        // accepted set. There should be at most one file matching;
        // upload deletes prior siblings to prevent ambiguity.
        foreach (var ext in AcceptedExtensions)
        {
            var candidate = Path.Combine(folderAbsolute, $"{CoverFileStem}.{ext}");
            if (File.Exists(candidate))
            {
                absolutePath = candidate;
                lastWriteUtc = File.GetLastWriteTimeUtc(candidate);
                return true;
            }
        }

        return false;
    }

    // ============================================================== Get

    public async Task<FolderCoverFile?> GetAsync(
        Guid vaultId,
        string canonicalFolderPath,
        CancellationToken ct = default)
    {
        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);

        if (!TryGetExistingCover(vaultRoot, canonicalFolderPath, out var absolute, out _))
        {
            return null;
        }

        var size = new FileInfo(absolute).Length;
        var contentType = AssetFileHelpers.MimeFromExtension(Path.GetExtension(absolute));
        return new FolderCoverFile(absolute, contentType, size);
    }

    // ============================================================== Save

    public async Task<FolderCoverInfo> SaveAsync(
        Guid vaultId,
        string canonicalFolderPath,
        string originalFileName,
        string contentType,
        Stream content,
        long contentLength,
        CancellationToken ct = default)
    {
        // Size check before any disk work.
        if (contentLength > _options.MaxUploadBytes)
        {
            throw new FolderCoverException(
                $"Image too large. Max upload is {_options.MaxUploadBytes:N0} bytes.",
                statusCode: 413);
        }

        // Validate content type. Image-only.
        var normalisedContentType = (contentType ?? string.Empty).Split(';', 2)[0].Trim();
        if (!AcceptedContentTypes.Contains(normalisedContentType))
        {
            throw new FolderCoverException(
                "Cover must be an image (PNG, JPEG, GIF, WebP, BMP, or SVG).",
                statusCode: 415);
        }

        // Pick an extension from the file's name, falling back to one
        // derived from the content type if the name has nothing usable.
        // We only persist accepted extensions (image-only enforcement);
        // anything else gets rejected here.
        var ext = ExtensionFor(originalFileName, normalisedContentType);
        if (ext is null)
        {
            throw new FolderCoverException(
                "Unsupported image format. Use PNG, JPEG, GIF, WebP, BMP, or SVG.",
                statusCode: 415);
        }

        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);

        string folderAbsolute;
        try
        {
            folderAbsolute = _notePaths.ResolveFolder(vaultRoot, canonicalFolderPath);
        }
        catch (InvalidNotePathException ex)
        {
            throw new FolderCoverException(ex.Message, statusCode: 400);
        }

        if (!Directory.Exists(folderAbsolute))
        {
            throw new FolderCoverException("Folder does not exist.", statusCode: 404);
        }

        // Stream-copy to a temp file first, then atomically replace
        // any prior cover. The two-step pattern matches AssetService —
        // an aborted upload never leaves a half-written cover at the
        // final path.
        var finalAbsolute = Path.Combine(folderAbsolute, $"{CoverFileStem}.{ext}");
        var tempAbsolute = finalAbsolute + ".uploading";

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
                throw new FolderCoverException(
                    $"Image too large. Max upload is {_options.MaxUploadBytes:N0} bytes.",
                    statusCode: 413);
            }

            // Remove any prior cover of a different extension so we
            // only ever have one .folder-cover.* in the folder. Done
            // BEFORE the final move so we never leave the folder with
            // two covers if something fails between steps.
            DeletePriorCovers(folderAbsolute, except: $"{CoverFileStem}.{ext}");

            // Atomic on the same drive. If a cover already exists at
            // finalAbsolute (same extension as before), File.Move
            // without overwrite would throw; we delete first.
            if (File.Exists(finalAbsolute))
            {
                File.Delete(finalAbsolute);
            }
            File.Move(tempAbsolute, finalAbsolute);
        }
        catch
        {
            // Clean up the temp file on any failure.
            try { if (File.Exists(tempAbsolute)) File.Delete(tempAbsolute); } catch { /* swallow */ }
            throw;
        }

        var info = new FileInfo(finalAbsolute);
        return new FolderCoverInfo(
            SizeBytes: info.Length,
            ContentType: AssetFileHelpers.MimeFromExtension(ext),
            LastWriteUtc: info.LastWriteTimeUtc);
    }

    // ============================================================== Delete

    public async Task<bool> DeleteAsync(
        Guid vaultId,
        string canonicalFolderPath,
        CancellationToken ct = default)
    {
        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);

        string folderAbsolute;
        try
        {
            folderAbsolute = _notePaths.ResolveFolder(vaultRoot, canonicalFolderPath);
        }
        catch (InvalidNotePathException ex)
        {
            throw new FolderCoverException(ex.Message, statusCode: 400);
        }

        if (!Directory.Exists(folderAbsolute))
        {
            throw new FolderCoverException("Folder does not exist.", statusCode: 404);
        }

        var deletedAny = false;
        foreach (var ext in AcceptedExtensions)
        {
            var candidate = Path.Combine(folderAbsolute, $"{CoverFileStem}.{ext}");
            if (File.Exists(candidate))
            {
                try
                {
                    File.Delete(candidate);
                    deletedAny = true;
                }
                catch
                {
                    // Best-effort: a sharing violation here means the
                    // file is still there — surface as a generic 500
                    // by letting the exception bubble. Most real
                    // platforms allow delete-of-open-file though.
                    throw;
                }
            }
        }

        return deletedAny;
    }

    // ============================================================== Helpers

    private static void DeletePriorCovers(string folderAbsolute, string except)
    {
        foreach (var ext in AcceptedExtensions)
        {
            var name = $"{CoverFileStem}.{ext}";
            if (string.Equals(name, except, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            var candidate = Path.Combine(folderAbsolute, name);
            if (File.Exists(candidate))
            {
                try { File.Delete(candidate); } catch { /* best-effort */ }
            }
        }
    }

    /// <summary>
    /// Pick an extension to persist. Prefer the original filename's
    /// extension if it's accepted; otherwise fall back to a content-
    /// type-derived one. Returns null if neither yields an accepted
    /// extension — callers map that to 415.
    /// </summary>
    private static string? ExtensionFor(string? originalFileName, string contentType)
    {
        if (!string.IsNullOrEmpty(originalFileName))
        {
            var fromName = Path.GetExtension(originalFileName).TrimStart('.').ToLowerInvariant();
            if (AcceptedExtensions.Contains(fromName))
            {
                // Normalise jpg vs jpeg to a single on-disk form so we
                // don't end up with two covers if a user uploads each
                // in sequence. (Not strictly necessary — DeletePriorCovers
                // handles the cleanup — but having the on-disk name match
                // a predictable case-set keeps backups + manual inspection
                // tidier.)
                return fromName == "jpeg" ? "jpg" : fromName;
            }
        }

        return contentType.ToLowerInvariant() switch
        {
            "image/png" => "png",
            "image/jpeg" or "image/jpg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/bmp" => "bmp",
            "image/svg+xml" or "image/svg" => "svg",
            _ => null,
        };
    }

    private async Task<string> ResolveVaultRootAsync(Guid vaultId, CancellationToken ct)
    {
        var vault = await _db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Path })
            .FirstOrDefaultAsync(ct)
            ?? throw new FolderCoverException("Vault not found.", statusCode: 404);
        return _vaultPaths.Resolve(vault.Path);
    }
}
