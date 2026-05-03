namespace NoteControl.Server.Backups;

/// <summary>
/// Server-side view of a single backup directory on the target
/// drive. Built by walking the backup target folder and inspecting
/// each <c>{timestamp}/</c> entry's manifest file.
/// </summary>
/// <param name="Id">
/// The folder name itself, sortable timestamp form
/// <c>2026-04-29T03-30-00Z</c>. Used as the URL path segment so
/// callers don't have to decode/encode.
/// </param>
/// <param name="CreatedAt">Parsed from <see cref="Id"/>.</param>
/// <param name="AbsolutePath">Full path to the backup folder.</param>
/// <param name="SizeBytes">Sum of all files inside (recursive).</param>
/// <param name="VaultFolders">
/// Names of vault subfolders inside the backup, e.g.
/// <c>["users/admin/Default", "shared/Team"]</c>. Used by the
/// restore UI to populate the "which vault" dropdown.
/// </param>
public sealed record BackupRecord(
    string Id,
    DateTimeOffset CreatedAt,
    string AbsolutePath,
    long SizeBytes,
    IReadOnlyList<string> VaultFolders);
