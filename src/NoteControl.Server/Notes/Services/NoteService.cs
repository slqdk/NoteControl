using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Data;
using NoteControl.Server.Notes.Frontmatter;
using NoteControl.Server.Search.Services;
using NoteControl.Server.Vaults.Services;
using NoteControl.Shared.Notes;

namespace NoteControl.Server.Notes.Services;

/// <summary>
/// File CRUD on notes inside a vault. The caller has already cleared the
/// vault-role check (via RequireVault); this layer enforces path safety
/// inside the vault, frontmatter parsing/serialisation, and the trash /
/// asset-folder conventions on delete.
/// </summary>
public interface INoteService
{
    Task<NoteDto?> GetAsync(Guid vaultId, string notePath, CancellationToken ct = default);
    Task<NoteDto> CreateAsync(Guid vaultId, CreateNoteRequest request, CancellationToken ct = default);
    Task<NoteDto> UpdateAsync(Guid vaultId, string notePath, UpdateNoteRequest request, CancellationToken ct = default);
    Task DeleteAsync(Guid vaultId, string notePath, CancellationToken ct = default);

    /// <summary>
    /// Rename or relocate a note. Both paths are canonical (.md included).
    /// On success, also moves the sibling <c>{name}.assets/</c> folder if
    /// present, and re-indexes under the new path. Same source and
    /// destination is a no-op (returns the existing note).
    /// </summary>
    Task<NoteDto> MoveAsync(Guid vaultId, string oldPath, string newPath, CancellationToken ct = default);

    Task<FolderListingDto> ListFolderAsync(Guid vaultId, string folderPath, CancellationToken ct = default);
}

/// <summary>
/// Thrown to indicate a request the caller can fix. Mapped to HTTP status
/// codes by the endpoints layer.
/// </summary>
public sealed class NoteException : Exception
{
    public int StatusCode { get; }
    public NoteException(string message, int statusCode = 400) : base(message) { StatusCode = statusCode; }
}

public sealed class NoteService : INoteService
{
    private const int RecentlyUpdatedLimit = 10;
    private const string AppFolder = ".notesapp";
    private const string TrashFolder = "trash";

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;
    private readonly INotePathResolver _notePaths;
    private readonly TimeProvider _clock;
    private readonly INoteIndexer _indexer;

    public NoteService(
        ServerDbContext db,
        IVaultPathResolver vaultPaths,
        INotePathResolver notePaths,
        TimeProvider clock,
        INoteIndexer indexer)
    {
        _db = db;
        _vaultPaths = vaultPaths;
        _notePaths = notePaths;
        _clock = clock;
        _indexer = indexer;
    }

    public async Task<NoteDto?> GetAsync(Guid vaultId, string notePath, CancellationToken ct = default)
    {
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

        if (!File.Exists(absolute)) return null;

        var raw = await File.ReadAllTextAsync(absolute, Encoding.UTF8, ct);
        var (fm, body) = FrontmatterCodec.Split(raw);
        var info = new FileInfo(absolute);
        return new NoteDto(
            Path: canonical,
            Body: body,
            Frontmatter: fm.ToDto(),
            Etag: ComputeEtag(raw),
            LastModified: info.LastWriteTimeUtc);
    }

    public async Task<NoteDto> CreateAsync(Guid vaultId, CreateNoteRequest request, CancellationToken ct = default)
    {
        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);
        string canonical, absolute;
        try
        {
            canonical = _notePaths.CanonicalizeNote(request.Path);
            absolute = _notePaths.Resolve(vaultRoot, canonical);
        }
        catch (InvalidNotePathException ex)
        {
            throw new NoteException(ex.Message);
        }

        if (File.Exists(absolute))
        {
            throw new NoteException("A note already exists at that path.", statusCode: 409);
        }

        var now = _clock.GetUtcNow();
        var fm = new ParsedFrontmatter();
        FrontmatterCodec.ApplyUpdate(fm, now, request.Tags, newLocked: null);

        var fullText = FrontmatterCodec.Combine(fm, request.Body ?? string.Empty);

        // Ensure parent folder exists.
        var parent = Path.GetDirectoryName(absolute);
        if (!string.IsNullOrEmpty(parent))
        {
            Directory.CreateDirectory(parent);
        }

        await File.WriteAllTextAsync(absolute, fullText, NoBomUtf8, ct);

        var lastModified = new FileInfo(absolute).LastWriteTimeUtc;
        // Fire and forget into the indexer. NoteIndexer swallows errors so
        // a broken index can't fail a successful save.
        await _indexer.OnNoteSavedAsync(
            vaultId, canonical, fm, request.Body ?? string.Empty,
            new DateTimeOffset(lastModified, TimeSpan.Zero), ct);

        return new NoteDto(
            Path: canonical,
            Body: request.Body ?? string.Empty,
            Frontmatter: fm.ToDto(),
            Etag: ComputeEtag(fullText),
            LastModified: lastModified);
    }

    public async Task<NoteDto> UpdateAsync(
        Guid vaultId,
        string notePath,
        UpdateNoteRequest request,
        CancellationToken ct = default)
    {
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

        // Optimistic concurrency: if the client sent an ETag, refuse the
        // write if it no longer matches the on-disk file.
        var existingRaw = await File.ReadAllTextAsync(absolute, Encoding.UTF8, ct);
        if (!string.IsNullOrEmpty(request.Etag))
        {
            var currentEtag = ComputeEtag(existingRaw);
            if (!string.Equals(request.Etag, currentEtag, StringComparison.Ordinal))
            {
                throw new NoteException(
                    "The note was changed by someone else (or another device) since you opened it. " +
                    "Reload and try again.",
                    statusCode: 412);
            }
        }

        var (fm, _) = FrontmatterCodec.Split(existingRaw);
        FrontmatterCodec.ApplyUpdate(
            fm,
            _clock.GetUtcNow(),
            request.Tags,
            request.Locked,
            // Step 14: optional appearance overrides. ApplyUpdate handles
            // the sentinel semantics (empty string / 0 = clear).
            request.Font,
            request.FontSize,
            request.Width,
            // Ship 68: free-text version. Empty string resets to
            // DefaultVersion (not delete); null = leave alone. The
            // backfill of pre-Ship-68 notes is implicit: ApplyUpdate
            // ensures fm.Version is non-empty regardless of what we
            // pass in here.
            request.Version);

        var newText = FrontmatterCodec.Combine(fm, request.Body ?? string.Empty);
        await File.WriteAllTextAsync(absolute, newText, NoBomUtf8, ct);

        var lastModified = new FileInfo(absolute).LastWriteTimeUtc;
        await _indexer.OnNoteSavedAsync(
            vaultId, canonical, fm, request.Body ?? string.Empty,
            new DateTimeOffset(lastModified, TimeSpan.Zero), ct);

        return new NoteDto(
            Path: canonical,
            Body: request.Body ?? string.Empty,
            Frontmatter: fm.ToDto(),
            Etag: ComputeEtag(newText),
            LastModified: lastModified);
    }

    public async Task<NoteDto> MoveAsync(
        Guid vaultId,
        string oldPath,
        string newPath,
        CancellationToken ct = default)
    {
        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);

        // Canonicalise both paths so e.g. trailing-slash / mixed separators
        // get normalised the same way GetAsync expects.
        string oldCanonical, newCanonical, oldAbsolute, newAbsolute;
        try
        {
            oldCanonical = _notePaths.CanonicalizeNote(oldPath);
            newCanonical = _notePaths.CanonicalizeNote(newPath);
            oldAbsolute = _notePaths.Resolve(vaultRoot, oldCanonical);
            newAbsolute = _notePaths.Resolve(vaultRoot, newCanonical);
        }
        catch (InvalidNotePathException ex)
        {
            throw new NoteException(ex.Message);
        }

        if (!File.Exists(oldAbsolute))
        {
            throw new NoteException("Note not found.", statusCode: 404);
        }

        // Same source+destination → return the existing note as-is. The
        // tests treat this as success (no error, no move).
        if (string.Equals(oldCanonical, newCanonical, StringComparison.Ordinal))
        {
            var existing = await GetAsync(vaultId, oldCanonical, ct);
            return existing!;
        }

        if (File.Exists(newAbsolute) || Directory.Exists(newAbsolute))
        {
            throw new NoteException(
                "A note already exists at the destination path.",
                statusCode: 409);
        }

        // Make sure the destination's parent directory exists, otherwise
        // File.Move throws DirectoryNotFoundException.
        var newParent = Path.GetDirectoryName(newAbsolute);
        if (!string.IsNullOrEmpty(newParent))
        {
            Directory.CreateDirectory(newParent);
        }

        // The actual rename / move. Atomic on the same drive.
        File.Move(oldAbsolute, newAbsolute, overwrite: false);

        // Capture old/new basenames for the assets-folder rename and the
        // body rewrite below. Both happen only when the basename actually
        // changed; a pure folder relocation leaves image refs alone (they
        // stay relative to the note's NEW location, where the .assets
        // folder we just moved with it lives under the same name).
        var oldBasename = Path.GetFileNameWithoutExtension(oldAbsolute);
        var newBasename = Path.GetFileNameWithoutExtension(newAbsolute);
        var basenameChanged = !string.Equals(oldBasename, newBasename, StringComparison.Ordinal);

        // Move the sibling {name}.assets/ folder if present, so image
        // links inside the note keep working. Mirrors the convention in
        // DeleteAsync. We do this AFTER the .md move succeeds so a
        // failed .md move leaves the assets in place.
        var oldAssets = Path.Combine(
            Path.GetDirectoryName(oldAbsolute) ?? string.Empty,
            oldBasename + ".assets");
        if (Directory.Exists(oldAssets))
        {
            var newAssets = Path.Combine(
                Path.GetDirectoryName(newAbsolute) ?? string.Empty,
                newBasename + ".assets");
            try
            {
                Directory.Move(oldAssets, newAssets);
            }
            catch
            {
                // Asset folder rename failed; the note has already moved.
                // Acceptable inconsistency — image links inside the note
                // will 404 until the user manually fixes the folder name.
                // Better than rolling back the .md move.
            }
        }

        // Re-read the moved file so we get fresh frontmatter + size.
        var raw = await File.ReadAllTextAsync(newAbsolute, Encoding.UTF8, ct);
        var (fm, body) = FrontmatterCodec.Split(raw);

        // BUG FIX (Ship 46): on rename, rewrite image/link references
        // that point at the old `{oldBasename}.assets/` folder so they
        // match the renamed `{newBasename}.assets/` folder we just
        // moved above. Without this step, every image/asset in the
        // note 404s until the user manually edits the markdown — which
        // is also impossible from inside the editor since tiptap-markdown
        // hides the raw URLs behind rendered nodes.
        //
        // Only runs when the basename actually changed (relocations
        // alone don't break references). The rewriter is conservative:
        // it only matches the encoded folder name as a path segment
        // (i.e. followed by a slash), which avoids touching unrelated
        // text that happens to contain the old name as a substring.
        var rewroteBody = false;
        if (basenameChanged)
        {
            var rewritten = RewriteAssetReferences(body, oldBasename, newBasename);
            if (!ReferenceEquals(rewritten, body))
            {
                body = rewritten;
                rewroteBody = true;
            }
        }

        // If we rewrote the body, persist it. Don't touch frontmatter —
        // ApplyUpdate would bump `updated`, and a rename shouldn't count
        // as a content edit. We just rewrite the body inside the same
        // frontmatter block.
        if (rewroteBody)
        {
            var newText = FrontmatterCodec.Combine(fm, body);
            await File.WriteAllTextAsync(newAbsolute, newText, NoBomUtf8, ct);
            // Refresh raw so the ETag and FileInfo below see the rewrite.
            raw = newText;
        }

        var info = new FileInfo(newAbsolute);

        // Index sync: drop the old row, upsert under the new path.
        try
        {
            await _indexer.OnNoteDeletedAsync(vaultId, oldCanonical, ct);
        }
        catch
        {
            // Index out of sync; rebuild will recover.
        }

        try
        {
            await _indexer.OnNoteSavedAsync(
                vaultId, newCanonical, fm, body,
                new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero), ct);
        }
        catch
        {
            // Same — rebuild will recover.
        }

        return new NoteDto(
            Path: newCanonical,
            Body: body,
            Frontmatter: fm.ToDto(),
            Etag: ComputeEtag(raw),
            LastModified: info.LastWriteTimeUtc);
    }

    public async Task DeleteAsync(Guid vaultId, string notePath, CancellationToken ct = default)
    {
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

        // Move into .notesapp/trash/<original-relpath>-<timestamp>.md
        var stamp = _clock.GetUtcNow().ToString("yyyyMMdd-HHmmss");
        var trashRoot = Path.Combine(vaultRoot, AppFolder, TrashFolder);
        Directory.CreateDirectory(trashRoot);

        // Preserve the original folder structure inside trash so multiple
        // notes with the same name don't collide.
        var trashRelative = canonical.Replace('/', Path.DirectorySeparatorChar);
        var trashTarget = Path.Combine(
            trashRoot,
            Path.GetDirectoryName(trashRelative) ?? string.Empty,
            $"{Path.GetFileNameWithoutExtension(trashRelative)}-{stamp}{Path.GetExtension(trashRelative)}");

        var trashParent = Path.GetDirectoryName(trashTarget);
        if (!string.IsNullOrEmpty(trashParent))
        {
            Directory.CreateDirectory(trashParent);
        }

        File.Move(absolute, trashTarget, overwrite: false);

        // Move the sibling .assets/ folder if present, into a parallel
        // location under trash. Using the same convention preserves the
        // image links if the user manually restores.
        var assetsFolder = Path.Combine(
            Path.GetDirectoryName(absolute) ?? string.Empty,
            Path.GetFileNameWithoutExtension(absolute) + ".assets");
        if (Directory.Exists(assetsFolder))
        {
            var assetsTrashTarget = Path.Combine(
                Path.GetDirectoryName(trashTarget) ?? string.Empty,
                Path.GetFileNameWithoutExtension(trashTarget) + ".assets");
            try
            {
                Directory.Move(assetsFolder, assetsTrashTarget);
            }
            catch
            {
                // If the rename fails, the note has still been moved out;
                // the assets remain in place. Acceptable inconsistency
                // pending an "empty trash" job.
            }
        }

        await _indexer.OnNoteDeletedAsync(vaultId, canonical, ct);
    }

    public async Task<FolderListingDto> ListFolderAsync(
        Guid vaultId,
        string folderPath,
        CancellationToken ct = default)
    {
        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);
        string canonical, absolute;
        try
        {
            canonical = _notePaths.CanonicalizeFolder(folderPath ?? string.Empty);
            absolute = _notePaths.ResolveFolder(vaultRoot, canonical);
        }
        catch (InvalidNotePathException ex)
        {
            throw new NoteException(ex.Message);
        }

        if (!Directory.Exists(absolute))
        {
            throw new NoteException("Folder not found.", statusCode: 404);
        }

        // Direct children: subfolders and notes.
        var subfolders = new List<FolderSummaryDto>();
        var notes = new List<NoteSummaryDto>();

        foreach (var dir in Directory.EnumerateDirectories(absolute))
        {
            var dirName = Path.GetFileName(dir);
            // Skip the .notesapp folder and any *.assets siblings — neither
            // is a "subfolder" from the user's point of view.
            if (string.Equals(dirName, AppFolder, StringComparison.OrdinalIgnoreCase)) continue;
            if (dirName.EndsWith(".assets", StringComparison.OrdinalIgnoreCase)) continue;

            var subPath = canonical.Length == 0 ? dirName : $"{canonical}/{dirName}";
            var noteCount = Directory.EnumerateFiles(dir, "*.md", SearchOption.TopDirectoryOnly).Count();
            subfolders.Add(new FolderSummaryDto(subPath, dirName, noteCount));
        }

        foreach (var file in Directory.EnumerateFiles(absolute, "*.md", SearchOption.TopDirectoryOnly))
        {
            var name = Path.GetFileNameWithoutExtension(file);
            var rel = canonical.Length == 0
                ? Path.GetFileName(file)
                : $"{canonical}/{Path.GetFileName(file)}";
            var info = new FileInfo(file);
            notes.Add(new NoteSummaryDto(rel, name, info.LastWriteTimeUtc, info.Length));
        }

        // Recently-updated, recursive across this folder and descendants,
        // skipping the .notesapp folder.
        var recentlyUpdated = new List<NoteSummaryDto>();
        foreach (var file in EnumerateNotesRecursive(absolute, vaultRoot)
                              .OrderByDescending(p => new FileInfo(p).LastWriteTimeUtc)
                              .Take(RecentlyUpdatedLimit))
        {
            var info = new FileInfo(file);
            var rel = Path.GetRelativePath(vaultRoot, file).Replace(Path.DirectorySeparatorChar, '/');
            recentlyUpdated.Add(new NoteSummaryDto(
                rel,
                Path.GetFileNameWithoutExtension(file),
                info.LastWriteTimeUtc,
                info.Length));
        }

        return new FolderListingDto(
            Path: canonical,
            Subfolders: subfolders.OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase).ToList(),
            Notes: notes.OrderBy(n => n.Name, StringComparer.OrdinalIgnoreCase).ToList(),
            RecentlyUpdated: recentlyUpdated);
    }

    // ---------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------

    /// <summary>
    /// Replace references to <c>{oldBasename}.assets/</c> in markdown body
    /// with <c>{newBasename}.assets/</c>. Used by MoveAsync after a rename
    /// so image links keep working.
    /// </summary>
    /// <remarks>
    /// We try three forms of the old folder name:
    ///   1. Uri.EscapeDataString(oldBasename) + ".assets"  — the form
    ///      AssetService writes today (spaces → %20, etc.).
    ///   2. The literal old basename + ".assets" — covers users who
    ///      hand-typed image paths without encoding.
    ///   3. A relaxed encoding where spaces use '+' instead of '%20'
    ///      — application/x-www-form-urlencoded style. AssetService
    ///      uses %20, but tiptap-markdown's serializer has historically
    ///      varied; cheap to also handle.
    ///
    /// In all three cases we match only when followed by a slash, so we
    /// don't accidentally rewrite text like "Old Note.assets are stored…"
    /// in a paragraph.
    ///
    /// The replacement always uses Uri.EscapeDataString for consistency
    /// with what AssetService writes.
    ///
    /// Returns the SAME string instance (reference-equal) when nothing
    /// changed, so callers can short-circuit a write.
    /// </remarks>
    private static string RewriteAssetReferences(string body, string oldBasename, string newBasename)
    {
        if (string.IsNullOrEmpty(body)) return body;
        if (string.IsNullOrEmpty(oldBasename)) return body;

        // Pre-compute the three "old" forms and the one canonical "new"
        // form. Everything we replace points at the new canonical form
        // (the editor + AssetService both emit URI-encoded paths).
        var oldEncoded = Uri.EscapeDataString(oldBasename) + ".assets";
        var oldLiteral = oldBasename + ".assets";
        var oldFormStyle = oldBasename.Replace(" ", "+") + ".assets";
        var newEncoded = Uri.EscapeDataString(newBasename) + ".assets";

        // Build a regex that matches any of the three forms followed by
        // a literal '/'. Order matters when forms overlap: try the most
        // specific (encoded) first, then the literal, then form-style.
        // We also need each form regex-escaped because the basename can
        // contain regex meta-characters like '.' or '+' (which we just
        // generated for form-style).
        var alternatives = new HashSet<string>(StringComparer.Ordinal)
        {
            Regex.Escape(oldEncoded),
            Regex.Escape(oldLiteral),
            Regex.Escape(oldFormStyle),
        };
        // Longer alternatives first so the regex engine doesn't pick a
        // shorter prefix when a longer form would also match.
        var pattern = "(?:" + string.Join("|",
            alternatives.OrderByDescending(a => a.Length)) + @")(?=/)";

        var rx = new Regex(pattern, RegexOptions.CultureInvariant);
        var result = rx.Replace(body, newEncoded);

        // Fast path: if the regex didn't change anything, return the
        // original instance so the caller can skip a disk write.
        return ReferenceEquals(result, body) || result == body ? body : result;
    }

    private static IEnumerable<string> EnumerateNotesRecursive(string folderAbsolute, string vaultRoot)
    {
        // Skip .notesapp anywhere in the path. Easy because we know the
        // vault root: anything under {vaultRoot}/.notesapp is excluded.
        var stack = new Stack<string>();
        stack.Push(folderAbsolute);
        while (stack.Count > 0)
        {
            var dir = stack.Pop();

            // Skip .notesapp folders.
            var name = Path.GetFileName(dir);
            if (string.Equals(name, AppFolder, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            IEnumerable<string> files;
            IEnumerable<string> subdirs;
            try
            {
                files = Directory.EnumerateFiles(dir, "*.md", SearchOption.TopDirectoryOnly);
                subdirs = Directory.EnumerateDirectories(dir);
            }
            catch (UnauthorizedAccessException) { continue; }
            catch (DirectoryNotFoundException) { continue; }

            foreach (var f in files) yield return f;
            foreach (var sd in subdirs) stack.Push(sd);
        }
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

    private static string ComputeEtag(string content)
    {
        // Strong hash of the raw bytes — both ETag header and a stable
        // identity for optimistic concurrency. Hex-encoded, prefixed with
        // a quote to satisfy the ETag header grammar.
        var bytes = Encoding.UTF8.GetBytes(content);
        var hash = SHA256.HashData(bytes);
        // First 16 bytes (128 bits) is plenty for collision-resistance.
        return Convert.ToHexString(hash.AsSpan(0, 16));
    }

    private static readonly UTF8Encoding NoBomUtf8 = new(encoderShouldEmitUTF8Identifier: false);
}
