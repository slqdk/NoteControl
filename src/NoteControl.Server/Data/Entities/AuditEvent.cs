namespace NoteControl.Server.Data.Entities;

/// <summary>
/// A security- or admin-relevant event: logins, login failures, permission
/// changes, etc. This is write-once; rows are never updated in place.
/// </summary>
public sealed class AuditEvent
{
    public long Id { get; set; }

    public DateTimeOffset Timestamp { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>
    /// Short identifier like "login.success", "login.failure", "user.created",
    /// "vault.shared", "admin.config.changed".
    /// </summary>
    public string EventType { get; set; } = string.Empty;

    public Guid? UserId { get; set; }
    public string? IpAddress { get; set; }

    /// <summary>Free-form JSON blob with event-specific details.</summary>
    public string? Details { get; set; }
}
