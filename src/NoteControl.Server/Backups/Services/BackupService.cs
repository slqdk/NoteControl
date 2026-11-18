using System.Globalization;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Options;
using NoteControl.Server.Options;

namespace NoteControl.Server.Backups.Services;

/// <summary>
/// Backup engine. Walks the data root, copies every vault folder
/// and the <c>.server/</c> folder to a timestamped subdirectory of
/// the configured target path. The two SQLite databases the server
/// itself keeps open — <c>.server/server.db</c> and each vault's
/// <c>.notesapp/index.db</c> — are snapshotted via <c>VACUUM INTO</c>
/// so they're consistent even while the server is taking writes.
/// Every other file is a plain copy, whatever its extension (a
/// <c>Thumbs.db</c> in an assets folder is just a file).
/// <para>
/// Not copied: the local tray token, the CSRF key and
/// <c>server.url</c> (secrets / per-start state the server recreates —
/// a backup on a NAS must not hand out a working admin token), the
/// SQLite <c>-wal</c>/<c>-shm</c> sidecars of the snapshotted
/// databases, and in-flight <c>*.nc-tmp</c> atomic-write temp files.
/// </para>
/// <para>
/// A file that can't be read (locked by another program, permission
/// denied) is logged, listed in the manifest's <c>skipped</c> array
/// and reported as a warning — it no longer aborts the whole run.
/// Only a failure to snapshot <c>server.db</c> (users, vaults,
/// permissions) fails the backup.
/// </para>
/// <para>
/// Retention pruning runs at the END of a successful backup —
/// failures don't trigger pruning, so a series of failed runs can
/// never destroy your prior backups.
/// </para>
/// <para>
/// One backup at a time. Concurrent <see cref="RunNowAsync"/>
/// calls return the in-progress status instead of starting a
/// second run.
/// </para>
/// </summary>
public interface IBackupService
{
    /// <summary>
    /// Run a backup synchronously — returns when the copy is done.
    /// For typical solo-user vaults that's seconds; for vaults with
    /// many notes it can be a minute or more. The HTTP endpoint
    /// long-polls.
    /// </summary>
    Task<BackupRunResult> RunNowAsync(CancellationToken ct = default);

    /// <summary>List existing backups in the target folder.</summary>
    IReadOnlyList<BackupRecord> List();

    /// <summary>Look up one backup by id (the timestamp folder name).</summary>
    BackupRecord? GetById(string id);

    /// <summary>Delete one backup (recursive folder remove).</summary>
    void DeleteOne(string id);

    /// <summary>
    /// Snapshot of the most recent run's status. Returned by the
    /// /status endpoint; used by the BackupsWindow status panel.
    /// </summary>
    BackupRunStatus GetStatus();
}

/// <summary>Outcome of a single run, returned to the caller.</summary>
public sealed record BackupRunResult(
    bool Success,
    string? BackupId,
    string? Error,
    long DurationMs,
    long BytesCopied);

/// <summary>Status snapshot for the UI.</summary>
public sealed record BackupRunStatus(
    bool Running,
    DateTimeOffset? LastRunAt,
    bool? LastRunSuccess,
    string? LastRunError,
    long? LastRunDurationMs,
    string? CurrentTargetPath,
    int BackupCount,
    long TotalBytes);

public sealed class BackupService : IBackupService
{
    // Format: 2026-04-29T03-30-00Z. Lex-sortable, Windows-safe
    // (no colons), UTC-explicit. The retention pruner relies on
    // this being lex-sortable to find the oldest folders.
    private const string IdFormat = "yyyy-MM-ddTHH-mm-ssZ";
    private const string ManifestFileName = "backup.manifest.json";

    private readonly IOptionsMonitor<StorageOptions> _storage;
    private readonly IOptionsMonitor<BackupOptions> _backup;
    private readonly ILogger<BackupService> _log;

    private readonly SemaphoreSlim _runLock = new(1, 1);

    // Last-run state. Mutable but only written under _runLock.
    // Reads of these fields are racy-but-harmless: a stale
    // "running" false right after a run starts is an acceptable
    // UI artefact.
    private DateTimeOffset? _lastRunAt;
    private bool? _lastRunSuccess;
    private string? _lastRunError;
    private long? _lastRunDurationMs;

    public BackupService(
        IOptionsMonitor<StorageOptions> storage,
        IOptionsMonitor<BackupOptions> backup,
        ILogger<BackupService> log)
    {
        _storage = storage;
        _backup = backup;
        _log = log;
    }

    // -----------------------------------------------------------------
    // Run
    // -----------------------------------------------------------------

    public async Task<BackupRunResult> RunNowAsync(CancellationToken ct = default)
    {
        var target = _backup.CurrentValue.TargetPath;
        if (string.IsNullOrWhiteSpace(target))
        {
            return new BackupRunResult(false, null,
                "Backup target path is not configured. Set it in Server Settings → Backups.",
                0, 0);
        }

        if (!await _runLock.WaitAsync(0, ct))
        {
            return new BackupRunResult(false, null,
                "A backup is already running.", 0, 0);
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var now = DateTimeOffset.UtcNow;
        var id = now.ToString(IdFormat, CultureInfo.InvariantCulture);
        var dataRoot = _storage.CurrentValue.DataRoot;
        var backupRoot = Path.Combine(target, id);
        var createdRoot = false;
        long bytesCopied = 0;
        var skipped = new List<string>();

        try
        {
            // 1. Validate paths.
            if (!Directory.Exists(dataRoot))
            {
                throw new InvalidOperationException(
                    $"Data root '{dataRoot}' does not exist or isn't readable.");
            }
            if (IsSameOrUnder(target, dataRoot))
            {
                // Would copy the backups into themselves until the
                // path gets too long, and a backup on the same folder
                // tree as the data isn't a backup anyway.
                throw new InvalidOperationException(
                    $"Backup target '{target}' is inside the data root '{dataRoot}'. " +
                    "Choose a folder outside it (ideally on another disk or a NAS).");
            }
            Directory.CreateDirectory(target);

            // Two runs in the same second (double-click on Run now,
            // manual run as the schedule fires) would share a folder,
            // and the second one's failure cleanup would delete the
            // first one's backup. Step to the next free second.
            while (Directory.Exists(backupRoot))
            {
                now = now.AddSeconds(1);
                id = now.ToString(IdFormat, CultureInfo.InvariantCulture);
                backupRoot = Path.Combine(target, id);
            }
            Directory.CreateDirectory(backupRoot);
            createdRoot = true;

            _log.LogInformation("Backup {Id} starting → {Target}", id, backupRoot);

            // 2. Walk the data root. Each top-level entry is either
            //    a vault tree (users/, shared/) or the special .server/
            //    folder. See the class remarks for which files get a
            //    SQLite snapshot, which are left out, and how
            //    unreadable files are handled.
            //
            //    NOTE: we deliberately skip files we don't recognise
            //    at the data-root level. The data root should only
            //    contain known subfolders.
            foreach (var entry in Directory.EnumerateDirectories(dataRoot))
            {
                ct.ThrowIfCancellationRequested();
                var name = Path.GetFileName(entry);
                var dest = Path.Combine(backupRoot, name);

                bytesCopied += await CopyDirectoryAsync(entry, dest, name, skipped, ct);
            }

            // 3. Write a small manifest so callers / future tooling
            //    can identify a backup folder without parsing the
            //    folder name.
            await WriteManifestAsync(backupRoot, id, dataRoot, bytesCopied, skipped, ct);

            // 4. Retention pruning. Errors here don't fail the run —
            //    we already have a good backup; pruning is best-effort.
            try
            {
                PruneRetention(target);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Retention pruning failed but backup {Id} succeeded.", id);
            }

            sw.Stop();
            // Success with skipped files: still a usable backup, but
            // say so — Error doubles as the warning text (the tray
            // shows it next to the ✓).
            var warning = skipped.Count == 0
                ? null
                : $"{skipped.Count} file(s) could not be copied and are missing from this backup: " +
                  string.Join(", ", skipped.Take(5)) +
                  (skipped.Count > 5 ? ", …" : "") +
                  " (full list in the backup's manifest and the server log).";
            _lastRunAt = DateTimeOffset.UtcNow;
            _lastRunSuccess = true;
            _lastRunError = warning;
            _lastRunDurationMs = sw.ElapsedMilliseconds;

            _log.LogInformation(
                "Backup {Id} succeeded ({Bytes} bytes, {Ms} ms, {Skipped} skipped).",
                id, bytesCopied, sw.ElapsedMilliseconds, skipped.Count);

            return new BackupRunResult(true, id, warning, sw.ElapsedMilliseconds, bytesCopied);
        }
        catch (Exception ex)
        {
            sw.Stop();
            _lastRunAt = DateTimeOffset.UtcNow;
            _lastRunSuccess = false;
            _lastRunError = ex.Message;
            _lastRunDurationMs = sw.ElapsedMilliseconds;

            _log.LogError(ex, "Backup {Id} failed.", id);

            // Try to clean up the half-finished folder so the next
            // run doesn't see it. Best-effort; if cleanup fails,
            // the user can delete it manually.
            try
            {
                // Only ever delete the folder THIS run created.
                if (createdRoot && Directory.Exists(backupRoot))
                {
                    Directory.Delete(backupRoot, recursive: true);
                }
            }
            catch { /* ignored */ }

            return new BackupRunResult(false, null, ex.Message, sw.ElapsedMilliseconds, bytesCopied);
        }
        finally
        {
            _runLock.Release();
        }
    }

    /// <summary>What happens to one file under DataRoot.</summary>
    public enum FileAction
    {
        Copy,
        /// <summary>VACUUM INTO; failure fails the backup.</summary>
        SnapshotRequired,
        /// <summary>VACUUM INTO; failure skips the file (derived data).</summary>
        SnapshotOptional,
        Exclude,
    }

    /// <summary>
    /// Classify a file by its path relative to DataRoot (any
    /// separator). Pure — unit-tested.
    /// </summary>
    public static FileAction Classify(string relativeToDataRoot)
    {
        var parts = relativeToDataRoot.Split(
            new[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return FileAction.Exclude;
        var name = parts[^1];
        var parent = parts.Length >= 2 ? parts[^2] : "";

        if (name.EndsWith(".nc-tmp", StringComparison.OrdinalIgnoreCase))
            return FileAction.Exclude; // in-flight atomic write

        if (parts.Length == 2 && string.Equals(parts[0], ".server", StringComparison.OrdinalIgnoreCase))
        {
            foreach (var secret in ServerStateExcludes)
            {
                if (string.Equals(name, secret, StringComparison.OrdinalIgnoreCase))
                    return FileAction.Exclude;
            }
            if (string.Equals(name, "server.db", StringComparison.OrdinalIgnoreCase))
                return FileAction.SnapshotRequired;
            if (name.StartsWith("server.db-", StringComparison.OrdinalIgnoreCase))
                return FileAction.Exclude; // -wal / -shm / -journal
        }

        if (string.Equals(parent, ".notesapp", StringComparison.OrdinalIgnoreCase))
        {
            if (string.Equals(name, "index.db", StringComparison.OrdinalIgnoreCase))
                return FileAction.SnapshotOptional;
            if (name.StartsWith("index.db-", StringComparison.OrdinalIgnoreCase))
                return FileAction.Exclude;
        }

        return FileAction.Copy;
    }

    /// <summary>
    /// <c>.server/</c> files that never go into a backup: the local
    /// tray token (an admin login while the server runs), the CSRF
    /// signing key, and the per-start URL file. The server recreates
    /// all three on start.
    /// </summary>
    private static readonly string[] ServerStateExcludes = { "tray.token", "csrf.key", "server.url" };

    /// <summary>
    /// Copy <paramref name="source"/> (DataRoot-relative
    /// <paramref name="relRoot"/>) to <paramref name="dest"/>
    /// recursively, applying <see cref="Classify"/> per file.
    /// Unreadable files and folders are added to
    /// <paramref name="skipped"/> instead of aborting the run.
    /// <para>
    /// Returns <c>Task&lt;long&gt;</c> rather than just <c>long</c>
    /// so the call site can stay <c>await</c>-shaped. Today the work
    /// is sync (File.Copy + SQLite VACUUM INTO are both blocking).
    /// </para>
    /// </summary>
    private Task<long> CopyDirectoryAsync(
        string source, string dest, string relRoot, List<string> skipped, CancellationToken ct)
    {
        long bytes = 0;
        var pending = new Stack<(string Src, string Dst, string Rel)>();
        pending.Push((source, dest, relRoot));

        while (pending.Count > 0)
        {
            ct.ThrowIfCancellationRequested();
            var (src, dst, rel) = pending.Pop();
            Directory.CreateDirectory(dst);

            string[] files, dirs;
            try
            {
                files = Directory.GetFiles(src);
                dirs = Directory.GetDirectories(src);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _log.LogWarning(ex, "Backup: cannot read folder {Path}; skipped.", src);
                skipped.Add(rel + "/");
                continue;
            }

            foreach (var file in files)
            {
                ct.ThrowIfCancellationRequested();
                var name = Path.GetFileName(file);
                var fileRel = rel + "/" + name;
                var target = Path.Combine(dst, name);
                var action = Classify(fileRel);
                if (action == FileAction.Exclude) continue;

                try
                {
                    if (action == FileAction.Copy)
                    {
                        // Plain copy. File.Copy is sync but already
                        // buffered; for IO-bound work sync vs async is
                        // a wash.
                        File.Copy(file, target, overwrite: true);
                        bytes += new FileInfo(target).Length;
                    }
                    else
                    {
                        bytes += SqliteSnapshot(file, target);
                    }
                }
                catch (Exception ex) when (action != FileAction.SnapshotRequired
                                           && ex is not OperationCanceledException)
                {
                    _log.LogWarning(ex, "Backup: could not copy {Path}; skipped.", file);
                    skipped.Add(fileRel);
                    try { if (File.Exists(target)) File.Delete(target); } catch { /* ignored */ }
                }
            }

            foreach (var dir in dirs)
            {
                var name = Path.GetFileName(dir);
                pending.Push((dir, Path.Combine(dst, name), rel + "/" + name));
            }
        }

        return Task.FromResult(bytes);
    }

    /// <summary>True when <paramref name="path"/> equals or is inside <paramref name="root"/>.</summary>
    public static bool IsSameOrUnder(string path, string root)
    {
        var p = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        var r = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        return string.Equals(p, r, StringComparison.OrdinalIgnoreCase)
            || p.StartsWith(r + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Use SQLite's <c>VACUUM INTO</c> to write a consistent
    /// snapshot of <paramref name="source"/> to <paramref name="dest"/>.
    /// This works regardless of whether the source database is
    /// currently open by readers or writers — it takes a shared
    /// read lock for the duration and produces a clean copy with
    /// no WAL/SHM sidecars needed.
    /// </summary>
    internal static long SqliteSnapshot(string source, string dest)
    {
        // Open in read-only mode so we never accidentally modify
        // the live DB. Mode=ReadOnly + Cache=Shared lets us coexist
        // with the running server's connections.
        // Pooling = false: a pooled handle would stay open on the live
        // file after we're done, and on Windows an open index.db
        // blocks moving its vault folder (restore, vault delete).
        var connStr = new SqliteConnectionStringBuilder
        {
            DataSource = source,
            Mode = SqliteOpenMode.ReadOnly,
            Cache = SqliteCacheMode.Shared,
            Pooling = false,
        }.ToString();

        // Make sure the destination doesn't exist — VACUUM INTO
        // refuses to overwrite.
        if (File.Exists(dest)) File.Delete(dest);

        using (var conn = new SqliteConnection(connStr))
        {
            conn.Open();
            using var cmd = conn.CreateCommand();
            // Parameters can't be used for VACUUM INTO's filename;
            // it's a literal in SQLite's grammar. We escape single
            // quotes by doubling them, the SQL standard way.
            var quoted = "'" + dest.Replace("'", "''") + "'";
            cmd.CommandText = $"VACUUM INTO {quoted};";
            cmd.ExecuteNonQuery();
        }

        return new FileInfo(dest).Length;
    }

    private static async Task WriteManifestAsync(
        string backupRoot, string id, string dataRoot, long bytes,
        IReadOnlyList<string> skipped, CancellationToken ct)
    {
        var manifest = new
        {
            id,
            createdAt = DateTimeOffset.UtcNow,
            dataRoot,
            bytesCopied = bytes,
            skipped,
            schemaVersion = 1,
        };
        var path = Path.Combine(backupRoot, ManifestFileName);
        await using var fs = File.Create(path);
        await System.Text.Json.JsonSerializer.SerializeAsync(
            fs, manifest, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }, ct);
    }

    // -----------------------------------------------------------------
    // Listing / deletion
    // -----------------------------------------------------------------

    public IReadOnlyList<BackupRecord> List()
    {
        var target = _backup.CurrentValue.TargetPath;
        if (string.IsNullOrWhiteSpace(target) || !Directory.Exists(target))
        {
            return Array.Empty<BackupRecord>();
        }

        var results = new List<BackupRecord>();
        foreach (var dir in Directory.EnumerateDirectories(target))
        {
            var name = Path.GetFileName(dir);
            if (!TryParseId(name, out var createdAt)) continue;

            results.Add(new BackupRecord(
                Id: name,
                CreatedAt: createdAt,
                AbsolutePath: dir,
                SizeBytes: ComputeSize(dir),
                VaultFolders: ListVaultFolders(dir)));
        }
        // Most recent first — what the UI wants for the list view.
        results.Sort((a, b) => b.CreatedAt.CompareTo(a.CreatedAt));
        return results;
    }

    public BackupRecord? GetById(string id)
    {
        var target = _backup.CurrentValue.TargetPath;
        if (string.IsNullOrWhiteSpace(target)) return null;
        var dir = Path.Combine(target, id);
        if (!Directory.Exists(dir)) return null;
        if (!TryParseId(id, out var createdAt)) return null;

        return new BackupRecord(
            Id: id,
            CreatedAt: createdAt,
            AbsolutePath: dir,
            SizeBytes: ComputeSize(dir),
            VaultFolders: ListVaultFolders(dir));
    }

    public void DeleteOne(string id)
    {
        var record = GetById(id) ?? throw new FileNotFoundException(
            $"Backup '{id}' was not found.");
        Directory.Delete(record.AbsolutePath, recursive: true);
    }

    /// <summary>
    /// Walk the target folder and remove old backups according to
    /// <c>RetainDailyCount</c>. Weekly retention is honoured by
    /// keeping every Nth backup; for v1 we use the simpler rule
    /// "keep newest <c>RetainDailyCount</c>, delete the rest" and
    /// note <c>RetainWeeklyCount</c> as a stored-but-not-yet-applied
    /// value. (Adding proper weekly rotation is an obvious next
    /// iteration.)
    /// </summary>
    private void PruneRetention(string target)
    {
        var retainDaily = _backup.CurrentValue.RetainDailyCount;
        if (retainDaily <= 0) return;

        var all = Directory.EnumerateDirectories(target)
            .Select(d => new { Path = d, Name = Path.GetFileName(d) })
            .Where(x => TryParseId(x.Name, out _))
            .OrderByDescending(x => x.Name, StringComparer.Ordinal)
            .ToList();

        // Keep first N (most recent), delete the rest.
        for (int i = retainDaily; i < all.Count; i++)
        {
            try
            {
                Directory.Delete(all[i].Path, recursive: true);
                _log.LogInformation("Retention removed old backup {Id}", all[i].Name);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Could not remove old backup {Id}", all[i].Name);
            }
        }
    }

    // -----------------------------------------------------------------
    // Status
    // -----------------------------------------------------------------

    public BackupRunStatus GetStatus()
    {
        var list = List();
        return new BackupRunStatus(
            Running: _runLock.CurrentCount == 0,
            LastRunAt: _lastRunAt,
            LastRunSuccess: _lastRunSuccess,
            LastRunError: _lastRunError,
            LastRunDurationMs: _lastRunDurationMs,
            CurrentTargetPath: _backup.CurrentValue.TargetPath,
            BackupCount: list.Count,
            TotalBytes: list.Sum(b => b.SizeBytes));
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    private static bool TryParseId(string name, out DateTimeOffset created)
    {
        // 2026-04-29T03-30-00Z → parseable as DateTimeOffset after
        // restoring the colons. We only do this for retention/listing,
        // so a parse failure means "not one of our backups, skip."
        if (name.Length < IdFormat.Length)
        {
            created = default;
            return false;
        }
        // Replace the dashes between H, M, S back to colons.
        // Safer to do positional: characters 13 and 16 (the two
        // separators between time components).
        if (name.Length < 20 || name[10] != 'T' || !name.EndsWith("Z"))
        {
            created = default;
            return false;
        }
        var spliced = name.Substring(0, 13) + ":" + name.Substring(14, 2) + ":" + name.Substring(17);
        return DateTimeOffset.TryParse(
            spliced, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out created);
    }

    private static long ComputeSize(string dir)
    {
        long total = 0;
        try
        {
            foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
            {
                try { total += new FileInfo(f).Length; }
                catch { /* file disappeared, ignored */ }
            }
        }
        catch { /* directory disappeared, ignored */ }
        return total;
    }

    /// <summary>
    /// Walk a backup folder and return the relative paths of the
    /// vault ROOTS inside it, for the restore UI's "which vault"
    /// dropdown. A vault root is the outermost folder under
    /// <c>users/</c> or <c>shared/</c> that has a <c>.notesapp/</c>
    /// subfolder. We don't descend into a vault once found: folders
    /// created from the UI carry their own <c>.notesapp/folder-marker</c>,
    /// and listing them as vaults offered e.g.
    /// <c>users/admin/Main/Projects/2026</c> — restoring which replaced
    /// the whole live vault with that one subfolder.
    /// </summary>
    public static IReadOnlyList<string> ListVaultFolders(string backupRoot)
    {
        var found = new List<string>();
        foreach (var top in new[] { "users", "shared" })
        {
            var topPath = Path.Combine(backupRoot, top);
            if (!Directory.Exists(topPath)) continue;

            var pending = new Stack<string>();
            pending.Push(topPath);
            while (pending.Count > 0)
            {
                string[] subs;
                try { subs = Directory.GetDirectories(pending.Pop()); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { continue; }

                foreach (var sub in subs)
                {
                    if (string.Equals(Path.GetFileName(sub), ".notesapp", StringComparison.OrdinalIgnoreCase))
                        continue;
                    if (Directory.Exists(Path.Combine(sub, ".notesapp")))
                    {
                        found.Add(Path.GetRelativePath(backupRoot, sub).Replace('\\', '/'));
                    }
                    else
                    {
                        pending.Push(sub);
                    }
                }
            }
        }
        found.Sort(StringComparer.Ordinal);
        return found;
    }
}
