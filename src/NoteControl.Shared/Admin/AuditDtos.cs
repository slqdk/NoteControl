namespace NoteControl.Shared.Admin;

/// <summary>One row in the Audit tab.</summary>
public sealed record AuditEntryDto(
    long Id,
    DateTimeOffset Timestamp,
    string EventType,
    Guid? UserId,
    string? Username,
    string? IpAddress,
    string? Details);

/// <summary>One parsed line from the Serilog file.</summary>
public sealed record ServerLogLineDto(
    DateTimeOffset Timestamp,
    string Level,        // Verbose | Debug | Information | Warning | Error | Fatal
    string Message);

/// <summary>Result of GET /api/admin/server/logs/tail.</summary>
public sealed record ServerLogTailDto(
    IReadOnlyList<ServerLogLineDto> Lines,
    string? LogFilePath,
    string? Note);
