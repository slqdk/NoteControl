using NoteControl.Shared.Admin;
using NoteControl.Shared.Auth;
using NoteControl.Shared.Vaults;

namespace NoteControl.Tray.Admin.Client;

/// <summary>
/// The set of admin operations the tray's admin windows can perform.
/// Today this is implemented over HTTP via <see cref="HttpAdminClient"/>;
/// later it moves to a Windows named-pipe transport without the windows
/// noticing — that's the whole reason this interface exists.
/// </summary>
public interface IAdminClient
{
    bool IsLoggedIn { get; }
    UserDto? CurrentUser { get; }

    Task LoginAsync(string username, string password, CancellationToken ct = default);

    /// <summary>
    /// Try to log in using the local-machine tray token (the one
    /// the server writes to <c>{DataRoot}/.server/tray.token</c>
    /// at startup). Returns true on success, false if the file is
    /// missing or rejected — caller falls back to interactive
    /// login.
    /// </summary>
    Task<bool> TryLocalTokenLoginAsync(CancellationToken ct = default);

    Task LogoutAsync(CancellationToken ct = default);

    // -- Users --
    Task<IReadOnlyList<UserDto>> ListUsersAsync(CancellationToken ct = default);
    Task<UserDto> CreateUserAsync(CreateUserRequest request, CancellationToken ct = default);
    Task<UserDto> UpdateUserAsync(Guid id, UpdateUserRequest request, CancellationToken ct = default);
    Task DeleteUserAsync(Guid id, CancellationToken ct = default);
    Task ChangePasswordAsync(Guid userId, ChangePasswordRequest request, CancellationToken ct = default);

    Task<IReadOnlyList<SessionDto>> ListSessionsAsync(Guid userId, CancellationToken ct = default);
    Task RevokeSessionAsync(Guid sessionId, CancellationToken ct = default);

    // -- Vaults --
    /// <summary>
    /// List vaults. By default returns only vaults the caller has a
    /// permission on (the historical behaviour). When
    /// <paramref name="all"/> is true AND the caller is admin, the
    /// server returns every vault on the server with MyRole reflecting
    /// the caller's permission ("none" for vaults they have no role on).
    /// Non-admins passing all=true silently get the filtered view.
    /// </summary>
    Task<IReadOnlyList<VaultDto>> ListVaultsAsync(bool all = false, CancellationToken ct = default);
    Task<VaultDto> CreateVaultAsync(CreateVaultRequest request, CancellationToken ct = default);

    /// <summary>
    /// Adopt an EXISTING on-disk folder as a vault. The folder must
    /// already live at <c>{DataRoot}/{request.Path}</c> on the server's
    /// filesystem -- the server validates and refuses if the folder
    /// is missing. After registering, the server kicks off a background
    /// search-index rebuild; the response returns immediately.
    /// </summary>
    Task<VaultDto> RegisterVaultAsync(RegisterVaultRequest request, CancellationToken ct = default);

    Task DeleteVaultAsync(Guid vaultId, CancellationToken ct = default);
    Task<IReadOnlyList<VaultMemberDto>> ListVaultMembersAsync(Guid vaultId, CancellationToken ct = default);
    Task<VaultMemberDto> ShareVaultAsync(Guid vaultId, ShareVaultRequest request, CancellationToken ct = default);
    Task UnshareVaultAsync(Guid vaultId, Guid userId, CancellationToken ct = default);

    /// <summary>
    /// Ship 52: install bundled sample data into a vault. Owner-or-admin
    /// only; the server-side endpoint enforces the permission gate. On
    /// success the server kicks off a background search-index rebuild
    /// — same pattern Register uses — so the new notes show up in
    /// search within a few seconds. The response carries the file +
    /// folder counts the tray surfaces in the status bar.
    /// </summary>
    Task<InstallSampleDataResponse> InstallSampleDataAsync(Guid vaultId, CancellationToken ct = default);

    // -- Server config (step 16) --
    Task<ServerConfigDto> GetServerConfigAsync(CancellationToken ct = default);
    Task<ServerConfigDto> UpdateServerConfigAsync(ServerConfigDto config, CancellationToken ct = default);
    Task<TestSmtpResponse> TestSmtpAsync(string to, CancellationToken ct = default);

    // -- Backups (step 18) --
    Task<BackupStatusDto> GetBackupStatusAsync(CancellationToken ct = default);
    Task<BackupRunResultDto> RunBackupAsync(CancellationToken ct = default);
    Task<IReadOnlyList<BackupListItemDto>> ListBackupsAsync(CancellationToken ct = default);
    Task DeleteBackupAsync(string id, CancellationToken ct = default);
    Task<RestoreResultDto> RestoreVaultFromBackupAsync(
        string backupId, Guid vaultId, string vaultFolderInBackup, CancellationToken ct = default);

    // -- Audit + Logs (step 19) --
    Task<IReadOnlyList<AuditEntryDto>> QueryAuditAsync(
        DateTimeOffset? since, DateTimeOffset? until, Guid? userId, string? eventType, int limit,
        CancellationToken ct = default);
    Task<IReadOnlyList<string>> ListAuditEventTypesAsync(CancellationToken ct = default);
    Task<ServerLogTailDto> TailServerLogAsync(int lines, CancellationToken ct = default);
}

/// <summary>
/// Thrown when a server call fails. Message is the human-readable problem
/// title (RFC 7807) where available, suitable for showing in a MessageBox.
/// </summary>
public sealed class AdminClientException : Exception
{
    public int? StatusCode { get; }

    public AdminClientException(string message, int? statusCode = null, Exception? inner = null)
        : base(message, inner)
    {
        StatusCode = statusCode;
    }
}
