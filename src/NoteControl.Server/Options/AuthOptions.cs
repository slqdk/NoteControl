using System.ComponentModel.DataAnnotations;

namespace NoteControl.Server.Options;

/// <summary>
/// Authentication, session, and password-policy settings. Binds to the
/// "Auth" section of appsettings.json. Most defaults match the spec
/// (12-char minimum password, 12-hour idle session, 7-day absolute session).
/// </summary>
public sealed class AuthOptions
{
    public const string SectionName = "Auth";

    /// <summary>
    /// Name of the session cookie. Kept short and unbranded to reduce
    /// fingerprinting. Do not change after deployment without invalidating
    /// existing sessions.
    /// </summary>
    [Required]
    public string SessionCookieName { get; set; } = "nc_sid";

    /// <summary>
    /// Name of the CSRF cookie used in the double-submit pattern.
    /// </summary>
    [Required]
    public string CsrfCookieName { get; set; } = "nc_csrf";

    /// <summary>
    /// HTTP header the client must echo the CSRF token back in.
    /// </summary>
    [Required]
    public string CsrfHeaderName { get; set; } = "X-CSRF-Token";

    /// <summary>
    /// Idle timeout in minutes. A session not touched for this long is invalid.
    /// </summary>
    [Range(1, 60 * 24 * 30)]
    public int IdleTimeoutMinutes { get; set; } = 60 * 12; // 12 hours

    /// <summary>
    /// Absolute lifetime in minutes. A session is invalid past this point
    /// regardless of activity.
    /// </summary>
    [Range(1, 60 * 24 * 365)]
    public int AbsoluteTimeoutMinutes { get; set; } = 60 * 24 * 7; // 7 days

    /// <summary>
    /// Mark the session/CSRF cookies as Secure. Defaults to true; set to
    /// false in Development if you are testing over plain HTTP without a
    /// reverse proxy.
    /// </summary>
    public bool RequireSecureCookies { get; set; } = true;

    /// <summary>
    /// Password policy. Spec mandates 12 minimum.
    /// </summary>
    [Range(8, 256)]
    public int MinimumPasswordLength { get; set; } = 12;

    /// <summary>
    /// Check incoming passwords against the HaveIBeenPwned k-anonymity API.
    /// Off by default — turn on in production once outbound HTTPS is verified.
    /// </summary>
    public bool CheckPasswordAgainstHibp { get; set; } = false;

    /// <summary>
    /// Per-IP login rate limit: failed attempts permitted in the window
    /// before the IP is rejected for the rest of the window.
    /// </summary>
    [Range(1, 1000)]
    public int LoginAttemptsPerIpPerMinute { get; set; } = 5;

    /// <summary>
    /// Per-account lockout: failed attempts in the window before the account
    /// is temporarily locked.
    /// </summary>
    [Range(1, 1000)]
    public int LoginAttemptsPerAccountPerHour { get; set; } = 10;

    /// <summary>
    /// How long an account stays locked after the per-account threshold trips.
    /// </summary>
    [Range(1, 60 * 24 * 7)]
    public int AccountLockoutMinutes { get; set; } = 30;

    /// <summary>
    /// Bootstrap settings used only on first run when the database has zero
    /// users. Once an admin exists these values are ignored.
    /// </summary>
    [Required]
    public BootstrapAdminOptions BootstrapAdmin { get; set; } = new();
}

/// <summary>
/// Settings for the seeded first administrator account. The password should
/// be supplied via environment variable or user-secrets in real deployments,
/// not committed to source control.
/// </summary>
public sealed class BootstrapAdminOptions
{
    /// <summary>Username of the seeded admin. Default: "admin".</summary>
    [Required]
    public string Username { get; set; } = "admin";

    /// <summary>
    /// Email address of the seeded admin. Required because the spec uses
    /// email for password resets and login notifications.
    /// </summary>
    [Required, EmailAddress]
    public string Email { get; set; } = "admin@localhost";

    /// <summary>
    /// Initial password for the seeded admin. If null, a random password is
    /// generated and written to the server log on first boot. The admin
    /// should change it immediately after logging in.
    /// </summary>
    public string? Password { get; set; }
}
