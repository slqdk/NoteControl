using System.IO.Compression;
using System.Text.Json;
using Microsoft.Extensions.Options;
using NoteControl.Server.Backups.Services;
using NoteControl.Server.Options;

namespace NoteControl.Server.Export;

/// <summary>
/// Linux-4: zip exports streamed straight to the HTTP response.
///
/// <para>
/// <b>Full export</b> — the whole DataRoot (server.db, config.json,
/// every vault). Same file selection as a backup
/// (<see cref="BackupService.Classify"/>): server.db and each
/// index.db are written as consistent SQLite snapshots (VACUUM INTO),
/// -wal/-shm and machine-local secrets (tray.token, csrf.key,
/// server.url) are left out, in-flight *.nc-tmp files are skipped.
/// Entry names are DataRoot-relative with forward slashes, plus an
/// <c>export-manifest.json</c> in the format
/// <c>deploy/windows/export-windows.ps1</c> writes — so the zip can
/// be imported with <c>deploy/linux/import.sh</c> unchanged.
/// </para>
///
/// <para>
/// <b>Vault export</b> — one vault folder, entries relative to the
/// vault root (notes, assets, .notesapp/ with templates, dashboards,
/// release archives, trash and a snapshot of the search index).
/// </para>
///
/// <para>
/// Notes are file-level copies taken while the server keeps running;
/// a note saved during the export may be caught half-written — the
/// same trade-off the backup engine makes (see docs/storage.md).
/// </para>
/// </summary>
public interface IExportService
{
    /// <summary>Write a zip of the whole DataRoot to <paramref name="output"/>.</summary>
    ExportStats WriteFullExport(Stream output, CancellationToken ct);

    /// <summary>Write a zip of one vault folder to <paramref name="output"/>.</summary>
    ExportStats WriteVaultExport(string vaultAbsolutePath, Stream output, CancellationToken ct);
}

public sealed record ExportStats(int FileCount, long TotalBytes, int SkippedCount);

public sealed class ExportService : IExportService
{
    private readonly IOptionsMonitor<StorageOptions> _storage;
    private readonly ILogger<ExportService> _log;

    public ExportService(IOptionsMonitor<StorageOptions> storage, ILogger<ExportService> log)
    {
        _storage = storage;
        _log = log;
    }

    public ExportStats WriteFullExport(Stream output, CancellationToken ct)
    {
        var dataRoot = Path.GetFullPath(_storage.CurrentValue.DataRoot);
        var stats = new Counter();
        var vaultFolders = new List<string>();

        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            // Same scope as a backup: every top-level DIRECTORY of the
            // DataRoot (.server/, users/, shared/, ...). Loose files in
            // the root are not NoteControl data.
            foreach (var dir in Directory.EnumerateDirectories(dataRoot).OrderBy(d => d, StringComparer.Ordinal))
            {
                AddTree(zip, dir, dataRoot, entryPrefix: "", stats, vaultFolders, ct);
            }

            var manifest = new
            {
                format = "notecontrol-export",
                formatVersion = 1,
                exportedAtUtc = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                sourceHost = Environment.MachineName,
                sourceDataRoot = dataRoot,
                fileCount = stats.Files,
                totalBytes = stats.Bytes,
                emptyFolders = stats.EmptyFolders,
                vaultFolders,
                skipped = stats.Skipped,
            };
            var entry = zip.CreateEntry("export-manifest.json", CompressionLevel.Optimal);
            using var s = entry.Open();
            JsonSerializer.Serialize(s, manifest, new JsonSerializerOptions { WriteIndented = true });
        }

        _log.LogInformation(
            "Full export written: {Files} files, {Bytes} bytes, {Skipped} skipped.",
            stats.Files, stats.Bytes, stats.Skipped.Count);
        return new ExportStats(stats.Files, stats.Bytes, stats.Skipped.Count);
    }

    public ExportStats WriteVaultExport(string vaultAbsolutePath, Stream output, CancellationToken ct)
    {
        var dataRoot = Path.GetFullPath(_storage.CurrentValue.DataRoot);
        var vaultRoot = Path.GetFullPath(vaultAbsolutePath);
        if (!BackupService.IsSameOrUnder(vaultRoot, dataRoot) || !Directory.Exists(vaultRoot))
        {
            throw new DirectoryNotFoundException("Vault folder not found under the data root.");
        }

        var stats = new Counter();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            AddTree(zip, vaultRoot, dataRoot, entryPrefix: null, stats, vaultFolders: null, ct, vaultRoot);
        }

        _log.LogInformation(
            "Vault export written for {Vault}: {Files} files, {Bytes} bytes, {Skipped} skipped.",
            vaultRoot, stats.Files, stats.Bytes, stats.Skipped.Count);
        return new ExportStats(stats.Files, stats.Bytes, stats.Skipped.Count);
    }

    private sealed class Counter
    {
        public int Files;
        public long Bytes;
        public int EmptyFolders;
        public readonly List<string> Skipped = new();
    }

    /// <summary>
    /// Walk <paramref name="root"/> and add its files to the zip.
    /// Classification always uses the DataRoot-relative path (that is
    /// what <see cref="BackupService.Classify"/> expects). The entry
    /// name is DataRoot-relative for a full export, or relative to
    /// <paramref name="entryBase"/> (the vault root) for a vault export.
    /// </summary>
    private void AddTree(
        ZipArchive zip,
        string root,
        string dataRoot,
        string? entryPrefix,
        Counter stats,
        List<string>? vaultFolders,
        CancellationToken ct,
        string? entryBase = null)
    {
        var baseForEntries = entryBase ?? dataRoot;
        var pending = new Stack<string>();
        pending.Push(root);

        while (pending.Count > 0)
        {
            ct.ThrowIfCancellationRequested();
            var dir = pending.Pop();

            string[] files, dirs;
            try
            {
                files = Directory.GetFiles(dir);
                dirs = Directory.GetDirectories(dir);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _log.LogWarning(ex, "Export: cannot read folder {Path}; skipped.", dir);
                stats.Skipped.Add(Rel(dataRoot, dir) + "/");
                continue;
            }
            Array.Sort(files, StringComparer.Ordinal);
            Array.Sort(dirs, StringComparer.Ordinal);

            if (vaultFolders is not null
                && Directory.Exists(Path.Combine(dir, ".notesapp"))
                && !string.Equals(Path.GetFileName(dir), ".notesapp", StringComparison.Ordinal))
            {
                vaultFolders.Add(Rel(dataRoot, dir));
            }

            if (files.Length == 0 && dirs.Length == 0 && !PathEquals(dir, baseForEntries))
            {
                // Keep empty folders (user-created folders without notes yet).
                zip.CreateEntry(Rel(baseForEntries, dir) + "/");
                stats.EmptyFolders++;
                continue;
            }

            foreach (var file in files)
            {
                ct.ThrowIfCancellationRequested();
                var relData = Rel(dataRoot, file);
                var action = BackupService.Classify(relData);
                if (action == BackupService.FileAction.Exclude) continue;

                var entryName = (entryPrefix ?? "") + Rel(baseForEntries, file);
                try
                {
                    if (action == BackupService.FileAction.Copy)
                    {
                        AddFile(zip, file, entryName, stats);
                    }
                    else
                    {
                        AddSqliteSnapshot(zip, file, entryName, stats);
                    }
                }
                catch (Exception ex) when (action != BackupService.FileAction.SnapshotRequired
                                           && ex is not OperationCanceledException)
                {
                    // A file that vanished or is unreadable mid-export.
                    // The entry may already exist (partially written);
                    // ZipArchive can't remove it in Create mode, so the
                    // manifest lists it as skipped.
                    _log.LogWarning(ex, "Export: could not add {Path}; skipped.", file);
                    stats.Skipped.Add(relData);
                }
            }

            for (var i = dirs.Length - 1; i >= 0; i--)
            {
                pending.Push(dirs[i]);
            }
        }
    }

    private static void AddFile(ZipArchive zip, string file, string entryName, Counter stats)
    {
        using var src = new FileStream(file, FileMode.Open, FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete, bufferSize: 81920);
        var entry = zip.CreateEntry(entryName, LevelFor(entryName));
        entry.LastWriteTime = File.GetLastWriteTime(file);
        using (var dst = entry.Open())
        {
            src.CopyTo(dst);
        }
        stats.Files++;
        stats.Bytes += src.Length;
    }

    private static void AddSqliteSnapshot(ZipArchive zip, string dbFile, string entryName, Counter stats)
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"nc-export-{Guid.NewGuid():N}.db");
        try
        {
            var bytes = BackupService.SqliteSnapshot(dbFile, tmp);
            var entry = zip.CreateEntry(entryName, CompressionLevel.Optimal);
            entry.LastWriteTime = DateTimeOffset.Now;
            using (var src = File.OpenRead(tmp))
            using (var dst = entry.Open())
            {
                src.CopyTo(dst);
            }
            stats.Files++;
            stats.Bytes += bytes;
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { /* ignored */ }
        }
    }

    /// <summary>Already-compressed media isn't worth deflating again.</summary>
    private static CompressionLevel LevelFor(string name)
    {
        var ext = Path.GetExtension(name).ToLowerInvariant();
        return ext switch
        {
            ".png" or ".jpg" or ".jpeg" or ".gif" or ".webp" or ".mp4" or ".mov" or ".webm"
                or ".zip" or ".gz" or ".7z" or ".pdf" or ".docx" or ".xlsx" or ".pptx"
                => CompressionLevel.NoCompression,
            _ => CompressionLevel.Fastest,
        };
    }

    private static string Rel(string baseDir, string path)
        => Path.GetRelativePath(baseDir, path).Replace('\\', '/');

    private static bool PathEquals(string a, string b)
        => string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(a)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(b)),
            StringComparison.Ordinal);
}
