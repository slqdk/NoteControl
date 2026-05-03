namespace NoteControl.Server.Data.Entities;

/// <summary>
/// Server-side session record. The session cookie sent to the browser holds
/// a random token; we only ever store its hash so the raw token cannot be
/// recovered from the database if it is ever compromised.
/// </summary>
public sealed class Session
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid UserId { get; set; }

    /// <summary>SHA-256 (or similar) of the session token sent to the client.</summary>
    public string TokenHash { get; set; } = string.Empty;

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset LastActivityAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset ExpiresAt { get; set; }

    public string? IpAddress { get; set; }
    public string? UserAgent { get; set; }

    public bool IsRevoked { get; set; }
}
