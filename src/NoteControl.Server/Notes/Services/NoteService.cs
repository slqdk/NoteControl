using System.Globalization;
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
    /// present, moves the <c>.notesapp/releases/&lt;encoded&gt;/</c> folder
    /// (the archived release versions) if present, and re-indexes under
    /// the new path. Same source and destination is a no-op.
    /// </summary>
    Task<NoteDto> MoveAsync(Guid vaultId, string oldPath, string newPath, CancellationToken ct = default);

    Task<FolderListingDto> ListFolderAsync(Guid vaultId, string folderPath, CancellationToken ct = default);

    /// <summary>
    /// List the archived released versions for a note, newest first.
    /// Each entry comes from a frozen <c>v&lt;maj&gt;.&lt;min&gt;.md</c>
    /// file under <c>.notesapp/releases/&lt;encoded&gt;/</c>. An empty
    /// list means the note has never been released.
    /// </summary>
    Task<ReleasedVersionsDto> ListArchivedReleasesAsync(
        Guid vaultId, string notePath, CancellationToken ct = default);

    /// <summary>
    /// Read one archived released version's content for the read-only
    /// viewer. The returned <see cref="ArchivedReleaseDto"/> mirrors a
    /// regular <see cref="NoteDto"/> body + frontmatter, plus the
    /// archive's saved-at timestamp. Throws a 404 NoteException if no
    /// archive exists at the requested (major, minor) pair.
    /// </summary>
    Task<ArchivedReleaseDto> GetArchivedReleaseAsync(
        Guid vaultId, string notePath, int versionMajor, int versionMinor,
        CancellationToken ct = default);

    // ---------------------------------------------------------------
    // Legacy stubs — retained for the Ship A → Ship B transition window
    // so an older frontend doesn't crash when the server is upgraded
    // first. Both will be removed once Ship B lands.
    // ---------------------------------------------------------------

    /// <summary>
    /// Legacy snapshot-ring summary. Always returns
    /// <c>Count = 0, Latest = null</c> in the new model — the snapshot
    /// ring was removed in favour of per-version release archives. The
    /// effect on the legacy frontend is that "Revert to last save" goes
    /// permanently disabled, which is the intended behaviour.
    /// </summary>
    Task<NoteHistoryInfoDto> GetHistoryInfoAsync(Guid vaultId, string notePath, CancellationToken ct = default);

    /// <summary>
    /// Legacy single-frozen-release info. Always returns
    /// <c>Exists = false</c> in the new model — the single-slot release
    /// was replaced by an archive list. The legacy "Recall released
    /// version" affordance disappears as a result.
    /// </summary>
    Task<ReleaseInfoDto> GetReleaseInfoAsync(Guid vaultId, string notePath, CancellationToken ct = default);
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

    // ----- Release archive layout -------------------------------------
    //
    // Each note that has been released at least once gets one folder
    //
    //     {vault}/.notesapp/releases/{encoded-note-path}/
    //
    // and inside, one file per past Released entry:
    //
    //     v{major}.{minor}.md
    //
    // A snapshot is written on the transition into Released (the moment
    // of release) and never modified after. Subsequent unlocks
    // (Released -> Under development, paired with a +1 minor bump on
    // the live note) leave the archive entries intact. Re-entering
    // Released at a new version creates a new file; re-entering at the
    // SAME version (an edge case — would require an intervening manual
    // version change) overwrites the same file in place.
    private const string ReleasesFolder = "releases";

    // Legacy layout — both the abandoned server-side snapshot ring
    // (.notesapp/history/<encoded>/{ms}.md) and the old two-slot
    // release model (.notesapp/releases/<encoded>/{released,development}.md)
    // are gone. Folders/files on disk from those models are orphaned
    // in place and ignored by the new readers (the archive-listing
    // filter rejects anything that isn't shaped v{int}.{int}.md). They
    // get no constants here because nothing in the new code path
    // creates or reads them by name; sweeping is a separate concern.

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

        // Pre-update lifecycle state + version, used to detect transitions
        // below.
        var oldState = fm.State;
        var oldMajor = fm.VersionMajor;
        var oldMinor = fm.VersionMinor;

        // ----- Released auto-unlock on version change ------------------
        //
        // If the live note is currently Released and the request bumps the
        // version (either component) WITHOUT explicitly setting state, we
        // auto-transition it to Under development. This is the "stepper
        // tick on a Released note" path the user sees in the panel: there
        // is no separate Unlock button — incrementing the version IS the
        // unlock.
        //
        // The request still has to carry a higher version than current —
        // the monotonic check below (in ApplyUpdate) catches anything
        // else. A request that bumps the version AND explicitly sets a
        // state takes the explicit state (so a Released -> Released bump
        // is still possible, e.g. when the user picks +1 minor and then
        // immediately picks Released from the dropdown).
        var bumpsVersion =
            (request.VersionMajor.HasValue && request.VersionMajor.Value > oldMajor)
            || (request.VersionMinor.HasValue
                && request.VersionMinor.Value > oldMinor
                && (request.VersionMajor ?? oldMajor) == oldMajor);

        var effectiveStateRequest = request.State;
        if (effectiveStateRequest is null
            && string.Equals(oldState, FrontmatterCodec.StateReleased, StringComparison.Ordinal)
            && bumpsVersion)
        {
            effectiveStateRequest = FrontmatterCodec.StateDevelopment;
        }

        // The mirror of the auto-unlock-on-version-bump above: an explicit
        // Released -> Development request (state selector route) carries no
        // version bump, but the spec is "unlocking ticks the minor up by
        // one". We surface that as a server-side minor++ so the frontend
        // can't accidentally leave the note at the same version that's
        // already in the archive (which would then show up in the
        // archive list as a duplicate-ish entry on the next re-release).
        var effectiveMinorRequest = request.VersionMinor;
        var effectiveMajorRequest = request.VersionMajor;
        if (string.Equals(oldState, FrontmatterCodec.StateReleased, StringComparison.Ordinal)
            && string.Equals(effectiveStateRequest, FrontmatterCodec.StateDevelopment, StringComparison.Ordinal)
            && !bumpsVersion)
        {
            effectiveMinorRequest = oldMinor + 1;
            // Major stays put — the spec is +1 minor, not +1 major.
            effectiveMajorRequest = oldMajor;
        }

        // Resolve whether the request will end up touching version/state at
        // all. Used below to suppress the archive-on-entering-released check
        // for pure body/property saves on an already-released note.
        var touchesVersionState =
            effectiveMajorRequest.HasValue
            || effectiveMinorRequest.HasValue
            || effectiveStateRequest is not null;

        // ----- Ordinary update ----------------------------------------
        //
        // The two-slot release model (frozen released.md + parked
        // development.md) is gone. Body resolution stays the same: a
        // null request.Body means "leave the body alone" (the property
        // panel's safe path); non-null is the editor's new body, paired
        // with an ETag.
        try
        {
            FrontmatterCodec.ApplyUpdate(
                fm, _clock.GetUtcNow(),
                request.Tags, request.Locked,
                request.Font, request.FontSize, request.Width,
                effectiveMajorRequest, effectiveMinorRequest,
                effectiveStateRequest);
        }
        catch (FrontmatterValidationException ex)
        {
            throw new NoteException(ex.Message, statusCode: 400);
        }

        var bodyToWrite = request.Body ?? existingBody;

        // ----- Archive on entering Released ---------------------------
        //
        // The dev -> released transition is the moment of release. We
        // write the about-to-be-saved content into the archive folder as
        // v{major}.{minor}.md AFTER we know the new bodyToWrite + fm but
        // BEFORE the live note is written, so a failure to archive
        // surfaces as a failed save rather than a successful save with
        // a missing archive entry.
        //
        // Leaving Released (released -> development) takes no archive
        // action — the archive was already taken on the entry. The +1
        // minor bump that pairs with the unlock happens via ApplyUpdate
        // on the same request.
        //
        // Re-entering Released at the SAME (major, minor) overwrites the
        // existing file in place. This shouldn't happen in practice
        // (the unlock path bumps minor, and a fresh release will land
        // on a new version) but the overwrite keeps the invariant
        // "the archive entry IS the released content at that version"
        // honest if the user manually wrestles the version back.
        var enteringReleased =
            touchesVersionState
            && string.Equals(fm.State, FrontmatterCodec.StateReleased, StringComparison.Ordinal)
            && !string.Equals(oldState, FrontmatterCodec.StateReleased, StringComparison.Ordinal);

        if (enteringReleased)
        {
            var archivePath = ArchiveFilePath(vaultRoot, canonical, fm.VersionMajor, fm.VersionMinor);
            var archiveContent = FrontmatterCodec.Combine(fm, bodyToWrite);
            await SafeWriteArchiveAsync(archivePath, archiveContent, ct);
        }

        var newText = FrontmatterCodec.Combine(fm, bodyToWrite);
        await File.WriteAllTextAsync(absolute, newText, NoBomUtf8, ct);

        // The server-side snapshot ring (.notesapp/history/) is gone. The
        // archived release versions list (written on entering Released
        // above) replaces it as the user-facing history surface. The
        // legacy /history endpoints survive as stubs (see
        // GetHistoryInfoAsync below) that always report an empty ring,
        // so any pre-Ship-B frontend still talking to them disables its
        // Revert button cleanly.

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

        // Move the .notesapp/releases/<encoded>/ folder (the archived
        // release versions) so the release archive follows the note
        // under its new identity. Best-effort; failure just orphans the
        // archive at the old encoded name — the .md move stays intact.
        // The encoded folder name is derived from the canonical path,
        // so a path change always means a folder rename here, even when
        // only the parent folder changes.
        //
        // Legacy .notesapp/history/<encoded>/ folders (the abandoned
        // server-side snapshot ring) are NOT moved — they're orphaned
        // in place. New saves don't create them, so existing ones are
        // dead data; sweeping them is a separate concern.
        var oldReleaseFolder = ReleaseFolderFor(vaultRoot, oldCanonical);
        if (Directory.Exists(oldReleaseFolder))
        {
            var newReleaseFolder = ReleaseFolderFor(vaultRoot, newCanonical);
            try
            {
                Directory.Move(oldReleaseFolder, newReleaseFolder);
            }
            catch
            {
                // Release folder orphaned at the old name. Note is fine.
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

        // Per-note release archive: NOT preserved through delete-to-
        // trash. The trash itself has no restore UI today (per
        // docs/notes.md#trash), so symmetric preservation of the
        // archive through delete would be work for an unused recovery
        // path. Drop it. If a user manually restores a deleted note
        // via the filesystem they'd start with an empty release
        // archive (a new archive entry gets written on the next
        // Released entry). Revisit if/when a trash-restore UI lands.
        //
        // Legacy .notesapp/history/<encoded>/ folders (the abandoned
        // server-side snapshot ring) are NOT touched here — they're
        // orphaned in place, exactly as Move handles them. We don't
        // proactively sweep on delete, partly because deleting a note
        // shouldn't be the moment we cascade into legacy-data cleanup
        // and partly because the legacy data isn't keyed by the live
        // .md any longer.
        var releaseFolder = ReleaseFolderFor(vaultRoot, canonical);
        if (Directory.Exists(releaseFolder))
        {
            try
            {
                Directory.Delete(releaseFolder, recursive: true);
            }
            catch
            {
                // Acceptable inconsistency — orphan archive folder
                // under .notesapp/releases/.
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
            var (vMaj, vMin, state) = await ReadVersionStateAsync(file, ct);
            notes.Add(new NoteSummaryDto(rel, name, info.LastWriteTimeUtc, info.Length, vMaj, vMin, state));
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
            var (vMaj, vMin, state) = await ReadVersionStateAsync(file, ct);
            recentlyUpdated.Add(new NoteSummaryDto(
                rel,
                Path.GetFileNameWithoutExtension(file),
                info.LastWriteTimeUtc,
                info.Length,
                vMaj, vMin, state));
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

    // ---------------------------------------------------------------
    // Release archives (new model)
    // ---------------------------------------------------------------

    public async Task<ReleasedVersionsDto> ListArchivedReleasesAsync(
        Guid vaultId,
        string notePath,
        CancellationToken ct = default)
    {
        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);
        string canonical;
        try
        {
            canonical = _notePaths.CanonicalizeNote(notePath);
        }
        catch (InvalidNotePathException ex)
        {
            throw new NoteException(ex.Message);
        }

        var folder = ReleaseFolderFor(vaultRoot, canonical);
        if (!Directory.Exists(folder))
        {
            return new ReleasedVersionsDto(Array.Empty<ReleasedVersionSummaryDto>());
        }

        var entries = new List<ReleasedVersionSummaryDto>();
        foreach (var file in Directory.EnumerateFiles(folder, "v*.md", SearchOption.TopDirectoryOnly))
        {
            var name = Path.GetFileNameWithoutExtension(file); // e.g. "v1.2"
            if (!TryParseArchiveFileName(name, out var maj, out var min))
            {
                // Skip anything that isn't shaped like an archive entry —
                // includes the legacy "released.md" / "development.md"
                // files from the old two-slot model, plus any
                // miscellaneous junk a user might have dropped in here
                // by hand.
                continue;
            }

            var savedAt = new DateTimeOffset(new FileInfo(file).LastWriteTimeUtc, TimeSpan.Zero);
            entries.Add(new ReleasedVersionSummaryDto(maj, min, savedAt));
        }

        // Newest first — the panel renders the list top-down with v2.1
        // above v1.0 etc. Compare by (major, minor) descending; the
        // file mtime is not authoritative because a sysadmin
        // restore-from-backup can reset all mtimes to the same minute.
        entries.Sort((a, b) =>
        {
            var byMajor = b.VersionMajor.CompareTo(a.VersionMajor);
            return byMajor != 0 ? byMajor : b.VersionMinor.CompareTo(a.VersionMinor);
        });

        return new ReleasedVersionsDto(entries);
    }

    public async Task<ArchivedReleaseDto> GetArchivedReleaseAsync(
        Guid vaultId,
        string notePath,
        int versionMajor,
        int versionMinor,
        CancellationToken ct = default)
    {
        if (versionMajor < 0 || versionMinor < 0)
        {
            throw new NoteException("Version components cannot be negative.");
        }

        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);
        string canonical;
        try
        {
            canonical = _notePaths.CanonicalizeNote(notePath);
        }
        catch (InvalidNotePathException ex)
        {
            throw new NoteException(ex.Message);
        }

        var archivePath = ArchiveFilePath(vaultRoot, canonical, versionMajor, versionMinor);
        if (!File.Exists(archivePath))
        {
            throw new NoteException(
                $"No archived release at v{versionMajor}.{versionMinor} for this note.",
                statusCode: 404);
        }

        var raw = await File.ReadAllTextAsync(archivePath, Encoding.UTF8, ct);
        var (fm, body) = FrontmatterCodec.Split(raw);
        var savedAt = new DateTimeOffset(new FileInfo(archivePath).LastWriteTimeUtc, TimeSpan.Zero);

        return new ArchivedReleaseDto(
            Path: canonical,
            VersionMajor: versionMajor,
            VersionMinor: versionMinor,
            Body: body,
            Frontmatter: fm.ToDto(),
            SavedAt: savedAt);
    }

    // ---------------------------------------------------------------
    // Legacy stubs — see interface for rationale
    // ---------------------------------------------------------------

    public Task<NoteHistoryInfoDto> GetHistoryInfoAsync(
        Guid vaultId,
        string notePath,
        CancellationToken ct = default)
    {
        // The snapshot ring no longer exists; the legacy endpoint just
        // returns an empty summary so pre-Ship-B clients render their
        // Revert button as permanently disabled.
        return Task.FromResult(new NoteHistoryInfoDto(0, null));
    }

    public Task<ReleaseInfoDto> GetReleaseInfoAsync(
        Guid vaultId,
        string notePath,
        CancellationToken ct = default)
    {
        // The single-slot frozen release is gone; the legacy endpoint
        // reports no release so pre-Ship-B clients hide the recall
        // affordance. New code should use ListArchivedReleasesAsync.
        return Task.FromResult(new ReleaseInfoDto(false, 0, 0, null, false));
    }

    // ---------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------

    /// <summary>
    /// Per-note release-archive folder under
    /// <c>{vault}/.notesapp/releases/{encoded-note-path}/</c>. Home of
    /// the <c>v&lt;maj&gt;.&lt;min&gt;.md</c> archive entries, one per past
    /// Released entry on the note.
    /// </summary>
    private static string ReleaseFolderFor(string vaultRoot, string canonical)
        => Path.Combine(vaultRoot, AppFolder, ReleasesFolder, EncodeNoteFolderName(canonical));

    /// <summary>
    /// Absolute path of the archive file for one (major, minor) release
    /// of a note. The file may or may not exist; callers test
    /// <c>File.Exists</c> before reading.
    /// </summary>
    private static string ArchiveFilePath(string vaultRoot, string canonical, int versionMajor, int versionMinor)
        => Path.Combine(ReleaseFolderFor(vaultRoot, canonical), ArchiveFileName(versionMajor, versionMinor));

    /// <summary>
    /// Format an archive filename: <c>v{major}.{minor}.md</c>. The "v"
    /// prefix is there so the folder lists nicely when browsed by hand
    /// and so a human-dropped file (e.g. "1.0.md" without the prefix)
    /// isn't mistaken for an archive entry.
    /// </summary>
    private static string ArchiveFileName(int versionMajor, int versionMinor)
        => $"v{versionMajor.ToString(CultureInfo.InvariantCulture)}.{versionMinor.ToString(CultureInfo.InvariantCulture)}.md";

    /// <summary>
    /// Parse an archive filename back to (major, minor). Returns false
    /// for anything that doesn't match the <c>v{int}.{int}</c> shape,
    /// including the legacy <c>released.md</c> / <c>development.md</c>
    /// files that may linger from the old two-slot model.
    /// </summary>
    private static bool TryParseArchiveFileName(string nameWithoutExtension, out int versionMajor, out int versionMinor)
    {
        versionMajor = 0;
        versionMinor = 0;

        if (string.IsNullOrEmpty(nameWithoutExtension)) return false;
        if (nameWithoutExtension[0] != 'v' && nameWithoutExtension[0] != 'V') return false;

        var rest = nameWithoutExtension.AsSpan(1);
        var dot = rest.IndexOf('.');
        if (dot <= 0 || dot == rest.Length - 1) return false;

        if (!int.TryParse(rest[..dot], NumberStyles.None, CultureInfo.InvariantCulture, out var maj)) return false;
        if (!int.TryParse(rest[(dot + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out var min)) return false;
        if (maj < 0 || min < 0) return false;

        versionMajor = maj;
        versionMinor = min;
        return true;
    }

    /// <summary>
    /// Write one archive entry, creating the per-note release folder on
    /// demand. UTF-8 without BOM, like every other note write.
    /// Overwrites in place when the (major, minor) entry already exists
    /// — that's the documented edge case where the same version is
    /// re-released (atypical but supported).
    /// </summary>
    private async Task SafeWriteArchiveAsync(string path, string content, CancellationToken ct)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, content, NoBomUtf8, ct);
    }

    /// <summary>
    /// Cheaply read a note's version + lifecycle state from its
    /// frontmatter without loading a (potentially large) body. Reads a
    /// bounded prefix — comfortably more than any realistic frontmatter
    /// block — and runs it through the codec. A file with no, truncated,
    /// or garbled frontmatter reads as an unversioned note (0.0 /
    /// not-versioned), the safe default that renders no tree badge.
    ///
    /// Called once per note in a folder listing, so it must stay light:
    /// one bounded read, no full-file load.
    /// </summary>
    private static async Task<(int Major, int Minor, string State)> ReadVersionStateAsync(
        string absoluteFile,
        CancellationToken ct)
    {
        const int prefixCap = 8 * 1024;
        try
        {
            string prefix;
            await using (var fs = new FileStream(
                absoluteFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                var len = (int)Math.Min(fs.Length, prefixCap);
                if (len == 0)
                {
                    return (0, 0, FrontmatterCodec.StateNotVersioned);
                }
                var buf = new byte[len];
                var read = await fs.ReadAsync(buf.AsMemory(0, len), ct);
                // Strip a leading BOM if an externally-edited file has one;
                // our own writes never do.
                prefix = Encoding.UTF8.GetString(buf, 0, read).TrimStart('\uFEFF');
            }
            var (fm, _) = FrontmatterCodec.Split(prefix);
            return (fm.VersionMajor, fm.VersionMinor, fm.State);
        }
        catch
        {
            // Unreadable / locked / mid-write — treat as unversioned. The
            // listing must not fail because one note couldn't be sniffed.
            return (0, 0, FrontmatterCodec.StateNotVersioned);
        }
    }

    /// <summary>
    /// Map a canonical note path to a flat folder name for use under
    /// <c>.notesapp/releases/</c>. Slashes are replaced with the
    /// double-underscore sentinel <c>__</c>; the <c>.md</c> extension
    /// is kept so the folder name parallels the note's filename and is
    /// recognisable when listing directories by hand.
    /// </summary>
    /// <remarks>
    /// The encoding has to round-trip through Windows and POSIX
    /// filesystem rules. Canonical paths never contain backslashes
    /// (NotePathResolver canonicalises to forward-slash), so the only
    /// reserved character we have to escape is the path separator
    /// itself. We use <c>__</c> rather than e.g. percent-encoding so
    /// the folder names stay reasonably legible to a human reading
    /// <c>.notesapp/releases/</c>: a note at <c>XTS/Pullforce.md</c>
    /// becomes <c>XTS__Pullforce.md</c>. The likelihood of a legitimate
    /// note filename containing the literal sequence <c>__</c> as part
    /// of its actual name is low, and even when it does occur the
    /// collision space is per-vault, not global.
    ///
    /// Historically this also encoded the legacy
    /// <c>.notesapp/history/</c> snapshot-ring folders, hence the
    /// shared sentinel convention; the snapshot ring is gone but the
    /// encoding is unchanged so any pre-existing <c>releases/</c>
    /// folder lines up byte-for-byte under the same name.
    /// </remarks>
    private static string EncodeNoteFolderName(string canonical)
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
