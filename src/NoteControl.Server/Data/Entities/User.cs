namespace NoteControl.Server.Data.Entities;

/// <summary>
/// A NoteControl account. Password authentication in v1; the TotpSecret
/// column is reserved for the 2FA work in a later milestone.
/// </summary>
public sealed class User
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string Username { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;

    /// <summary>Argon2id hash of the user's password (encoded form).</summary>
    public string PasswordHash { get; set; } = string.Empty;

    /// <summary>Reserved for TOTP 2FA; null until enrolled.</summary>
    public string? TotpSecret { get; set; }

    /// <summary>"admin" or "user".</summary>
    public string Role { get; set; } = "user";

    /// <summary>"active", "locked", or "disabled".</summary>
    public string Status { get; set; } = "active";

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? LastLoginAt { get; set; }
    public string? LastLoginIp { get; set; }
}
