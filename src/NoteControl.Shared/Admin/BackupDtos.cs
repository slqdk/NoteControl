namespace NoteControl.Shared.Admin;

/// <summary>Status snapshot returned by GET /api/admin/server/backup/status.</summary>
public sealed record BackupStatusDto(
    bool Running,
    DateTimeOffset? LastRunAt,
    bool? LastRunSuccess,
    string? LastRunError,
    long? LastRunDurationMs,
    string? CurrentTargetPath,
    int BackupCount,
    long TotalBytes);

/// <summary>Result of POST /api/admin/server/backup/run.</summary>
public sealed record BackupRunResultDto(
    bool Success,
    string? BackupId,
    string? Error,
    long DurationMs,
    long BytesCopied);

/// <summary>One entry in GET /api/admin/server/backup/list.</summary>
public sealed record BackupListItemDto(
    string Id,
    DateTimeOffset CreatedAt,
    long SizeBytes,
    string AbsolutePath,
    IReadOnlyList<string> VaultFolders);

/// <summary>Body for POST /api/admin/server/backup/{id}/restore-vault.</summary>
public sealed record RestoreVaultRequest(
    Guid VaultId,
    string VaultFolderInBackup);

/// <summary>Result of a restore operation.</summary>
public sealed record RestoreResultDto(
    bool Success,
    string? Error,
    string? PreRestoreFolderPath,
    long DurationMs);
