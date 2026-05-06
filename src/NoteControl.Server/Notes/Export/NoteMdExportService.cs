using System.IO.Compression;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using NoteControl.Server.Data;
using NoteControl.Server.Notes.Services;
using NoteControl.Server.Vaults.Services;

namespace NoteControl.Server.Notes.Export;

/// <summary>
/// Exports a single note as a zip archive containing the .md file
/// and its sibling <c>{basename}.assets/</c> folder (recursively, if
/// it exists). The zip is intentionally a *bag of files* — flat at
/// the root, no enclosing folder — because:
/// <list type="bullet">
///   <item>Round-tripping through the import endpoint then keeps
///     the asset references intact: the zip's <c>FooNote.md</c>
///     and <c>FooNote.assets/photo.png</c> sit at the same depth,
///     mirroring the on-disk vault layout.</item>
///   <item>Users extracting manually get a markdown file they can
///     drop into any other markdown tool without hunting through a
///     parent directory.</item>
/// </list>
/// <para>
/// If the note has no assets folder, the result is still a zip
/// (containing only the .md). Choosing zip-always-on-md-export over
/// "raw .md when there are no assets" keeps the frontend simple
/// (one filename pattern, one Content-Disposition) and the user can
/// always extract a single .md from a zip in two clicks.
/// </para>
/// </summary>
public interface INoteMdExportService
{
    /// <summary>
    /// Build the export archive for the note at <paramref name="notePath"/>.
    /// Returns the bytes plus the suggested filename (without the .zip
    /// extension; the endpoint adds it).
    /// </summary>
    Task<NoteExport> ExportMarkdownZipAsync(
        Guid vaultId,
        string notePath,
        CancellationToken ct = default);
}

public sealed class NoteMdExportService : INoteMdExportService
{
    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;
    private readonly INotePathResolver _notePaths;
    private readonly ILogger<NoteMdExportService> _log;

    public NoteMdExportService(
        ServerDbContext db,
        IVaultPathResolver vaultPaths,
        INotePathResolver notePaths,
        ILogger<NoteMdExportService> log)
    {
        _db = db;
        _vaultPaths = vaultPaths;
        _notePaths = notePaths;
        _log = log;
    }

    public async Task<NoteExport> ExportMarkdownZipAsync(
        Guid vaultId,
        string notePath,
        CancellationToken ct = default)
    {
        // ---- 1. Resolve note + vault root -------------------------------
        // Mirrors NoteExportService's first stage. We could share, but
        // duplicating the half-dozen lines keeps the two services
        // independent — md export has zero docx-rendering dependencies
        // and shouldn't pull them in transitively.
        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);

        string canonical, absolute;
        try
        {
            canonical = _notePaths.CanonicalizeNote(notePath);
            absolute = _notePaths.Resolve(vaultRoot, canonical);
        }
        catch (InvalidNotePathException ex)
        {
            throw new NoteException(ex.Message);
        }

        if (!File.Exists(absolute))
        {
            throw new NoteException("Note not found.", statusCode: 404);
        }

        // ---- 2. Collect entries ----------------------------------------
        // Two streams of zip content:
        //   (a) the note .md itself, at the basename of the canonical
        //       path so a flat unzip drops a sensible filename next to
        //       you;
        //   (b) every file under the sibling <basename>.assets/ folder,
        //       preserving subpaths under that folder as zip entry paths.
        //
        // We deliberately do not attempt to rewrite asset references in
        // the markdown body. The on-disk references already use the
        // basename-relative form (`![](MyNote.assets/photo.png)`) — the
        // zip preserves that exact layout, so the references resolve
        // identically when re-imported.
        var noteFileName = Path.GetFileName(absolute);              // "MyNote.md"
        var noteBaseName = Path.GetFileNameWithoutExtension(absolute); // "MyNote"
        var noteParentAbs = Path.GetDirectoryName(absolute) ?? vaultRoot;
        var assetsFolderAbs = Path.Combine(noteParentAbs, noteBaseName + ".assets");

        // Stream-build directly into a MemoryStream so we don't have
        // to size up-front. For typical notes (KB body + a handful of
        // PNGs) this is a few MB at most; if a vault grows assets into
        // GB territory we'd want to flip to a streaming response, but
        // that's a rebuild for a later day.
        var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            // (a) the .md, by itself, at the zip root.
            await CopyFileToZipAsync(zip, absolute, noteFileName, ct);

            // (b) the .assets/ folder, recursively, if present.
            // Existence check is cheap — a missing assets folder is the
            // common case for notes that have never had an image pasted.
            if (Directory.Exists(assetsFolderAbs))
            {
                // Enumerate every file under .assets/ (including
                // sub-subdirectories — there normally aren't any, but
                // a manual user nest still round-trips).
                foreach (var assetAbs in Directory.EnumerateFiles(
                             assetsFolderAbs, "*", SearchOption.AllDirectories))
                {
                    ct.ThrowIfCancellationRequested();
                    // Build the zip entry name as: "<basename>.assets/<sub-rel>".
                    // Path.GetRelativePath gives platform-native separators;
                    // zip entries always use forward slashes.
                    var rel = Path.GetRelativePath(assetsFolderAbs, assetAbs)
                        .Replace(Path.DirectorySeparatorChar, '/')
                        .Replace(Path.AltDirectorySeparatorChar, '/');
                    var entryName = noteBaseName + ".assets/" + rel;

                    await CopyFileToZipAsync(zip, assetAbs, entryName, ct);
                }
            }
        }

        return new NoteExport(ms.ToArray(), noteBaseName);
    }

    private static async Task CopyFileToZipAsync(
        ZipArchive zip,
        string sourceAbs,
        string entryName,
        CancellationToken ct)
    {
        // CompressionLevel.Optimal keeps text-y notes small without
        // measurable CPU pain at the volumes we expect.
        var entry = zip.CreateEntry(entryName, CompressionLevel.Optimal);

        // Preserve file mtime in the zip metadata. Not load-bearing
        // for behaviour, but lets archive viewers show realistic
        // timestamps and helps if a user inspects the zip outside
        // the app.
        var fi = new FileInfo(sourceAbs);
        if (fi.Exists)
        {
            entry.LastWriteTime = fi.LastWriteTime;
        }

        await using var src = File.OpenRead(sourceAbs);
        await using var dst = entry.Open();
        await src.CopyToAsync(dst, ct);
    }

    private async Task<string> ResolveVaultRootAsync(Guid vaultId, CancellationToken ct)
    {
        var vault = await _db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Path })
            .FirstOrDefaultAsync(ct)
            ?? throw new NoteException("Vault not found.", statusCode: 404);

        return _vaultPaths.Resolve(vault.Path);
    }
}
