using System.ComponentModel.DataAnnotations;

namespace NoteControl.Server.Options;

/// <summary>
/// Outbound SMTP settings used for password-reset emails and login
/// notifications. Binds to the "Smtp" section of the layered config
/// chain (appsettings.json default + per-data-folder config.json
/// overlay).
/// <para>
/// Disabled by default — the server starts fine without working
/// SMTP; features that need email simply log a warning instead of
/// sending. The admin enables it via the Settings window.
/// </para>
/// </summary>
public sealed class SmtpOptions
{
    public const string SectionName = "Smtp";

    /// <summary>
    /// Master switch. When false, all SMTP sends are no-ops (logged
    /// only). The Settings window flips this when the user fills in
    /// host + from-address.
    /// </summary>
    public bool Enabled { get; set; } = false;

    /// <summary>SMTP server hostname (e.g. "smtp.fastmail.com").</summary>
    public string Host { get; set; } = string.Empty;

    /// <summary>
    /// SMTP port. 587 for STARTTLS submission (most common), 465
    /// for implicit TLS, 25 for legacy. Defaults to 587.
    /// </summary>
    [Range(1, 65535)]
    public int Port { get; set; } = 587;

    /// <summary>
    /// "STARTTLS" (default), "SSL" (implicit TLS / port 465), or
    /// "None" (test/internal only). Stored as a string for forward
    /// compatibility — validated at the use site.
    /// </summary>
    public string Security { get; set; } = "STARTTLS";

    /// <summary>SMTP auth username (often the same as From).</summary>
    public string Username { get; set; } = string.Empty;

    /// <summary>
    /// SMTP auth password. Stored in plaintext in config.json; the
    /// folder permissions on the data root are the gate. Future work
    /// could swap this for a Windows DPAPI-encrypted blob.
    /// </summary>
    public string Password { get; set; } = string.Empty;

    /// <summary>"From" address on outbound mail.</summary>
    [EmailAddress]
    public string FromAddress { get; set; } = string.Empty;

    /// <summary>Display name on the From header (optional).</summary>
    public string FromDisplayName { get; set; } = "NoteControl";
}
