using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Data;
using NoteControl.Server.Notes.Services;
using NoteControl.Server.Search.Services;
using NoteControl.Server.Vaults.Services;

namespace NoteControl.Server.Folders.Services;

/// <summary>
/// Default <see cref="IFolderService"/>. Operates directly on the
/// filesystem; folders aren't in the database.
///
/// Path safety: relies on <see cref="INotePathResolver.ResolveFolder"/>
/// to canonicalise + reject path traversal (<c>..</c>, absolute paths,
/// <c>.notesapp</c> as a segment). All write operations route through
/// it; we never combine raw user strings with the vault root.
/// </summary>
public sealed class FolderService : IFolderService
{
    /// <summary>
    /// Marker file written inside an empty folder so it survives
    /// directory-existence checks. Lives under <c>.notesapp/</c> so it
    /// doesn't appear in user-facing folder listings (the listing code
    /// already filters that subtree out).
    /// </summary>
    private const string MarkerRelative = ".notesapp/folder-marker";

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;
    private readonly INotePathResolver _notePaths;
    private readonly IIndexService _index;

    public FolderService(
        ServerDbContext db,
        IVaultPathResolver vaultPaths,
        INotePathResolver notePaths,
        IIndexService index)
    {
        _db = db;
        _vaultPaths = vaultPaths;
        _notePaths = notePaths;
        _index = index;
    }

    public async Task CreateAsync(Guid vaultId, string canonicalPath, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(canonicalPath))
        {
            throw new FolderException("Folder path is required.");
        }

        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);

        // ResolveFolder canonicalises and rejects path traversal etc.
        // Throws InvalidNotePathException which we catch and remap.
        string absoluteFolder;
        try
        {
            absoluteFolder = _notePaths.ResolveFolder(vaultRoot, canonicalPath);
        }
        catch (InvalidNotePathException ex)
        {
            throw new FolderException(ex.Message, statusCode: 400);
        }

        // If a *file* exists at this exact path we have a name collision —
        // the user can't have a note "Projects.md" AND a folder "Projects"
        // at the same parent because path lookups would be ambiguous.
        // (Strictly the two have different names, but a defensive check.)
        if (File.Exists(absoluteFolder))
        {
            throw new FolderException(
                "A file already exists at that path; choose a different folder name.",
                statusCode: 409);
        }

        // Create the directory + marker file. CreateDirectory is a no-op
        // if it already exists, so this is idempotent.
        Directory.CreateDirectory(absoluteFolder);

        var markerAbsolute = Path.Combine(absoluteFolder, MarkerRelative.Replace('/', Path.DirectorySeparatorChar));
        var markerDir = Path.GetDirectoryName(markerAbsolute)!;
        Directory.CreateDirectory(markerDir);

        // Write the marker only if it doesn't exist — preserves any
        // contents the user may have already written there manually.
        if (!File.Exists(markerAbsolute))
        {
            await File.WriteAllTextAsync(
                markerAbsolute,
                "This file marks the folder as intentionally created. Safe to delete if the folder has notes.\n",
                ct);
        }
    }

    public async Task DeleteAsync(Guid vaultId, string canonicalPath, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(canonicalPath))
        {
            throw new FolderException("Folder path is required.");
        }

        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);

        string absoluteFolder;
        try
        {
            absoluteFolder = _notePaths.ResolveFolder(vaultRoot, canonicalPath);
        }
        catch (InvalidNotePathException ex)
        {
            throw new FolderException(ex.Message, statusCode: 400);
        }

        if (!Directory.Exists(absoluteFolder))
        {
            throw new FolderException("Folder does not exist.", statusCode: 404);
        }

        // Refuse if there's any user-visible content. We walk the folder
        // looking for any .md files OR any non-`.notesapp` subdirectories.
        // The marker file is fine — that's how empty folders are realised.
        if (HasUserVisibleContent(absoluteFolder))
        {
            throw new FolderException(
                "Folder is not empty. Delete or move its notes and subfolders first.",
                statusCode: 409);
        }

        // Safe to nuke. Recursive delete because of the .notesapp marker
        // subfolder; nothing user-visible will be lost.
        Directory.Delete(absoluteFolder, recursive: true);

        // No-op for cancellation — we made a synchronous filesystem call.
        await Task.CompletedTask;
    }

    public async Task MoveAsync(
        Guid vaultId,
        string oldCanonicalPath,
        string newCanonicalPath,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(oldCanonicalPath))
        {
            throw new FolderException("Source folder path is required.");
        }
        if (string.IsNullOrWhiteSpace(newCanonicalPath))
        {
            throw new FolderException("Destination folder path is required.");
        }

        // Same path — no-op.
        if (string.Equals(oldCanonicalPath, newCanonicalPath, StringComparison.Ordinal))
        {
            return;
        }

        // Refuse moving a folder into itself or one of its descendants.
        // Without this check Directory.Move would throw a confusing
        // platform-specific error, and on some filesystems could leave
        // the tree in a partially-moved state.
        if (newCanonicalPath.StartsWith(oldCanonicalPath + "/", StringComparison.Ordinal))
        {
            throw new FolderException(
                "Cannot move a folder into itself or its own subtree.",
                statusCode: 400);
        }

        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);

        string absoluteOld;
        string absoluteNew;
        try
        {
            absoluteOld = _notePaths.ResolveFolder(vaultRoot, oldCanonicalPath);
            absoluteNew = _notePaths.ResolveFolder(vaultRoot, newCanonicalPath);
        }
        catch (InvalidNotePathException ex)
        {
            throw new FolderException(ex.Message, statusCode: 400);
        }

        if (!Directory.Exists(absoluteOld))
        {
            throw new FolderException("Source folder does not exist.", statusCode: 404);
        }
        if (Directory.Exists(absoluteNew))
        {
            throw new FolderException(
                "A folder already exists at the destination path.",
                statusCode: 409);
        }
        if (File.Exists(absoluteNew))
        {
            throw new FolderException(
                "A file exists at the destination path; pick a different name.",
                statusCode: 409);
        }

        // Capture the old paths of every .md file so we can delete them
        // from the index after the rename succeeds. Path enumeration
        // BEFORE the move because afterwards the old path is gone.
        var oldNotePaths = EnumerateNotesUnder(absoluteOld, vaultRoot);

        // Make sure the destination's parent directory exists.
        var newParent = Path.GetDirectoryName(absoluteNew);
        if (!string.IsNullOrEmpty(newParent))
        {
            Directory.CreateDirectory(newParent);
        }

        // The actual move. Atomic on the same drive; throws on cross-drive
        // (vaults are documented as single-drive so we don't fall back).
        Directory.Move(absoluteOld, absoluteNew);

        // Index sync: drop old paths, re-index new ones.
        // Errors here are logged-not-thrown territory; the move
        // already succeeded on disk. We catch each operation
        // individually so one bad row doesn't sink the rest.
        foreach (var oldNotePath in oldNotePaths)
        {
            try
            {
                await _index.DeleteAsync(vaultId, oldNotePath, ct);
            }
            catch
            {
                // Index out of sync; rebuild will recover.
            }
        }

        foreach (var newNoteAbsolute in EnumerateNoteAbsolutePathsUnder(absoluteNew))
        {
            try
            {
                var canonical = Path.GetRelativePath(vaultRoot, newNoteAbsolute).Replace('\\', '/');
                var indexed = NoteFileReader.Read(newNoteAbsolute, canonical);
                await _index.UpsertAsync(vaultId, indexed, ct);
            }
            catch
            {
                // Same — rebuild will recover.
            }
        }
    }

    /// <summary>
    /// Pre-move helper: list every <c>.md</c> file's canonical relative
    /// path under the source folder so we can drop them from the index
    /// after the directory moves. Skips <c>.notesapp/</c>.
    /// </summary>
    private static List<string> EnumerateNotesUnder(string absoluteFolder, string vaultRoot)
    {
        var paths = new List<string>();
        if (!Directory.Exists(absoluteFolder))
        {
            return paths;
        }

        var enumOpts = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
        };

        foreach (var fullPath in Directory.EnumerateFiles(absoluteFolder, "*.md", enumOpts))
        {
            var relative = Path.GetRelativePath(vaultRoot, fullPath).Replace('\\', '/');
            if (relative.StartsWith(".notesapp/", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            paths.Add(relative);
        }
        return paths;
    }

    /// <summary>
    /// Post-move helper: enumerate absolute paths under the destination
    /// for re-indexing. Caller converts to canonical paths.
    /// </summary>
    private static IEnumerable<string> EnumerateNoteAbsolutePathsUnder(string absoluteFolder)
    {
        if (!Directory.Exists(absoluteFolder))
        {
            yield break;
        }

        var enumOpts = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
        };

        foreach (var fullPath in Directory.EnumerateFiles(absoluteFolder, "*.md", enumOpts))
        {
            // Skip .notesapp marker etc.
            var fileName = Path.GetFileName(fullPath);
            if (fullPath.Replace('\\', '/').Contains("/.notesapp/", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            yield return fullPath;
        }
    }

    /// <summary>
    /// Walk the folder shallowly looking for any reason to refuse
    /// deletion. Returns true if there's anything other than the
    /// <c>.notesapp/</c> marker subtree.
    /// </summary>
    private static bool HasUserVisibleContent(string absoluteFolder)
    {
        // Any .md file at any depth → not empty.
        var mdFiles = Directory.EnumerateFiles(absoluteFolder, "*.md", SearchOption.AllDirectories);
        if (mdFiles.Any())
        {
            return true;
        }

        // Any subfolder that isn't `.notesapp` → not empty.
        // (We could allow nested empty-marker folders too, but a folder
        // containing "another empty folder" is still meaningful nesting
        // the user probably wants to consciously delete.)
        foreach (var subdir in Directory.EnumerateDirectories(absoluteFolder))
        {
            var name = Path.GetFileName(subdir);
            if (!string.Equals(name, ".notesapp", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private async Task<string> ResolveVaultRootAsync(Guid vaultId, CancellationToken ct)
    {
        var vault = await _db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Path })
            .FirstOrDefaultAsync(ct)
            ?? throw new FolderException("Vault not found.", statusCode: 404);

        return _vaultPaths.Resolve(vault.Path);
    }
}
