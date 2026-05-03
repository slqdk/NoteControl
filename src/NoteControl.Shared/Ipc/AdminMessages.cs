namespace NoteControl.Shared.Ipc;

/// <summary>
/// Base envelope for requests sent from the tray to the server over the
/// admin named pipe. JSON-serialized, one message per line.
/// </summary>
public sealed record AdminRequest(
    string Method,
    Guid RequestId,
    Dictionary<string, object?>? Parameters = null);

/// <summary>
/// Base envelope for responses from the server back to the tray.
/// </summary>
public sealed record AdminResponse(
    Guid RequestId,
    bool Success,
    object? Result = null,
    string? ErrorMessage = null);

/// <summary>
/// Known admin methods. Listed here so both sides stay in sync; not all are
/// implemented yet.
/// </summary>
public static class AdminMethods
{
    public const string ServerStatus = "server.status";
    public const string ServerRestart = "server.restart";

    public const string UsersList = "users.list";
    public const string UsersCreate = "users.create";
    public const string UsersResetPassword = "users.resetPassword";
    public const string UsersDisable = "users.disable";
    public const string UsersDelete = "users.delete";

    public const string SessionsList = "sessions.list";
    public const string SessionsRevoke = "sessions.revoke";

    public const string ConfigGet = "config.get";
    public const string ConfigSet = "config.set";

    public const string VaultsList = "vaults.list";
    public const string VaultsCreate = "vaults.create";
    public const string VaultsDelete = "vaults.delete";

    public const string LogsRead = "logs.read";

    public const string BackupRun = "backup.run";
    public const string BackupRestore = "backup.restore";
}
