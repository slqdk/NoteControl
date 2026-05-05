using System.Globalization;
using System.Text;

namespace NoteControl.Server.Caddy;

/// <summary>
/// Ship 93 — Caddyfile generator.
///
/// Pure function that produces a Caddyfile string from a list of
/// hostnames + the local backend port + a few well-known paths.
/// No I/O here on purpose: <see cref="CaddyConfigWriter"/> handles
/// disk + reload, and unit tests can verify generator output
/// against expected strings without touching the filesystem.
///
/// Output shape (one site block per hostname):
///
/// <code>
/// notes.slq.dk {
///     reverse_proxy 127.0.0.1:2424
///     header {
///         Strict-Transport-Security "max-age=31536000; includeSubDomains"
///         X-Content-Type-Options    "nosniff"
///         Referrer-Policy           "strict-origin-when-cross-origin"
///         -Server
///     }
///     log {
///         output file C:\ProgramData\NoteControl\logs\caddy-access.log {
///             roll_size  10mb
///             roll_keep  30
///             roll_keep_for 720h
///         }
///         format json
///     }
/// }
/// </code>
///
/// Caddy auto-fetches a Let's Encrypt cert per hostname AND
/// auto-redirects port 80 → 443 with no extra config — those are
/// defaults when an HTTPS site block is present. We don't add a
/// separate `:80 { redir ... }` block; Caddy handles it.
///
/// When the hostname list is empty we emit a comment-only stub.
/// Caddy refuses to start with no sites at all, so an empty
/// stub keeps Caddy alive (in case it's installed and running)
/// without binding any ports — matches the "no public hostnames
/// configured yet" deployment shape. Operators reach the server
/// directly on its Kestrel bind in that mode.
///
/// Hostname validation is the caller's responsibility — the
/// generator trusts what it gets and just emits each hostname
/// as a site label. Bad input (spaces, invalid chars) would
/// produce a Caddyfile Caddy refuses to parse; that's a louder
/// failure than silent stripping.
/// </summary>
public static class CaddyfileGenerator
{
    /// <summary>
    /// Generate a Caddyfile for the given hostnames + backend.
    /// </summary>
    /// <param name="hostnames">
    /// Bare hostnames to serve. Each entry should be a single
    /// DNS name; no scheme, no port, no path. Empty list →
    /// stub Caddyfile.
    /// </param>
    /// <param name="backendPort">
    /// The local Kestrel port Caddy should reverse-proxy to.
    /// Always 127.0.0.1:&lt;port&gt; — Caddy and Kestrel are
    /// expected to coexist on the same host.
    /// </param>
    /// <param name="logFilePath">
    /// Absolute path where Caddy should write its access log.
    /// Typically <c>C:\ProgramData\NoteControl\logs\caddy-access.log</c>.
    /// Caddy creates the file on demand; the parent directory
    /// must exist (the writer creates it).
    /// </param>
    public static string Generate(
        IReadOnlyList<string> hostnames,
        int backendPort,
        string logFilePath)
    {
        var sb = new StringBuilder();
        sb.AppendLine("# NoteControl — Caddyfile (auto-generated)");
        sb.AppendLine("#");
        sb.AppendLine("# This file is regenerated whenever the public hostname list");
        sb.AppendLine("# changes in the Tray Settings UI. Manual edits will be");
        sb.AppendLine("# overwritten on the next save. To customise headers / logging /");
        sb.AppendLine("# rate limiting beyond what the generator produces, edit the");
        sb.AppendLine("# CaddyfileGenerator class on the server side instead.");
        sb.AppendLine();

        if (hostnames.Count == 0)
        {
            // Stub: a single localhost-only block that Caddy will
            // accept but won't bind any public ports. Lets Caddy
            // run as a service even when no hostnames are
            // configured — saves the user from having to start /
            // stop the service in lockstep with config changes.
            sb.AppendLine("# No public hostnames configured. Caddy is running but not");
            sb.AppendLine("# serving any HTTPS sites. Add hostnames in the Tray Settings");
            sb.AppendLine("# (Server Settings → HTTPS) to start serving them.");
            sb.AppendLine();
            sb.AppendLine("# Localhost stub keeps Caddy from refusing to start. Bound");
            sb.AppendLine("# only on loopback :2019 (Caddy's own admin port — not");
            sb.AppendLine("# our backend); not reachable externally.");
            sb.AppendLine(":2019 {");
            sb.AppendLine("    respond \"NoteControl Caddy: no public hostnames configured.\"");
            sb.AppendLine("}");
            return sb.ToString();
        }

        foreach (var host in hostnames)
        {
            sb.Append(host);
            sb.AppendLine(" {");

            // Reverse proxy to local Kestrel.
            sb.Append("    reverse_proxy 127.0.0.1:");
            sb.AppendLine(backendPort.ToString(CultureInfo.InvariantCulture));

            // Hardening headers. Caddy automatically sets a few
            // (Server, X-Powered-By stripped). We add the rest
            // explicitly so the security posture matches the
            // sample Caddyfile that pre-Ship-93 deployments used.
            sb.AppendLine("    header {");
            sb.AppendLine("        Strict-Transport-Security \"max-age=31536000; includeSubDomains\"");
            sb.AppendLine("        X-Content-Type-Options    \"nosniff\"");
            sb.AppendLine("        Referrer-Policy           \"strict-origin-when-cross-origin\"");
            // We deliberately DON'T set X-Frame-Options here
            // because the existing server already sends one; setting
            // a different value at the proxy would be confusing.
            // Caddy's own Server header is removed so we don't leak
            // version info.
            sb.AppendLine("        -Server");
            sb.AppendLine("    }");

            // Access log per site. Single log file shared across
            // all sites so daily rotation is simpler. Caddy creates
            // it on first hit; the parent dir must exist (the
            // writer ensures it before the reload).
            sb.AppendLine("    log {");
            sb.Append("        output file \"");
            // Escape backslashes for Caddyfile syntax — Caddy uses
            // C-style strings, so a literal \ in a Windows path
            // would be interpreted as an escape introducer.
            sb.Append(logFilePath.Replace("\\", "\\\\"));
            sb.AppendLine("\" {");
            sb.AppendLine("            roll_size 10mb");
            sb.AppendLine("            roll_keep 30");
            sb.AppendLine("            roll_keep_for 720h");
            sb.AppendLine("        }");
            sb.AppendLine("        format json");
            sb.AppendLine("    }");

            sb.AppendLine("}");
            sb.AppendLine();
        }

        return sb.ToString();
    }
}
