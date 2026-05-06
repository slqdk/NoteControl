using System.IO.Compression;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using NoteControl.Server.Data;
using NoteControl.Server.Notes.Frontmatter;
using NoteControl.Server.Notes.Services;
using NoteControl.Server.Search.Services;
using NoteControl.Server.Vaults.Services;
using NoteControl.Shared.Notes;

namespace NoteControl.Server.Notes.Import;

/// <summary>
/// Imports markdown files (and their asset siblings) into a vault.
/// <para>
/// Two input shapes:
/// <list type="bullet">
///   <item>A single <c>.md</c> file — written under <see cref="ImportRequest.TargetFolder"/>
///     with the file's original name.</item>
///   <item>A <c>.zip</c> archive — every <c>.md</c> entry becomes a
///     note; every other regular file is treated as an asset and
///     placed at the same relative path. Folder entries are no-ops
///     (folders materialise on first contained file).</item>
/// </list>
/// </para>
/// <para>
/// Conflict policy: numeric-suffix rename, mirroring the existing
/// asset-collision convention. <c>Foo.md</c> → <c>Foo (2).md</c> →
/// <c>Foo (3).md</c>. Asset collisions during a zip import follow
/// the same shape (<c>photo.png</c> → <c>photo (2).png</c>) but
/// **only when the rename is needed in isolation** — a renamed note
/// renames its companion <c>.assets/</c> folder in lockstep so the
/// markdown body's relative references resolve to the right place
/// without rewriting the body itself.
/// </para>
/// <para>
/// We deliberately do NOT route through <see cref="INoteService.CreateAsync"/>:
/// CreateAsync prepends a fresh frontmatter block, which would mangle
/// imported files that already have their own. Import writes raw bytes
/// (preserving frontmatter verbatim) then asks the indexer to scan the
/// new file directly. The on-disk format is the source of truth.
/// </para>
/// </summary>
public interface INoteImportService
{
    Task<ImportNoteResult> ImportAsync(
        Guid vaultId,
        ImportRequest request,
        CancellationToken ct = default);
}

/// <summary>
/// Server-side request shape. The endpoint constructs this from the
/// multipart form. <see cref="FileName"/> is the user-supplied
/// filename, used only to detect "this is a .zip" vs "this is an
/// .md"; the actual content lives in <see cref="Content"/>.
/// </summary>
public sealed record ImportRequest(
    string FileName,
    byte[] Content,
    string TargetFolder);

public sealed class NoteImportService : INoteImportService
{
    // Cap on the number of distinct rename attempts before we give up
    // on a single entry. In practice 2 or 3 is plenty; the bound is
    // here so a pathological vault with thousands of "Foo (N).md"
    // siblings can't spin forever.
    private const int MaxRenameAttempts = 1000;

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;
    private readonly INotePathResolver _notePaths;
    private readonly INoteIndexer _indexer;
    private readonly ILogger<NoteImportService> _log;

    public NoteImportService(
        ServerDbContext db,
        IVaultPathResolver vaultPaths,
        INotePathResolver notePaths,
        INoteIndexer indexer,
        ILogger<NoteImportService> log)
    {
        _db = db;
        _vaultPaths = vaultPaths;
        _notePaths = notePaths;
        _indexer = indexer;
        _log = log;
    }

    public async Task<ImportNoteResult> ImportAsync(
        Guid vaultId,
        ImportRequest request,
        CancellationToken ct = default)
    {
        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);

        // Validate the target folder before we touch anything else.
        // Empty string is the vault root and is valid.
        string targetFolderCanonical;
        try
        {
            targetFolderCanonical = _notePaths.CanonicalizeFolder(request.TargetFolder ?? string.Empty);
        }
        catch (InvalidNotePathException ex)
        {
            throw new NoteException($"Invalid target folder: {ex.Message}");
        }

        var entries = new List<ImportNoteEntry>();

        var isZip = request.FileName?.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) == true;
        var isMd = request.FileName?.EndsWith(".md", StringComparison.OrdinalIgnoreCase) == true;

        if (isZip)
        {
            await ImportZipAsync(vaultId, vaultRoot, targetFolderCanonical, request.Content, entries, ct);
        }
        else if (isMd)
        {
            await ImportSingleMdAsync(vaultId, vaultRoot, targetFolderCanonical, request, entries, ct);
        }
        else
        {
            throw new NoteException("Only .md and .zip files are supported for import.");
        }

        // Tally outcomes. Doing this at the end (rather than
        // incrementing as we go) keeps the per-branch code linear.
        int created = 0, renamed = 0, skipped = 0, failed = 0;
        foreach (var e in entries)
        {
            switch (e.Outcome)
            {
                case "created": created++; break;
                case "renamed": renamed++; break;
                case "skipped": skipped++; break;
                case "failed":  failed++;  break;
            }
        }

        return new ImportNoteResult(created, renamed, skipped, failed, entries);
    }

    // ----------------------------------------------------------------
    // single .md
    // ----------------------------------------------------------------

    private async Task ImportSingleMdAsync(
        Guid vaultId,
        string vaultRoot,
        string targetFolderCanonical,
        ImportRequest request,
        List<ImportNoteEntry> entries,
        CancellationToken ct)
    {
        // Use the user's filename as the note name. We strip any
        // directory parts the browser may have included (some browsers
        // submit "subdir/file.md" if the user picks via a fancy dialog).
        var bareName = Path.GetFileName(request.FileName);
        if (string.IsNullOrEmpty(bareName))
        {
            entries.Add(new ImportNoteEntry(
                request.FileName ?? "(unknown)", string.Empty, "failed",
                "Filename was empty after stripping directory parts."));
            return;
        }

        var requested = string.IsNullOrEmpty(targetFolderCanonical)
            ? bareName
            : $"{targetFolderCanonical}/{bareName}";

        await WriteNoteWithRenameAsync(
            vaultId, vaultRoot, requested, request.Content, entries, ct);
    }

    // ----------------------------------------------------------------
    // .zip — walk entries, write notes + assets, rename in lockstep
    // ----------------------------------------------------------------

    private async Task ImportZipAsync(
        Guid vaultId,
        string vaultRoot,
        string targetFolderCanonical,
        byte[] zipBytes,
        List<ImportNoteEntry> entries,
        CancellationToken ct)
    {
        // ZipArchive over a MemoryStream works because the bytes are
        // already in memory. For huge zips we'd prefer streaming the
        // upload to disk first, but our use-case (interactive UI
        // import of personal notes) caps out at tens of MB.
        using var ms = new MemoryStream(zipBytes, writable: false);
        using var zip = new ZipArchive(ms, ZipArchiveMode.Read);

        // Pass 1: collect note entries and asset entries separately.
        // We process notes first because they drive the rename map —
        // when "Foo.md" gets renamed to "Foo (2).md", every asset
        // entry under "Foo.assets/" needs to follow it to "Foo (2).assets/".
        var noteEntries = new List<ZipArchiveEntry>();
        var otherEntries = new List<ZipArchiveEntry>();

        foreach (var e in zip.Entries)
        {
            // Folder entries (paths ending in '/') and zero-length
            // directory markers — skip silently.
            if (string.IsNullOrEmpty(e.Name)) continue;

            if (e.FullName.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
            {
                noteEntries.Add(e);
            }
            else
            {
                otherEntries.Add(e);
            }
        }

        // Build a map from "<basename>.assets/" inside the zip to the
        // *renamed* basename so assets follow their note. Filled as
        // notes are processed.
        var basenameRenameMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        // ---- Pass 2a: notes ------------------------------------------
        foreach (var e in noteEntries)
        {
            ct.ThrowIfCancellationRequested();

            // Sanitise the entry path: forward slashes, no leading
            // slash, strip ".." segments. The path resolver will reject
            // illegal cases, but a defensive normalise here keeps the
            // requested-vs-final accounting honest.
            var rel = NormaliseZipPath(e.FullName);
            if (string.IsNullOrEmpty(rel))
            {
                entries.Add(new ImportNoteEntry(
                    e.FullName, string.Empty, "skipped",
                    "Empty entry path after normalisation."));
                continue;
            }

            // Anchor the entry under the requested target folder.
            var requested = string.IsNullOrEmpty(targetFolderCanonical)
                ? rel
                : $"{targetFolderCanonical}/{rel}";

            byte[] content;
            try
            {
                content = await ReadEntryBytesAsync(e, ct);
            }
            catch (Exception readEx)
            {
                entries.Add(new ImportNoteEntry(
                    requested, string.Empty, "failed",
                    $"Could not read zip entry: {readEx.Message}"));
                continue;
            }

            var (final, outcome, err) = await TryWriteNoteAsync(
                vaultId, vaultRoot, requested, content, ct);

            entries.Add(new ImportNoteEntry(requested, final, outcome, err));

            // If a rename happened, capture the basename mapping so any
            // sibling assets under "<oldBasename>.assets/" land in the
            // matching "<newBasename>.assets/".
            if (outcome == "renamed" && !string.IsNullOrEmpty(final))
            {
                var oldBase = StripMdExtension(rel);
                var finalRelToTarget = string.IsNullOrEmpty(targetFolderCanonical)
                    ? final
                    : final.Substring(targetFolderCanonical.Length + 1);
                var newBase = StripMdExtension(finalRelToTarget);
                if (!string.IsNullOrEmpty(oldBase) && !string.IsNullOrEmpty(newBase))
                {
                    basenameRenameMap[oldBase + ".assets"] = newBase + ".assets";
                }
            }
        }

        // ---- Pass 2b: other files (treated as assets) ---------------
        foreach (var e in otherEntries)
        {
            ct.ThrowIfCancellationRequested();

            var rel = NormaliseZipPath(e.FullName);
            if (string.IsNullOrEmpty(rel))
            {
                entries.Add(new ImportNoteEntry(
                    e.FullName, string.Empty, "skipped",
                    "Empty entry path after normalisation."));
                continue;
            }

            // Apply the basename rename map: if this asset's path
            // begins with "<oldBasename>.assets/", swap the prefix
            // to the new basename.
            var remapped = ApplyBasenameRemap(rel, basenameRenameMap);

            // Only files whose path is *inside* a *.assets/ folder are
            // imported as assets. Loose files in the zip root are
            // skipped — we don't have a sensible target for arbitrary
            // sibling files.
            if (!LooksLikeAssetPath(remapped))
            {
                entries.Add(new ImportNoteEntry(
                    rel, string.Empty, "skipped",
                    "Not a .md or a *.assets/ entry."));
                continue;
            }

            var requested = string.IsNullOrEmpty(targetFolderCanonical)
                ? remapped
                : $"{targetFolderCanonical}/{remapped}";

            byte[] content;
            try
            {
                content = await ReadEntryBytesAsync(e, ct);
            }
            catch (Exception readEx)
            {
                entries.Add(new ImportNoteEntry(
                    requested, string.Empty, "failed",
                    $"Could not read zip entry: {readEx.Message}"));
                continue;
            }

            var (final, outcome, err) = TryWriteAsset(
                vaultRoot, requested, content, ct);

            entries.Add(new ImportNoteEntry(requested, final, outcome, err));
        }
    }

    // ----------------------------------------------------------------
    // shared write helpers
    // ----------------------------------------------------------------

    /// <summary>
    /// Single-note write path used by both single-.md and zip imports.
    /// Wraps <see cref="TryWriteNoteAsync"/> and pushes the resulting
    /// entry into <paramref name="entries"/>.
    /// </summary>
    private async Task WriteNoteWithRenameAsync(
        Guid vaultId,
        string vaultRoot,
        string requested,
        byte[] content,
        List<ImportNoteEntry> entries,
        CancellationToken ct)
    {
        var (final, outcome, err) = await TryWriteNoteAsync(
            vaultId, vaultRoot, requested, content, ct);
        entries.Add(new ImportNoteEntry(requested, final, outcome, err));
    }

    /// <summary>
    /// Try to write a note at <paramref name="requestedPath"/>,
    /// renaming with a numeric suffix on conflict. Returns the final
    /// canonical path (relative, with .md), the outcome, and an
    /// optional error message.
    /// </summary>
    private async Task<(string FinalPath, string Outcome, string? ErrorMessage)>
        TryWriteNoteAsync(
            Guid vaultId,
            string vaultRoot,
            string requestedPath,
            byte[] content,
            CancellationToken ct)
    {
        // Canonicalise and resolve. Catches traversal, .notesapp,
        // illegal characters, etc.
        string canonicalRequested;
        try
        {
            canonicalRequested = _notePaths.CanonicalizeNote(requestedPath);
        }
        catch (InvalidNotePathException ex)
        {
            return (string.Empty, "failed", ex.Message);
        }

        // Find a non-colliding canonical path.
        var (finalCanonical, renamed) = ResolveNonCollidingNotePath(vaultRoot, canonicalRequested);
        if (finalCanonical is null)
        {
            return (string.Empty, "failed",
                $"Could not find a free filename after {MaxRenameAttempts} attempts.");
        }

        string finalAbs;
        try
        {
            finalAbs = _notePaths.Resolve(vaultRoot, finalCanonical);
        }
        catch (InvalidNotePathException ex)
        {
            return (string.Empty, "failed", ex.Message);
        }

        try
        {
            // Ensure parent folder exists. CreateDirectory is a no-op
            // if it already exists.
            var parent = Path.GetDirectoryName(finalAbs);
            if (!string.IsNullOrEmpty(parent))
            {
                Directory.CreateDirectory(parent);
            }

            // If the note's basename was renamed because of a
            // conflict, rewrite asset references in the body so they
            // point at the renamed sibling folder. Without this, an
            // imported "Foo.md" that becomes "Foo (2).md" still has
            // ![](Foo.assets/photo.png) inside, breaking the image.
            //
            // We only rewrite when the basename changed; the
            // unchanged case is the hot path and writing bytes
            // verbatim preserves any whitespace / encoding quirks
            // the original file had.
            byte[] toWrite = content;
            if (renamed)
            {
                var oldBasename = Path.GetFileNameWithoutExtension(
                    canonicalRequested.AsSpan(canonicalRequested.LastIndexOf('/') + 1).ToString());
                var newBasename = Path.GetFileNameWithoutExtension(
                    finalCanonical.AsSpan(finalCanonical.LastIndexOf('/') + 1).ToString());
                if (!string.IsNullOrEmpty(oldBasename) &&
                    !string.IsNullOrEmpty(newBasename) &&
                    !string.Equals(oldBasename, newBasename, StringComparison.Ordinal))
                {
                    var asText = Encoding.UTF8.GetString(content);
                    // Replace "<oldBasename>.assets/" with
                    // "<newBasename>.assets/" wherever it appears.
                    // Including the "/" guards against a half-match
                    // on a similarly-named distinct folder.
                    var rewritten = asText.Replace(
                        oldBasename + ".assets/",
                        newBasename + ".assets/",
                        StringComparison.Ordinal);
                    toWrite = Encoding.UTF8.GetBytes(rewritten);
                }
            }

            // Write raw bytes. Frontmatter (if present in the source
            // file) is preserved exactly; if the file has no
            // frontmatter, the next editor save will add a fresh
            // block via the codec.
            await File.WriteAllBytesAsync(finalAbs, toWrite, ct);

            // Index. Read frontmatter back from what we just wrote so
            // the index gets the right tags / dates. We treat the
            // bytes as UTF-8 — if the source was something else we'd
            // need an explicit encoding hint, but our own export
            // always writes UTF-8 and external markdown almost always
            // is.
            var text = Encoding.UTF8.GetString(toWrite);
            var (fm, body) = FrontmatterCodec.Split(text);
            var lastModified = new FileInfo(finalAbs).LastWriteTimeUtc;
            await _indexer.OnNoteSavedAsync(
                vaultId, finalCanonical, fm, body,
                new DateTimeOffset(lastModified, TimeSpan.Zero), ct);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Import failed to write note at {Path}", finalCanonical);
            return (string.Empty, "failed", ex.Message);
        }

        return (finalCanonical, renamed ? "renamed" : "created", null);
    }

    /// <summary>
    /// Write an asset file at <paramref name="requestedPath"/>,
    /// renaming on conflict. Synchronous because we use
    /// File.WriteAllBytes — the volumes are small and the call
    /// site already awaits the surrounding service.
    /// </summary>
    private (string FinalPath, string Outcome, string? ErrorMessage)
        TryWriteAsset(
            string vaultRoot,
            string requestedPath,
            byte[] content,
            CancellationToken ct)
    {
        // We use the folder resolver because asset paths don't end
        // in .md and the note-resolver would reject them.
        string canonicalRequested;
        try
        {
            canonicalRequested = _notePaths.CanonicalizeFolder(requestedPath);
        }
        catch (InvalidNotePathException ex)
        {
            return (string.Empty, "failed", ex.Message);
        }
        if (string.IsNullOrEmpty(canonicalRequested))
        {
            return (string.Empty, "failed", "Asset path was empty.");
        }

        var (finalCanonical, renamed) = ResolveNonCollidingFilePath(vaultRoot, canonicalRequested);
        if (finalCanonical is null)
        {
            return (string.Empty, "failed",
                $"Could not find a free filename after {MaxRenameAttempts} attempts.");
        }

        string finalAbs;
        try
        {
            finalAbs = _notePaths.ResolveFolder(vaultRoot, finalCanonical);
        }
        catch (InvalidNotePathException ex)
        {
            return (string.Empty, "failed", ex.Message);
        }

        try
        {
            var parent = Path.GetDirectoryName(finalAbs);
            if (!string.IsNullOrEmpty(parent))
            {
                Directory.CreateDirectory(parent);
            }
            File.WriteAllBytes(finalAbs, content);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Import failed to write asset at {Path}", finalCanonical);
            return (string.Empty, "failed", ex.Message);
        }

        return (finalCanonical, renamed ? "renamed" : "created", null);
    }

    // ----------------------------------------------------------------
    // path / collision helpers
    // ----------------------------------------------------------------

    /// <summary>
    /// Try the requested path; if a file already exists there, try
    /// "{stem} (2).md", "{stem} (3).md", etc. up to <see cref="MaxRenameAttempts"/>.
    /// Returns the canonical relative path to use plus a flag telling
    /// us whether the rename was needed.
    /// </summary>
    private (string? Final, bool Renamed) ResolveNonCollidingNotePath(
        string vaultRoot, string canonicalRequested)
    {
        // The "stem" is everything before the .md extension; the
        // suffix counter goes between stem and ".md". We split into
        // (parentFolder, stem, ".md").
        var lastSlash = canonicalRequested.LastIndexOf('/');
        var parentFolder = lastSlash >= 0 ? canonicalRequested[..lastSlash] : string.Empty;
        var leaf = lastSlash >= 0 ? canonicalRequested[(lastSlash + 1)..] : canonicalRequested;
        var stem = leaf.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
            ? leaf[..^3]
            : leaf;

        for (int i = 1; i <= MaxRenameAttempts; i++)
        {
            var leafCandidate = i == 1 ? $"{stem}.md" : $"{stem} ({i}).md";
            var candidate = string.IsNullOrEmpty(parentFolder)
                ? leafCandidate
                : $"{parentFolder}/{leafCandidate}";

            string abs;
            try
            {
                abs = _notePaths.Resolve(vaultRoot, candidate);
            }
            catch (InvalidNotePathException)
            {
                // Should not happen because the input is canonical,
                // but if it does, treat as a hard failure.
                return (null, false);
            }

            if (!File.Exists(abs))
            {
                return (candidate, i > 1);
            }
        }
        return (null, false);
    }

    /// <summary>
    /// Same idea as ResolveNonCollidingNotePath but for arbitrary
    /// files (preserves whatever extension the path has).
    /// </summary>
    private (string? Final, bool Renamed) ResolveNonCollidingFilePath(
        string vaultRoot, string canonicalRequested)
    {
        var lastSlash = canonicalRequested.LastIndexOf('/');
        var parentFolder = lastSlash >= 0 ? canonicalRequested[..lastSlash] : string.Empty;
        var leaf = lastSlash >= 0 ? canonicalRequested[(lastSlash + 1)..] : canonicalRequested;

        var dot = leaf.LastIndexOf('.');
        var stem = dot > 0 ? leaf[..dot] : leaf;
        var ext = dot > 0 ? leaf[dot..] : string.Empty;

        for (int i = 1; i <= MaxRenameAttempts; i++)
        {
            var leafCandidate = i == 1 ? leaf : $"{stem} ({i}){ext}";
            var candidate = string.IsNullOrEmpty(parentFolder)
                ? leafCandidate
                : $"{parentFolder}/{leafCandidate}";

            string abs;
            try
            {
                abs = _notePaths.ResolveFolder(vaultRoot, candidate);
            }
            catch (InvalidNotePathException)
            {
                return (null, false);
            }

            if (!File.Exists(abs))
            {
                return (candidate, i > 1);
            }
        }
        return (null, false);
    }

    /// <summary>
    /// True if <paramref name="canonicalPath"/> points at something
    /// inside a "*.assets/" folder. Asset folder names follow
    /// "&lt;basename&gt;.assets" — case-insensitive match on the
    /// suffix of any segment.
    /// </summary>
    private static bool LooksLikeAssetPath(string canonicalPath)
    {
        var segments = canonicalPath.Split('/');
        // The last segment is the file itself; any earlier segment
        // ending in ".assets" qualifies.
        for (int i = 0; i < segments.Length - 1; i++)
        {
            if (segments[i].EndsWith(".assets", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// If <paramref name="rel"/> begins with one of the keys in
    /// <paramref name="renameMap"/> (followed by a slash), swap that
    /// prefix for the mapped value. Used so assets follow their
    /// renamed parent note.
    /// </summary>
    private static string ApplyBasenameRemap(string rel, Dictionary<string, string> renameMap)
    {
        foreach (var kvp in renameMap)
        {
            var prefix = kvp.Key + "/";
            if (rel.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return kvp.Value + "/" + rel[prefix.Length..];
            }
        }
        return rel;
    }

    private static string NormaliseZipPath(string zipFullName)
    {
        // Zip entries use forward slashes per the spec; normalise
        // backslashes for any lawless writers, strip leading slashes,
        // and collapse "//".
        var s = zipFullName.Replace('\\', '/').Trim('/');
        while (s.Contains("//", StringComparison.Ordinal))
        {
            s = s.Replace("//", "/", StringComparison.Ordinal);
        }
        return s;
    }

    private static string StripMdExtension(string path)
    {
        return path.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
            ? path[..^3]
            : path;
    }

    private static async Task<byte[]> ReadEntryBytesAsync(
        ZipArchiveEntry entry, CancellationToken ct)
    {
        await using var s = entry.Open();
        using var ms = new MemoryStream();
        await s.CopyToAsync(ms, ct);
        return ms.ToArray();
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
