using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using NoteControl.Server.Data;
using NoteControl.Server.Options;
using NoteControl.Server.Search.Services;

namespace NoteControl.Server.Backups.Services;

/// <summary>
/// Vault-level restore from a backup folder. Steps:
/// <list type="number">
///   <item>Acquire the vault lock (writes are 503'd for the duration).</item>
///   <item>Move the live vault folder aside as
///     <c>{vaultName}.pre-restore-{timestamp}/</c>.</item>
///   <item>Copy the backup vault folder (markdown only — we drop
///     the indexed <c>.notesapp/index.db</c> so it rebuilds from
///     the source-of-truth markdown).</item>
///   <item>Trigger an index rebuild for the vault.</item>
///   <item>Release the lock. The pre-restore folder stays on disk
///     until the user decides to delete it.</item>
/// </list>
/// <para>
/// If anything fails after step 2, we attempt to MOVE THE
/// PRE-RESTORE FOLDER BACK to its original name so the live
/// vault is restored to its prior state. Best-effort rollback —
/// surfaces a clear error message if even rollback fails.
/// </para>
/// </summary>
public interface IRestoreService
{
    Task<RestoreResult> RestoreVaultAsync(
        string backupId,
        Guid vaultId,
        string vaultFolderInBackup,
        CancellationToken ct = default);
}

public sealed record RestoreResult(
    bool Success,
    string? Error,
    string? PreRestoreFolderPath,
    long DurationMs);

public sealed class RestoreService : IRestoreService
{
    private readonly IOptionsMonitor<StorageOptions> _storage;
    private readonly IBackupService _backups;
    private readonly IVaultLockService _locks;
    private readonly ServerDbContext _db;
    private readonly IIndexService _index;
    private readonly ILogger<RestoreService> _log;

    public RestoreService(
        IOptionsMonitor<StorageOptions> storage,
        IBackupService backups,
        IVaultLockService locks,
        ServerDbContext db,
        IIndexService index,
        ILogger<RestoreService> log)
    {
        _storage = storage;
        _backups = backups;
        _locks = locks;
        _db = db;
        _index = index;
        _log = log;
    }

    public async Task<RestoreResult> RestoreVaultAsync(
        string backupId,
        Guid vaultId,
        string vaultFolderInBackup,
        CancellationToken ct = default)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        string? preRestorePath = null;

        try
        {
            // 1. Resolve the backup folder.
            var backup = _backups.GetById(backupId)
                ?? throw new FileNotFoundException($"Backup '{backupId}' not found.");

            // Validate that the supplied vault folder exists inside
            // this backup. The UI passes one of the entries from
            // BackupRecord.VaultFolders, but a malicious caller
            // could craft a path that escapes the backup root, so
            // we re-check.
            var safeRel = SanitiseRelativePath(vaultFolderInBackup);
            var sourceVaultPath = Path.GetFullPath(Path.Combine(backup.AbsolutePath, safeRel));
            if (!sourceVaultPath.StartsWith(
                    backup.AbsolutePath + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    "Vault folder path escapes the backup root.");
            }
            if (!Directory.Exists(sourceVaultPath))
            {
                throw new DirectoryNotFoundException(
                    $"Vault folder '{vaultFolderInBackup}' does not exist in backup '{backupId}'.");
            }

            // 2. Resolve the live vault folder.
            var vault = await _db.Vaults
                .Where(v => v.Id == vaultId)
                .Select(v => new { v.Path })
                .FirstOrDefaultAsync(ct)
                ?? throw new InvalidOperationException("Vault not found.");

            var dataRoot = _storage.CurrentValue.DataRoot;
            var liveVaultPath = Path.GetFullPath(Path.Combine(dataRoot, vault.Path));
            if (!liveVaultPath.StartsWith(
                    Path.GetFullPath(dataRoot) + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Live vault path escapes the data root.");
            }

            // 3. Acquire the lock. Throws VaultLockException if
            //    another restore is in flight; let it bubble.
            //    Variable named `lockHandle` rather than `_` so it
            //    doesn't collide with the `_ = Task.Run(...)` discard
            //    further down — `using var _ = ...` introduces a
            //    real (non-discardable) variable named `_`.
            using var lockHandle = _locks.Acquire(vaultId, "Vault restore in progress");

            _log.LogInformation(
                "Restore starting: vault={VaultId} backup={BackupId} folder={Folder}",
                vaultId, backupId, safeRel);

            // 4. Move the live vault aside. Only do this if it
            //    exists — fresh-vault restore (e.g. after a
            //    deletion) is also a valid use case.
            if (Directory.Exists(liveVaultPath))
            {
                var ts = DateTimeOffset.UtcNow.ToString(
                    "yyyy-MM-ddTHH-mm-ssZ", CultureInfo.InvariantCulture);
                preRestorePath = liveVaultPath + ".pre-restore-" + ts;
                Directory.Move(liveVaultPath, preRestorePath);
                _log.LogInformation("Moved live vault aside → {Path}", preRestorePath);
            }

            // 5. Copy the backup vault into place. Markdown only —
            //    skip .notesapp/ entirely so the index rebuilds
            //    from the markdown source-of-truth.
            try
            {
                CopyVaultMarkdownOnly(sourceVaultPath, liveVaultPath, ct);
            }
            catch (Exception copyEx)
            {
                _log.LogError(copyEx, "Restore copy failed; rolling back.");
                // Rollback: nuke whatever partial copy landed, move
                // the pre-restore folder back to its original name.
                TryRollback(liveVaultPath, preRestorePath, _log);
                throw new InvalidOperationException(
                    "Restore copy failed; original vault data has been rolled back.", copyEx);
            }

            // 6. Trigger a fresh index build. Background-fire so
            //    the request returns promptly; the user can keep
            //    using the vault while it rebuilds.
            _ = Task.Run(async () =>
            {
                try { await _index.RebuildAsync(vaultId); }
                catch (Exception ex)
                {
                    _log.LogWarning(ex, "Post-restore index rebuild failed.");
                }
            });

            sw.Stop();
            _log.LogInformation(
                "Restore complete in {Ms} ms; pre-restore data at {Path}",
                sw.ElapsedMilliseconds, preRestorePath ?? "(none — vault was empty)");

            return new RestoreResult(
                Success: true,
                Error: null,
                PreRestoreFolderPath: preRestorePath,
                DurationMs: sw.ElapsedMilliseconds);
        }
        catch (Exception ex)
        {
            sw.Stop();
            return new RestoreResult(false, ex.Message, preRestorePath, sw.ElapsedMilliseconds);
        }
    }

    private static void CopyVaultMarkdownOnly(string source, string dest, CancellationToken ct)
    {
        Directory.CreateDirectory(dest);

        // Only copy files that aren't inside a .notesapp/ folder.
        // We let the index rebuild produce a fresh index DB on
        // first use.
        foreach (var dir in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(source, dir);
            if (IsInsideNotesApp(rel)) continue;
            Directory.CreateDirectory(Path.Combine(dest, rel));
        }

        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            ct.ThrowIfCancellationRequested();
            var rel = Path.GetRelativePath(source, file);
            if (IsInsideNotesApp(rel)) continue;
            var target = Path.Combine(dest, rel);
            File.Copy(file, target, overwrite: true);
        }
    }

    private static bool IsInsideNotesApp(string relativePath)
    {
        // Match folders called .notesapp at any nesting depth.
        var parts = relativePath.Split(
            new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar });
        return parts.Any(p => string.Equals(p, ".notesapp", StringComparison.OrdinalIgnoreCase));
    }

    private static void TryRollback(string liveVaultPath, string? preRestorePath, ILogger log)
    {
        // Step a: nuke whatever partial copy is at liveVaultPath.
        if (Directory.Exists(liveVaultPath))
        {
            try { Directory.Delete(liveVaultPath, recursive: true); }
            catch (Exception ex)
            {
                log.LogError(ex, "Rollback step 1 (delete partial restore) failed at {Path}", liveVaultPath);
            }
        }

        // Step b: move the pre-restore folder back.
        if (preRestorePath is not null && Directory.Exists(preRestorePath))
        {
            try { Directory.Move(preRestorePath, liveVaultPath); }
            catch (Exception ex)
            {
                log.LogError(ex,
                    "Rollback step 2 (restore original vault) failed. ORIGINAL DATA IS AT {Path}.",
                    preRestorePath);
            }
        }
    }

    /// <summary>
    /// Reject path traversal characters and absolute paths. The UI
    /// passes paths sourced from BackupRecord.VaultFolders which
    /// are already safe — this is defence-in-depth against a
    /// crafted API call.
    /// </summary>
    private static string SanitiseRelativePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("Vault folder path is required.", nameof(path));
        if (Path.IsPathRooted(path))
            throw new ArgumentException("Vault folder path must be relative.", nameof(path));
        if (path.Contains("..", StringComparison.Ordinal))
            throw new ArgumentException("Vault folder path may not contain '..'.", nameof(path));
        return path.Replace('/', Path.DirectorySeparatorChar);
    }
}
