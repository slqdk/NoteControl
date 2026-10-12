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
///   <item>Copy the backup vault folder — everything, including
///     <c>.notesapp/</c> (templates, dashboards, assignments, note
///     widgets, release archives, trash, folder markers). Only the
///     search index (<c>.notesapp/index.db</c> + <c>-wal</c>/<c>-shm</c>)
///     is left out; it is derived data and is rebuilt from the
///     restored markdown.</item>
///   <item>Trigger an index rebuild for the vault (own DI scope).</item>
///   <item>Release the lock. The pre-restore folder stays on disk
///     until the user decides to delete it.</item>
/// </list>
/// <para>
/// If anything fails after step 2, we attempt to MOVE THE
/// PRE-RESTORE FOLDER BACK to its original name so the live
/// vault is restored to its prior state. Best-effort rollback —
/// surfaces a clear error message if even rollback fails.
/// </para>
/// <para>
/// The vault's pooled index connection is evicted before the move
/// (Windows refuses to move a folder with an open index.db; on Linux
/// the open handle would follow the moved-aside folder and the
/// rebuild would write into <c>*.pre-restore-*</c>) and again after
/// the copy, in case a read reopened it in between.
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
    private readonly IIndexConnectionPool _indexPool;
    private readonly IBackgroundIndexRebuilder _rebuilder;
    private readonly ILogger<RestoreService> _log;

    public RestoreService(
        IOptionsMonitor<StorageOptions> storage,
        IBackupService backups,
        IVaultLockService locks,
        ServerDbContext db,
        IIndexConnectionPool indexPool,
        IBackgroundIndexRebuilder rebuilder,
        ILogger<RestoreService> log)
    {
        _storage = storage;
        _backups = backups;
        _locks = locks;
        _db = db;
        _indexPool = indexPool;
        _rebuilder = rebuilder;
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
            // Only whole vaults can be restored: a sub-folder of a
            // vault would replace the entire live vault with just
            // that folder's contents.
            var wanted = safeRel.Replace('\\', '/').Trim('/');
            if (!backup.VaultFolders.Any(f => string.Equals(f, wanted, StringComparison.OrdinalIgnoreCase)))
            {
                throw new InvalidOperationException(
                    $"'{vaultFolderInBackup}' is not a vault folder in backup '{backupId}'. " +
                    "Pick one of the vaults listed for this backup.");
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
            //    doesn't collide with the `_ = ...Queue(...)` discard
            //    further down — `using var _ = ...` introduces a
            //    real (non-discardable) variable named `_`.
            using var lockHandle = _locks.Acquire(vaultId, "Vault restore in progress");

            _log.LogInformation(
                "Restore starting: vault={VaultId} backup={BackupId} folder={Folder}",
                vaultId, backupId, safeRel);

            // 4. Move the live vault aside. Only do this if it
            //    exists — fresh-vault restore (e.g. after a
            //    deletion) is also a valid use case.
            //    Release the pooled index connection first (see the
            //    class remarks). preRestorePath is only set once the
            //    move has actually happened, so a failed move never
            //    reports a pre-restore folder that doesn't exist.
            await _indexPool.EvictAsync(vaultId);
            if (Directory.Exists(liveVaultPath))
            {
                var ts = DateTimeOffset.UtcNow.ToString(
                    "yyyy-MM-ddTHH-mm-ssZ", CultureInfo.InvariantCulture);
                var aside = liveVaultPath + ".pre-restore-" + ts;
                // Two restores within one second must not collide.
                for (var n = 2; Directory.Exists(aside); n++)
                    aside = liveVaultPath + ".pre-restore-" + ts + "-" + n;
                Directory.Move(liveVaultPath, aside);
                preRestorePath = aside;
                _log.LogInformation("Moved live vault aside → {Path}", preRestorePath);
            }

            // 5. Copy the backup vault into place — everything except
            //    the search index, which is rebuilt from the restored
            //    markdown below.
            try
            {
                CopyVaultWithoutIndex(sourceVaultPath, liveVaultPath, ct);
            }
            catch (Exception copyEx)
            {
                _log.LogError(copyEx, "Restore copy failed; rolling back.");
                // Rollback: nuke whatever partial copy landed, move
                // the pre-restore folder back to its original name.
                await _indexPool.EvictAsync(vaultId);
                if (TryRollback(liveVaultPath, preRestorePath, _log))
                {
                    preRestorePath = null; // moved back — nothing left aside
                    throw new InvalidOperationException(
                        "Restore copy failed; original vault data has been rolled back.", copyEx);
                }
                throw new InvalidOperationException(
                    "Restore copy failed AND the rollback failed. The original vault data is at " +
                    (preRestorePath ?? "(nowhere — the vault folder did not exist)") + ".", copyEx);
            }

            // 6. Trigger a fresh index build in its own DI scope so
            //    the request returns promptly; the user can keep
            //    using the vault while it rebuilds. Evict again first:
            //    a search between the first eviction and the move may
            //    have reopened a connection on the old location.
            await _indexPool.EvictAsync(vaultId);
            _ = _rebuilder.Queue(vaultId, "restore");

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

    private static void CopyVaultWithoutIndex(string source, string dest, CancellationToken ct)
    {
        Directory.CreateDirectory(dest);

        foreach (var dir in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(source, dir);
            Directory.CreateDirectory(Path.Combine(dest, rel));
        }

        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            ct.ThrowIfCancellationRequested();
            var rel = Path.GetRelativePath(source, file);
            if (IsSearchIndexFile(rel)) continue;
            File.Copy(file, Path.Combine(dest, rel), overwrite: true);
        }
    }

    /// <summary>
    /// True for <c>.notesapp/index.db</c> and its <c>-wal</c> /
    /// <c>-shm</c> / <c>-journal</c> sidecars — the derived search
    /// index. Everything else under <c>.notesapp/</c> is user data
    /// (templates, dashboards, assignments, widgets, releases, trash)
    /// and must be restored.
    /// </summary>
    public static bool IsSearchIndexFile(string relativePath)
    {
        var parts = relativePath.Split(
            new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar });
        if (parts.Length < 2) return false;
        if (!string.Equals(parts[^2], ".notesapp", StringComparison.OrdinalIgnoreCase)) return false;
        var name = parts[^1];
        return string.Equals(name, "index.db", StringComparison.OrdinalIgnoreCase)
            || name.StartsWith("index.db-", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Undo a half-done restore. Returns true when the live vault is
    /// back in its original state (original moved back, or there was
    /// no original and the partial copy is gone).
    /// </summary>
    private static bool TryRollback(string liveVaultPath, string? preRestorePath, ILogger log)
    {
        // Step a: nuke whatever partial copy is at liveVaultPath.
        if (Directory.Exists(liveVaultPath))
        {
            try { Directory.Delete(liveVaultPath, recursive: true); }
            catch (Exception ex)
            {
                log.LogError(ex, "Rollback step 1 (delete partial restore) failed at {Path}", liveVaultPath);
                return false;
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
                return false;
            }
        }
        return true;
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
