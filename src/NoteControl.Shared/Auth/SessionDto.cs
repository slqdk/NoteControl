namespace NoteControl.Shared.Auth;

/// <summary>
/// Public projection of an active session, used by the admin "View Sessions"
/// window. Does not include the token hash or any other credential material.
/// </summary>
public sealed record SessionDto(
    Guid Id,
    Guid UserId,
    DateTimeOffset CreatedAt,
    DateTimeOffset LastActivityAt,
    DateTimeOffset ExpiresAt,
    string? IpAddress,
    string? UserAgent,
    bool IsCurrent);
