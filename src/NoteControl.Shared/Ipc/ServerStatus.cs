namespace NoteControl.Shared.Ipc;

/// <summary>
/// Snapshot of the server's current state, returned by <see cref="AdminMethods.ServerStatus"/>.
/// </summary>
public sealed record ServerStatus(
    string Version,
    bool IsRunning,
    DateTimeOffset StartedAt,
    int ActiveUserCount,
    int ActiveSessionCount,
    long TotalLoginsToday,
    long FailedLoginsLastHour);
