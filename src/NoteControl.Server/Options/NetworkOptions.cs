using System.ComponentModel.DataAnnotations;

namespace NoteControl.Server.Options;

/// <summary>
/// Bind options for the Network section of config.json. These
/// settings decide where Kestrel listens on startup.
///
/// IMPORTANT: NOT hot-reload-capable. Kestrel binds bind addresses
/// at host startup; changing this options object after the app is
/// running has no effect. To apply a change here, the server
/// process must be restarted. The Settings UI calls this out.
///
/// PublicUrl is a separate concern: it's used by email-link
/// composition (password reset, login notifications) so the URLs
/// in those emails point at an externally-reachable address. It
/// has no effect on Kestrel's bind. Lives here because it's
/// conceptually a "network identity" setting.
/// </summary>
public sealed class NetworkOptions
{
    public const string SectionName = "Network";

    /// <summary>
    /// When false (default): bind to 127.0.0.1 only. Loopback
    /// access only -- no LAN reach. This is the secure-by-default
    /// posture; existing installs upgrade silently.
    /// When true: bind to 0.0.0.0 so other devices on the LAN
    /// can reach the server. The Tray Settings window surfaces
    /// the LAN URLs (one per network interface) so the admin
    /// knows what to point their phone at.
    /// </summary>
    public bool ExposeOnLan { get; set; }

    /// <summary>
    /// TCP port. Defaults to 8080 to match the historical bind.
    /// 80 and 443 are reserved for "real" deployments behind a
    /// reverse proxy and would normally require admin privileges
    /// to bind on Windows; we don't go there yet. The settings
    /// validator clamps this to a safe range.
    /// </summary>
    [Range(1024, 65535)]
    public int Port { get; set; } = 8080;

    /// <summary>
    /// Optional URL inserted into outbound email links (password
    /// resets, login notifications). When empty, the email
    /// composer uses a local-style fallback. Bind-address-
    /// independent; you can publish this as the LAN URL even
    /// though the server itself only sees 127.0.0.1 in
    /// loopback-only mode.
    /// </summary>
    public string PublicUrl { get; set; } = string.Empty;

    /// <summary>
    /// Ship 93: list of public hostnames to serve via Caddy
    /// (HTTPS). Each hostname becomes a `<host> { reverse_proxy
    /// 127.0.0.1:&lt;Port&gt; }` block in the auto-generated
    /// Caddyfile at <c>{DataRoot}/caddy/Caddyfile</c>. Caddy
    /// auto-fetches a Let's Encrypt cert for each hostname on
    /// first use; provisioning requires:
    ///   - The hostname's DNS A/AAAA record points to this server
    ///   - The server's port 80 is reachable from the public
    ///     internet (HTTP-01 challenge)
    /// Adding a hostname whose DNS isn't set up yet is harmless
    /// — Caddy retries with backoff and the rest of the served
    /// hostnames are unaffected. The user is warned in the
    /// Settings UI before saving.
    ///
    /// Empty list (default) means "no Caddy fronting required";
    /// the auto-generated Caddyfile is a no-op stub and the
    /// server should be reached directly on its bind URL. Use
    /// this for local-only / LAN-only / no-HTTPS deployments.
    ///
    /// Each entry is a bare hostname (no scheme, no port, no
    /// path): "notes.slq.dk", not "https://notes.slq.dk:443".
    /// ConfigService validates the format on save.
    /// </summary>
    public List<string> PublicHostnames { get; set; } = new();
}
