using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Data;
using NoteControl.Server.Folders.Services;
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
    /// present, moves the <c>.notesapp/history/&lt;encoded&gt;/</c> folder if
    /// present, and re-indexes under the new path. Same source and
    /// destination is a no-op (returns the existing note).
    /// </summary>
    Task<NoteDto> MoveAsync(Guid vaultId, string oldPath, string newPath, CancellationToken ct = default);

    Task<FolderListingDto> ListFolderAsync(Guid vaultId, string folderPath, CancellationToken ct = default);

    /// <summary>
    /// Per-note undo-history summary. Drives the Properties panel's
    /// "Revert to last save" button: count > 0 means the button is
    /// enabled, latest provides the tooltip / label timestamp.
    /// </summary>
    Task<NoteHistoryInfoDto> GetHistoryInfoAsync(Guid vaultId, string notePath, CancellationToken ct = default);

    /// <summary>
    /// Pop the most recent snapshot off the per-note history stack and
    /// restore it to the note file. Before doing so, snapshots the
    /// *current* note content so the pop is itself reversible (one
    /// subsequent pop will return the state we just replaced). Returns
    /// the new <see cref="NoteDto"/> reflecting the restored content.
    /// </summary>
    Task<NoteDto> PopHistoryAsync(Guid vaultId, string notePath, CancellationToken ct = default);
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
    private const string HistoryFolder = "history";

    /// <summary>
    /// Per-note snapshot cap. Each save that changes the body writes one
    /// snapshot file; the oldest are pruned once this cap is exceeded.
    /// </summary>
    private const int HistorySnapshotCap = 10;

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;
    private readonly INotePathResolver _notePaths;
    private readonly TimeProvider _clock;
    private readonly INoteIndexer _indexer;
    // Used by ListFolderAsync to populate FolderListingDto.CoverUrl
    // when a cover image is present in the folder. Kept here (rather
    // than fetched separately by the client) so a single listing
    // request returns everything FolderPage needs to paint.
    private readonly IFolderCoverService _folderCovers;

    public NoteService(
        ServerDbContext db,
        IVaultPathResolver vaultPaths,
        INotePathResolver notePaths,
        TimeProvider clock,
        INoteIndexer indexer,
        IFolderCoverService folderCovers)
    {
        _db = db;
        _vaultPaths = vaultPaths;
        _notePaths = notePaths;
        _clock = clock;
        _indexer = indexer;
        _folderCovers = folderCovers;
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

        var (fm, existingBody) = FrontmatterCodec.Split(existingRaw);
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

        // Body resolution (the property-save data-loss fix):
        //
        //   request.Body == null  → "leave body alone". We keep the body
        //                           we just parsed off disk verbatim.
        //                           This is the path the Properties panel
        //                           uses for Locked / Tags / Version /
        //                           appearance saves — none of which
        //                           should touch the body.
        //
        //   request.Body != null  → "this is the new body". The editor's
        //                           own save flow takes this path,
        //                           paired with an ETag.
        //
        // The bug this fixes: the panel used to send `body: note.body`
        // where `note.body` was the panel's last-fetched snapshot. If the
        // editor had autosaved newer content since then (or had unsaved
        // changes in memory), the property save would silently truncate
        // the file to the panel's stale view. A real user lost a whole
        // program this way.
        var bodyToWrite = request.Body ?? existingBody;

        // Undo-history snapshot: if this save is replacing the body
        // (i.e. the editor is saving content, not the panel toggling a
        // property), and the new body actually differs from the old,
        // update the history ring with cursor-truncate semantics:
        //
        //   - If the existing on-disk content matches a snapshot
        //     already in the ring (i.e. the user is editing from a
        //     reverted state), DELETE every snapshot above that one
        //     and don't add a new entry. This is the standard "edit
        //     truncates the redo branch" behaviour the user knows
        //     from every other undo system.
        //
        //   - If the existing content matches no snapshot (the
        //     normal case: user typed, autosaved), snapshot the
        //     existing content as a new entry and prune the ring
        //     back to the cap. Same as the original snapshot-on-save
        //     behaviour.
        //
        // We snapshot/truncate BEFORE writing the new content so an
        // exception during the write doesn't leave the disk in a
        // half-truncated state where some future snapshots have been
        // deleted but the note still holds the old content. Failure
        // to update the ring is non-fatal — we swallow — losing a
        // single point on the history ring is acceptable. Losing the
        // save itself wouldn't be.
        //
        // Property-only saves (request.Body == null) don't reach this
        // branch — they don't change the body, so the cursor doesn't
        // move and the ring is left alone.
        if (request.Body != null
            && !string.Equals(request.Body, existingBody, StringComparison.Ordinal))
        {
            try
            {
                await UpdateHistoryForBodyChangeAsync(
                    vaultRoot, canonical, existingRaw, ct);
            }
            catch
            {
                // Best-effort. See note above.
            }
        }

        var newText = FrontmatterCodec.Combine(fm, bodyToWrite);
        await File.WriteAllTextAsync(absolute, newText, NoBomUtf8, ct);

        var lastModified = new FileInfo(absolute).LastWriteTimeUtc;
        await _indexer.OnNoteSavedAsync(
            vaultId, canonical, fm, bodyToWrite,
            new DateTimeOffset(lastModified, TimeSpan.Zero), ct);

        return new NoteDto(
            Path: canonical,
            Body: bodyToWrite,
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

        // Move the .notesapp/history/<encoded>/ folder if it exists, so
        // the per-note undo stack follows the note under its new
        // identity. Same try/catch convention as the assets-folder move:
        // best-effort; failure leaves the .md move intact and just
        // orphans the old history folder (which a future cleanup pass
        // could sweep). The encoded folder name is derived from the
        // canonical path, so a path change always means a folder
        // rename here, even when only the parent folder changes.
        var oldHistoryFolder = HistoryFolderFor(vaultRoot, oldCanonical);
        if (Directory.Exists(oldHistoryFolder))
        {
            var newHistoryFolder = HistoryFolderFor(vaultRoot, newCanonical);
            try
            {
                Directory.Move(oldHistoryFolder, newHistoryFolder);
            }
            catch
            {
                // History orphaned at the old name. Note itself is fine.
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

        // Per-note history: deliberately NOT preserved through delete-to-
        // trash for v1. The trash itself has no restore UI today (per
        // docs/notes.md#trash), so symmetric preservation of the history
        // folder through delete would be work for an unused recovery
        // path. We simply drop the history folder. If a user manually
        // restores a deleted note via the filesystem, they'd start with
        // an empty history (the snapshot ring rebuilds from subsequent
        // saves). Revisit if/when a trash-restore UI lands.
        var historyFolder = HistoryFolderFor(vaultRoot, canonical);
        if (Directory.Exists(historyFolder))
        {
            try
            {
                Directory.Delete(historyFolder, recursive: true);
            }
            catch
            {
                // Acceptable inconsistency — orphan history folder under
                // .notesapp/history/. A future cleanup pass could sweep.
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

        // Cover image probe (Ship N: per-folder cover above the
        // search box on FolderPage). The probe is cheap — File.Exists
        // on a handful of candidate names — and we do it inline rather
        // than as a separate round-trip so the listing response has
        // everything FolderPage needs to paint without a second fetch.
        // mtime is embedded in the URL as `?v=<unix-ms>` so re-uploads
        // bypass the browser cache without needing no-store headers
        // on the GET endpoint.
        string? coverUrl = null;
        if (_folderCovers.TryGetExistingCover(vaultRoot, canonical, out _, out var coverMtime))
        {
            var ms = new DateTimeOffset(coverMtime, TimeSpan.Zero).ToUnixTimeMilliseconds();
            coverUrl =
                $"/api/vaults/{vaultId}/folder/cover?path={Uri.EscapeDataString(canonical)}&v={ms}";
        }

        return new FolderListingDto(
            Path: canonical,
            Subfolders: subfolders.OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase).ToList(),
            Notes: notes.OrderBy(n => n.Name, StringComparer.OrdinalIgnoreCase).ToList(),
            RecentlyUpdated: recentlyUpdated,
            CoverUrl: coverUrl);
    }

    public async Task<NoteHistoryInfoDto> GetHistoryInfoAsync(
        Guid vaultId,
        string notePath,
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

        var folder = HistoryFolderFor(vaultRoot, canonical);
        if (!Directory.Exists(folder) || !File.Exists(absolute))
        {
            return new NoteHistoryInfoDto(0, null);
        }

        // The "count" the panel cares about is "how many steps backward
        // can the user still Revert" — i.e. the cursor position. With
        // cursor-truncate semantics, this is:
        //
        //   - All N snapshots, if the live note has fresh content not
        //     matching any snapshot ("above the stack").
        //   - i, if the live note matches the snapshot at index i (0
        //     = oldest, N-1 = newest). The user has already walked
        //     past N-i snapshots and can walk i more.
        //   - 0, if the live note matches the oldest snapshot.
        //
        // We compare by content hash (ComputeEtag = SHA-256). The
        // current note's etag against each snapshot's etag.
        var currentRaw = await File.ReadAllTextAsync(absolute, Encoding.UTF8, ct);
        var currentEtag = ComputeEtag(currentRaw);

        var snapshots = await LoadSnapshotsAsync(folder, ct);
        if (snapshots.Count == 0)
        {
            return new NoteHistoryInfoDto(0, null);
        }

        var cursor = FindCursor(snapshots, currentEtag);
        if (cursor == 0)
        {
            // Live note matches the oldest snapshot — no more steps
            // back. Latest timestamp returns null because there's no
            // snapshot to walk *to*.
            return new NoteHistoryInfoDto(0, null);
        }

        // Cursor > 0: stepping back lands on snapshots[cursor - 1].
        // That snapshot's timestamp is what the panel's tooltip uses
        // ("Revert to the version saved at ...").
        var targetMs = snapshots[cursor - 1].Ms;
        var target = DateTimeOffset.FromUnixTimeMilliseconds(targetMs);
        return new NoteHistoryInfoDto(cursor, target);
    }

    public async Task<NoteDto> PopHistoryAsync(
        Guid vaultId,
        string notePath,
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

        var folder = HistoryFolderFor(vaultRoot, canonical);
        if (!Directory.Exists(folder))
        {
            throw new NoteException("No history available for this note.", statusCode: 404);
        }

        var snapshots = await LoadSnapshotsAsync(folder, ct);
        if (snapshots.Count == 0)
        {
            throw new NoteException("No history available for this note.", statusCode: 404);
        }

        // Cursor walk: read the live note, find its position in the
        // ring, step one back. The ring itself is NOT modified by a
        // pop — we don't delete the target, don't snapshot the
        // current. This means a sequence of pops walks the user all
        // the way down the ring (which was the whole reason for the
        // cursor redesign — the old "snapshot current, delete popped"
        // version ping-ponged between two states).
        //
        // The cursor is "above the stack" (= snapshots.Count) when
        // the live note has fresh content not matching any snapshot.
        // After a pop, the cursor moves down by 1; after another pop
        // it moves down again; and so on until it hits 0, at which
        // point Revert returns 404 and the panel disables the button.
        //
        // Forward motion (server-side Redo) is intentionally not
        // implemented in v1. The user gets forward motion via
        // TipTap's in-memory Undo (setContent on Revert adds to
        // TipTap's history stack), which covers single-session
        // recovery from a mistaken Revert. Cross-session forward
        // motion is a v2 feature if it ever earns the UI surface.
        var currentRaw = await File.ReadAllTextAsync(absolute, Encoding.UTF8, ct);
        var currentEtag = ComputeEtag(currentRaw);
        var cursor = FindCursor(snapshots, currentEtag);
        if (cursor == 0)
        {
            // Already at the oldest snapshot, or somehow below the
            // ring. Nothing further to revert to.
            throw new NoteException("No more history to revert.", statusCode: 404);
        }

        // The snapshot we're walking the cursor onto.
        var target = snapshots[cursor - 1];
        var poppedRaw = await File.ReadAllTextAsync(target.Path, Encoding.UTF8, ct);

        // Single write to the note file. No snapshot writes, no
        // deletes — the ring is intentionally untouched.
        await File.WriteAllTextAsync(absolute, poppedRaw, NoBomUtf8, ct);

        // Parse the restored content for the indexer + return DTO.
        var (fm, body) = FrontmatterCodec.Split(poppedRaw);
        var lastModified = new FileInfo(absolute).LastWriteTimeUtc;
        try
        {
            await _indexer.OnNoteSavedAsync(
                vaultId, canonical, fm, body,
                new DateTimeOffset(lastModified, TimeSpan.Zero), ct);
        }
        catch
        {
            // Index drift recoverable via rebuild.
        }

        return new NoteDto(
            Path: canonical,
            Body: body,
            Frontmatter: fm.ToDto(),
            Etag: ComputeEtag(poppedRaw),
            LastModified: lastModified);
    }

    // ---------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------

    /// <summary>
    /// Apply the history-ring side effects for an editor save that is
    /// about to overwrite <paramref name="canonical"/>'s body with new
    /// content. The previous on-disk raw content (frontmatter + body)
    /// is supplied in <paramref name="existingRaw"/>.
    ///
    /// Two paths, picked by where the existing content sits in the ring:
    ///
    /// <list type="bullet">
    ///   <item><description><b>No cursor match</b> — the existing
    ///     content is fresh ("above the stack"). Take the standard
    ///     snapshot: write <paramref name="existingRaw"/> as a new
    ///     entry, then prune to <see cref="HistorySnapshotCap"/>.
    ///     This is the common path for a user typing-and-autosaving.
    ///     </description></item>
    ///   <item><description><b>Cursor hit at index i</b> — the existing
    ///     content matches a snapshot already in the ring (the user is
    ///     editing from a reverted state). Delete every snapshot above
    ///     index i (the "redo branch" the user is abandoning) and add
    ///     no new entry. The ring shrinks to i+1 entries; the live
    ///     note's content is about to become fresh again ("above the
    ///     stack"). This is the cursor-truncate semantics every
    ///     undo/redo system the user has used elsewhere.</description></item>
    /// </list>
    /// </summary>
    private async Task UpdateHistoryForBodyChangeAsync(
        string vaultRoot,
        string canonical,
        string existingRaw,
        CancellationToken ct)
    {
        var folder = HistoryFolderFor(vaultRoot, canonical);
        // Fast path: no folder yet → no ring to consult, just append.
        // (Directory will be created inside WriteHistorySnapshotAsync.)
        if (!Directory.Exists(folder))
        {
            await WriteHistorySnapshotAsync(vaultRoot, canonical, existingRaw, ct);
            return;
        }

        var snapshots = await LoadSnapshotsAsync(folder, ct);
        if (snapshots.Count == 0)
        {
            // Folder exists but is empty (e.g. all snapshots pruned).
            // Treat as "above the stack" — append.
            await WriteHistorySnapshotAsync(vaultRoot, canonical, existingRaw, ct);
            return;
        }

        var existingEtag = ComputeEtag(existingRaw);
        var cursor = FindCursor(snapshots, existingEtag);

        if (cursor == snapshots.Count)
        {
            // No match — existing content is above the stack. Standard
            // snapshot + prune behaviour.
            await WriteHistorySnapshotAsync(vaultRoot, canonical, existingRaw, ct);
            return;
        }

        // Match at index `cursor`. Truncate the redo branch: delete
        // every snapshot with index > cursor. Best-effort per file —
        // a stuck file lingers but isn't fatal.
        for (var i = cursor + 1; i < snapshots.Count; i++)
        {
            try
            {
                File.Delete(snapshots[i].Path);
            }
            catch
            {
                // Lingering forward-branch entry. The next save will
                // find it again and try to delete it again.
            }
        }
    }

    /// <summary>
    /// One snapshot, parsed from disk. <see cref="Etag"/> is computed
    /// lazily by <see cref="LoadSnapshotsAsync"/> — it's only needed
    /// for cursor lookup, not for ordering.
    /// </summary>
    private readonly record struct SnapshotEntry(long Ms, string Path, string Etag);

    /// <summary>
    /// Read the per-note history folder, parse all snapshot files,
    /// compute their content hashes, and return them in chronological
    /// order (oldest first, newest last).
    /// </summary>
    /// <remarks>
    /// Filenames are <c>{unixMs}.md</c> with an optional collision
    /// suffix (<c>{unixMs}-a.md</c>, etc.). We parse the leading digits
    /// as the timestamp; suffixes group under the same numeric ms.
    /// Each snapshot's raw file content is hashed via
    /// <see cref="ComputeEtag"/> for cursor lookup; this is at most
    /// <see cref="HistorySnapshotCap"/> small reads per call (~50 KB
    /// worst case for 10 × 5 KB notes), which is fine even on a
    /// slow disk.
    /// </remarks>
    private static async Task<List<SnapshotEntry>> LoadSnapshotsAsync(
        string folder,
        CancellationToken ct)
    {
        var raw = new List<(long Ms, string Path)>();
        foreach (var file in Directory.EnumerateFiles(folder, "*.md", SearchOption.TopDirectoryOnly))
        {
            var name = Path.GetFileNameWithoutExtension(file);
            var digits = 0;
            while (digits < name.Length && char.IsDigit(name[digits])) digits++;
            if (digits == 0) continue;
            if (long.TryParse(name.AsSpan(0, digits), out var ms))
            {
                raw.Add((ms, file));
            }
            ct.ThrowIfCancellationRequested();
        }

        // Sort oldest-first by ms. Ties (collision-suffix entries)
        // break by filename to keep the order deterministic — the
        // cursor logic doesn't care about a within-ms ordering as
        // long as it's stable.
        raw.Sort((a, b) =>
        {
            var byMs = a.Ms.CompareTo(b.Ms);
            return byMs != 0 ? byMs : string.CompareOrdinal(a.Path, b.Path);
        });

        // Read + hash each. We only need the etag; the body itself is
        // re-read by PopHistoryAsync directly for the chosen target.
        var result = new List<SnapshotEntry>(raw.Count);
        foreach (var (ms, path) in raw)
        {
            string content;
            try
            {
                content = await File.ReadAllTextAsync(path, Encoding.UTF8, ct);
            }
            catch
            {
                // Unreadable snapshot — skip. Could be a transient lock
                // or a stale temp file. The cursor logic will treat it
                // as "doesn't exist" which is the safe choice.
                continue;
            }
            result.Add(new SnapshotEntry(ms, path, ComputeEtag(content)));
        }
        return result;
    }

    /// <summary>
    /// Find the position of <paramref name="currentEtag"/> within the
    /// chronologically-ordered <paramref name="snapshots"/>. Returns
    /// the index of the first match if one exists, otherwise
    /// <c>snapshots.Count</c> (= "above the stack", fresh content).
    /// </summary>
    /// <remarks>
    /// "First match" handles the corner case where two distinct
    /// snapshots happen to have identical content (e.g. the user
    /// returned to an earlier state and saved again). In that case,
    /// the earlier matching snapshot wins — which means a Revert will
    /// skip the intermediate snapshots and walk further back than
    /// strict timestamp order would suggest. This is acceptable and
    /// arguably what the user wants: they're at content X; the
    /// "previous distinct state" is whatever came before the first X.
    /// </remarks>
    private static int FindCursor(IReadOnlyList<SnapshotEntry> snapshots, string currentEtag)
    {
        for (var i = 0; i < snapshots.Count; i++)
        {
            if (string.Equals(snapshots[i].Etag, currentEtag, StringComparison.Ordinal))
            {
                return i;
            }
        }
        return snapshots.Count;
    }

    /// <summary>
    /// Convenience wrapper around <c>Path.Combine(vaultRoot,
    /// .notesapp, history, encoded(canonical))</c>. The encoded folder
    /// name is derived from the canonical path; see
    /// <see cref="EncodeHistoryFolderName"/> for the encoding choice.
    /// </summary>
    private static string HistoryFolderFor(string vaultRoot, string canonical)
    {
        return Path.Combine(
            vaultRoot, AppFolder, HistoryFolder,
            EncodeHistoryFolderName(canonical));
    }

    /// <summary>
    /// Write one history snapshot for the note at <paramref name="canonical"/>.
    /// Creates the per-note history folder on demand, writes a single
    /// "{unixMs}.md" file containing the supplied raw content, then
    /// prunes the folder back to <see cref="HistorySnapshotCap"/> entries
    /// (oldest deleted first).
    /// </summary>
    /// <remarks>
    /// Two clock concerns:
    /// 1. Filename collisions. The clock is millisecond-resolution; two
    ///    saves arriving in the same millisecond would clash. We append
    ///    a short suffix only if the bare name already exists, so the
    ///    common path stays a clean "{ms}.md" filename. The
    ///    sort-by-unix-ms-prefix logic in the readers tolerates the
    ///    suffix transparently because they parse the prefix before
    ///    the first non-digit.
    /// 2. Clock skew on the host. We use the injected TimeProvider, so
    ///    tests can use a deterministic clock; in production the system
    ///    clock is fine (file timestamps already rely on it).
    ///
    /// This helper is called only from
    /// <see cref="UpdateHistoryForBodyChangeAsync"/> in the "no cursor
    /// match" path. The pop endpoint deliberately does NOT call it —
    /// pop is read-only with respect to the ring (the cursor walks
    /// down; entries are not added).
    /// </remarks>
    private async Task WriteHistorySnapshotAsync(
        string vaultRoot,
        string canonical,
        string rawContent,
        CancellationToken ct)
    {
        var folder = HistoryFolderFor(vaultRoot, canonical);
        Directory.CreateDirectory(folder);

        var nowMs = _clock.GetUtcNow().ToUnixTimeMilliseconds();
        var fileName = $"{nowMs}.md";
        var target = Path.Combine(folder, fileName);

        // Collision-handle the same-millisecond case. The sort-by-prefix
        // readers parse digits up to the first non-digit, so any of
        // "{ms}.md", "{ms}-a.md", "{ms}-b.md", etc. all sort under the
        // same numeric ms and are treated as adjacent timestamps.
        if (File.Exists(target))
        {
            // Pick the next available suffix. Caps at single-letter
            // ('a' through 'z') because two saves in the same ms is
            // already pathological; 26 collisions in one ms is fantasy.
            for (var c = 'a'; c <= 'z'; c++)
            {
                var candidate = Path.Combine(folder, $"{nowMs}-{c}.md");
                if (!File.Exists(candidate))
                {
                    target = candidate;
                    break;
                }
            }
        }

        await File.WriteAllTextAsync(target, rawContent, NoBomUtf8, ct);

        // Prune oldest if we're over the cap. List all snapshot files,
        // sort by numeric ms prefix, delete from the front until the
        // count is at most HistorySnapshotCap.
        var all = new List<(long Ms, string Path)>();
        foreach (var file in Directory.EnumerateFiles(folder, "*.md", SearchOption.TopDirectoryOnly))
        {
            var name = Path.GetFileNameWithoutExtension(file);
            // Parse leading digits as the timestamp; collision-suffix
            // entries fall under the same ms.
            var digits = 0;
            while (digits < name.Length && char.IsDigit(name[digits])) digits++;
            if (digits == 0) continue;
            if (long.TryParse(name.AsSpan(0, digits), out var ms))
            {
                all.Add((ms, file));
            }
        }

        if (all.Count <= HistorySnapshotCap) return;

        all.Sort((a, b) => a.Ms.CompareTo(b.Ms));
        var toDelete = all.Count - HistorySnapshotCap;
        for (var i = 0; i < toDelete; i++)
        {
            try
            {
                File.Delete(all[i].Path);
            }
            catch
            {
                // Best-effort prune; an over-cap file lingers until next
                // save reattempts the prune.
            }
        }
    }

    /// <summary>
    /// Map a canonical note path to a flat folder name under
    /// <c>.notesapp/history/</c>. Slashes are replaced with the
    /// double-underscore sentinel <c>__</c>; the <c>.md</c> extension is
    /// kept so the folder name parallels the note's filename and is
    /// recognisable when listing directories by hand.
    /// </summary>
    /// <remarks>
    /// The encoding has to round-trip through Windows and POSIX
    /// filesystem rules. Canonical paths never contain backslashes
    /// (NotePathResolver canonicalises to forward-slash), so the only
    /// reserved character we have to escape is the path separator
    /// itself. We use <c>__</c> rather than e.g. percent-encoding so
    /// the folder names stay reasonably legible to a human reading
    /// <c>.notesapp/history/</c>: a note at <c>XTS/Pullforce.md</c>
    /// becomes <c>XTS__Pullforce.md</c>. The likelihood of a legitimate
    /// note filename containing the literal sequence <c>__</c> as part
    /// of its actual name is low, and even when it does occur the
    /// collision space is per-vault, not global.
    /// </remarks>
    private static string EncodeHistoryFolderName(string canonical)
    {
        return canonical.Replace("/", "__");
    }

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
