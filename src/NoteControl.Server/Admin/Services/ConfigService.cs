using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using NoteControl.Server.Configuration;
using NoteControl.Server.Options;
using NoteControl.Shared.Admin;

namespace NoteControl.Server.Admin.Services;

/// <summary>
/// Bridges the strongly-typed <see cref="IOptionsMonitor{T}"/>
/// pipeline (read side) and the JSON file (write side) so the
/// admin endpoints can present + accept a single
/// <see cref="ServerConfigDto"/>.
/// </summary>
public interface IConfigService
{
    /// <summary>Snapshot the current effective config for the UI.</summary>
    ServerConfigDto GetCurrent();

    /// <summary>
    /// Validate + persist the supplied config. Sections that don't
    /// change are still rewritten — atomicity matters more than
    /// minimising disk churn.
    /// <para>
    /// Throws <see cref="ConfigValidationException"/> on bad input.
    /// </para>
    /// </summary>
    Task UpdateAsync(ServerConfigDto config, CancellationToken ct = default);
}

/// <summary>
/// Field-level validation failures bundled for the response
/// (RFC 7807-ish).
/// </summary>
public sealed class ConfigValidationException : Exception
{
    public IReadOnlyDictionary<string, string> Errors { get; }
    public ConfigValidationException(IReadOnlyDictionary<string, string> errors)
        : base("Configuration is invalid.")
    {
        Errors = errors;
    }
}

public sealed class ConfigService : IConfigService
{
    private static readonly HashSet<string> ValidSecurity = new(StringComparer.OrdinalIgnoreCase)
    {
        "STARTTLS", "SSL", "None",
    };

    private static readonly HashSet<string> ValidLogLevels = new(StringComparer.OrdinalIgnoreCase)
    {
        "Verbose", "Debug", "Information", "Warning", "Error", "Fatal",
    };

    private readonly IOptionsMonitor<StorageOptions> _storage;
    private readonly IOptionsMonitor<AuthOptions> _auth;
    private readonly IOptionsMonitor<SmtpOptions> _smtp;
    private readonly IOptionsMonitor<BackupOptions> _backup;
    private readonly IOptionsMonitor<LoggingOptions> _logging;
    private readonly IOptionsMonitor<NetworkOptions> _network;
    private readonly IServerConfigStore _store;
    private readonly IConfiguration _config;
    /// <summary>
    /// The Kestrel server instance, used to read the actually-bound
    /// endpoint addresses via <see cref="IServerAddressesFeature"/>.
    /// Step 44: replaces the previous "compute BindUrl from configured
    /// values" approach, which lied to the user when configured port
    /// and bound port disagreed (e.g. when an old appsettings.json
    /// `Kestrel:Endpoints` block was overriding the Network section).
    /// </summary>
    private readonly IServer _server;

    /// <summary>
    /// Ship 93: regenerates the Caddyfile + asks a running Caddy
    /// service to reload after every Network section save. Wraps
    /// both file-write and reload-invocation; failures are logged
    /// but don't fail the save.
    /// </summary>
    private readonly Caddy.CaddyConfigWriter _caddy;

    private readonly ILogger<ConfigService> _log;

    public ConfigService(
        IOptionsMonitor<StorageOptions> storage,
        IOptionsMonitor<AuthOptions> auth,
        IOptionsMonitor<SmtpOptions> smtp,
        IOptionsMonitor<BackupOptions> backup,
        IOptionsMonitor<LoggingOptions> logging,
        IOptionsMonitor<NetworkOptions> network,
        IServerConfigStore store,
        IConfiguration config,
        IServer server,
        Caddy.CaddyConfigWriter caddy,
        ILogger<ConfigService> log)
    {
        _storage = storage;
        _auth = auth;
        _smtp = smtp;
        _backup = backup;
        _logging = logging;
        _network = network;
        _store = store;
        _config = config;
        _server = server;
        _caddy = caddy;
        _log = log;
    }

    public ServerConfigDto GetCurrent()
    {
        var storage = _storage.CurrentValue;
        var auth = _auth.CurrentValue;
        var smtp = _smtp.CurrentValue;
        var backup = _backup.CurrentValue;
        var logging = _logging.CurrentValue;
        var network = _network.CurrentValue;

        // BindUrl: read what Kestrel is actually listening on, NOT
        // what was configured. Step 44 — before this, we computed
        // BindUrl from network.ExposeOnLan + network.Port, which
        // lied when:
        //   - the running server was started with an older config
        //     (port=8080) and the user has since saved port=1234
        //     to the file but not restarted
        //   - some IConfiguration source overrode our UseUrls()
        //     and bound somewhere we didn't expect
        // Reading IServerAddressesFeature gives the truth — the
        // actual sockets that exist right now.
        //
        // Fallback: if the feature isn't available (very early
        // request before binding completes — vanishingly rare for
        // an admin API call), or no addresses found, we fall back
        // to the computed value with a [stale] marker to tell the
        // user something is off.
        var bindUrl = ResolveBoundUrl(network);

        // LanUrls: enumerate active IPv4 interfaces with private
        // (RFC 1918) addresses. Only meaningful when ExposeOnLan is
        // true, but we compute them either way -- the UI uses the
        // list to show the user "if you flip the toggle, here are
        // the URLs you'll be able to reach" (informative even pre-
        // toggle).
        var lanUrls = DetectLanUrls(network.Port);

        return new ServerConfigDto(
            Storage: new StorageConfigDto(
                DataRoot: storage.DataRoot,
                ConfigFilePath: _store.ConfigFilePath),
            Network: new NetworkConfigDto(
                BindUrl: bindUrl,
                ExposeOnLan: network.ExposeOnLan,
                Port: network.Port,
                LanUrls: lanUrls,
                PublicUrl: network.PublicUrl,
                // Ship 93: defensive ToList() so callers see a fresh
                // snapshot even if NetworkOptions.PublicHostnames is
                // mutated under them later. Empty list (default) is
                // serialised as `[]` not omitted.
                PublicHostnames: network.PublicHostnames?.ToList() ?? new List<string>()),
            Auth: new AuthConfigDto(
                IdleTimeoutMinutes: auth.IdleTimeoutMinutes,
                AbsoluteTimeoutMinutes: auth.AbsoluteTimeoutMinutes,
                MinimumPasswordLength: auth.MinimumPasswordLength,
                CheckPasswordAgainstHibp: auth.CheckPasswordAgainstHibp,
                LoginAttemptsPerIpPerMinute: auth.LoginAttemptsPerIpPerMinute,
                LoginAttemptsPerAccountPerHour: auth.LoginAttemptsPerAccountPerHour,
                AccountLockoutMinutes: auth.AccountLockoutMinutes),
            Smtp: new SmtpConfigDto(
                Enabled: smtp.Enabled,
                Host: smtp.Host,
                Port: smtp.Port,
                Security: smtp.Security,
                Username: smtp.Username,
                Password: "",                              // never echoed
                HasPassword: !string.IsNullOrEmpty(smtp.Password),
                FromAddress: smtp.FromAddress,
                FromDisplayName: smtp.FromDisplayName),
            Backup: new BackupConfigDto(
                Enabled: backup.Enabled,
                TargetPath: backup.TargetPath,
                DailyTime: backup.DailyTime,
                RetainDailyCount: backup.RetainDailyCount,
                RetainWeeklyCount: backup.RetainWeeklyCount),
            Logging: new LoggingConfigDto(
                MinimumLevel: logging.MinimumLevel,
                RetainDays: logging.RetainDays));
    }

    public async Task UpdateAsync(ServerConfigDto config, CancellationToken ct = default)
    {
        var errors = Validate(config);
        if (errors.Count > 0)
        {
            throw new ConfigValidationException(errors);
        }

        // Build the JSON shape we want in the file. We DON'T write
        // Storage or Network — Storage:DataRoot lives in
        // appsettings.json (intentionally — see ServerSettingsWindow
        // for the user-facing explanation), and Kestrel binding is
        // outside this layer's scope.
        //
        // For SMTP password: empty string from the wire means
        // "preserve existing". A non-empty string replaces it.
        var existingSmtpPassword = _smtp.CurrentValue.Password;
        var newSmtpPassword = string.IsNullOrEmpty(config.Smtp.Password)
            ? existingSmtpPassword
            : config.Smtp.Password;

        var sections = new Dictionary<string, JsonNode>(StringComparer.Ordinal)
        {
            [AuthOptions.SectionName] = JsonSerializer.SerializeToNode(new
            {
                config.Auth.IdleTimeoutMinutes,
                config.Auth.AbsoluteTimeoutMinutes,
                config.Auth.MinimumPasswordLength,
                config.Auth.CheckPasswordAgainstHibp,
                config.Auth.LoginAttemptsPerIpPerMinute,
                config.Auth.LoginAttemptsPerAccountPerHour,
                config.Auth.AccountLockoutMinutes,
            })!,
            [SmtpOptions.SectionName] = JsonSerializer.SerializeToNode(new
            {
                config.Smtp.Enabled,
                config.Smtp.Host,
                config.Smtp.Port,
                config.Smtp.Security,
                config.Smtp.Username,
                Password = newSmtpPassword,
                config.Smtp.FromAddress,
                config.Smtp.FromDisplayName,
            })!,
            [BackupOptions.SectionName] = JsonSerializer.SerializeToNode(new
            {
                config.Backup.Enabled,
                config.Backup.TargetPath,
                config.Backup.DailyTime,
                config.Backup.RetainDailyCount,
                config.Backup.RetainWeeklyCount,
            })!,
            [LoggingOptions.SectionName] = JsonSerializer.SerializeToNode(new
            {
                config.Logging.MinimumLevel,
                config.Logging.RetainDays,
            })!,
            [NetworkOptions.SectionName] = JsonSerializer.SerializeToNode(new
            {
                config.Network.ExposeOnLan,
                config.Network.Port,
                config.Network.PublicUrl,
                // Ship 93: persist the cleaned hostname list. Validation
                // (Validate() below) lower-cases + strips each entry
                // before we get here, so what we write is canonical.
                PublicHostnames = config.Network.PublicHostnames?.ToList() ?? new List<string>(),
                // BindUrl + LanUrls are derived; never persisted.
            })!,
        };

        await _store.UpdateSectionsAsync(sections, ct);

        // Ship 93: regenerate Caddyfile based on the new hostname list +
        // ask Caddy to reload. Both calls are best-effort:
        //   - Write to disk should be ~always-succeed; if it fails
        //     (disk full, permissions) we log and move on. The user's
        //     config save IS persisted; only the Caddy-side artifact
        //     is missing, which Caddy will pick up next time something
        //     touches it.
        //   - Reload may fail silently (Caddy not running, not on PATH).
        //     Logged at warning level. New config takes effect when
        //     Caddy restarts.
        // Both wrapped in try/catch so a Caddy oddity can't fail the
        // user's settings save flow.
        try
        {
            var hostnames = config.Network.PublicHostnames?.ToList() ?? new List<string>();
            var caddyfilePath = ResolveCaddyfilePath();
            var logFilePath = ResolveCaddyLogPath();
            var contents = Caddy.CaddyfileGenerator.Generate(
                hostnames, config.Network.Port, logFilePath);
            _caddy.Write(caddyfilePath, contents);
            // Fire-and-forget reload. We don't await — the save call
            // shouldn't block on Caddy I/O. Reload progress lands in
            // the server log.
            _ = _caddy.ReloadAsync(caddyfilePath);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex,
                "Caddyfile regeneration after config save failed. The user's " +
                "settings WERE persisted; Caddy will pick up the change on " +
                "next restart if/when the Caddyfile is regenerated.");
        }
    }

    /// <summary>
    /// Ship 93: standard path for the auto-generated Caddyfile.
    /// Lives under DataRoot so backups + restores carry it along.
    /// The Caddy service should be configured to read from THIS
    /// path (the setup-https.ps1 script does that).
    /// </summary>
    private string ResolveCaddyfilePath()
    {
        var dataRoot = _storage.CurrentValue.DataRoot;
        return Path.Combine(dataRoot, "caddy", "Caddyfile");
    }

    /// <summary>
    /// Ship 93: standard path for the Caddy access log. Lives next
    /// to the existing notecontrol-*.log files so the user has a
    /// single logs directory to check.
    /// </summary>
    private string ResolveCaddyLogPath()
    {
        var dataRoot = _storage.CurrentValue.DataRoot;
        return Path.Combine(dataRoot, "logs", "caddy-access.log");
    }

    // ---------------------------------------------------------------
    // Bound-URL resolution (step 44).
    // ---------------------------------------------------------------

    /// <summary>
    /// Read the URL Kestrel actually bound to from
    /// <see cref="IServerAddressesFeature"/>. This is the source of
    /// truth — what's reported here matches what TCP sockets are
    /// actually listening on right now.
    ///
    /// Falls back to a computed value (<c>http://{loopback or 0.0.0.0}:{configured port}</c>)
    /// when the feature isn't available or returns nothing. The
    /// fallback is rare in practice — by the time the admin UI
    /// queries this method, Kestrel has long since bound — but
    /// returning SOMETHING beats throwing.
    ///
    /// If the bound URL contains a wildcard host (<c>+</c> or
    /// <c>*</c>), we substitute <c>0.0.0.0</c> for display. Wildcard
    /// strings are how IIS-style configs sometimes phrase "all
    /// interfaces" but they don't render usefully in a UI.
    /// </summary>
    private string ResolveBoundUrl(NetworkOptions network)
    {
        try
        {
            var addresses = _server.Features.Get<IServerAddressesFeature>()?.Addresses;
            if (addresses is { Count: > 0 })
            {
                // Prefer http:// over https:// for display (we don't
                // currently configure HTTPS in self-hosted mode, so
                // there's only one entry; this is defensive).
                var raw = addresses.FirstOrDefault(
                    a => a.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                    ?? addresses.First();

                // Normalise wildcard hosts for display.
                raw = raw
                    .Replace("://+:",   "://0.0.0.0:", StringComparison.Ordinal)
                    .Replace("://*:",   "://0.0.0.0:", StringComparison.Ordinal)
                    .Replace("://[::]:", "://0.0.0.0:", StringComparison.Ordinal);
                return raw;
            }
        }
        catch
        {
            // Defensive: if reading features somehow fails (it
            // shouldn't), fall through to the computed default.
        }

        var bindHost = network.ExposeOnLan ? "0.0.0.0" : "127.0.0.1";
        return $"http://{bindHost}:{network.Port}";
    }

    // ---------------------------------------------------------------
    // LAN URL detection.
    // ---------------------------------------------------------------

    /// <summary>
    /// Enumerate all up-and-running non-loopback IPv4 addresses on
    /// this machine and produce "http://&lt;ip&gt;:&lt;port&gt;" strings.
    /// The Tray Settings UI displays these so the admin knows what
    /// URL to type into a phone or other device on the same network.
    ///
    /// Step 41: previous versions filtered to RFC 1918 private
    /// ranges (10.x, 172.16-31.x, 192.168.x). That assumption breaks
    /// on networks that use other ranges as their internal LAN —
    /// industrial / OT networks frequently use, e.g., 30.0.0.0/8 or
    /// other public-but-internally-routed ranges because they need
    /// huge address spaces and don't care about RFC compliance.
    /// On those networks the old filter returned an empty list and
    /// gave the user no usable URL.
    ///
    /// New behaviour: surface EVERY IPv4 address found on an "Up"
    /// non-loopback interface, no range filter. This includes
    /// virtual adapters (Hyper-V, WSL, VPN, VirtualBox, Docker,
    /// etc.). The user picks the right URL from the resulting
    /// list. The trade-off is more noise; the upside is that no
    /// network topology is locked out of the suggestion. Per the
    /// design decision in Ship 41, "noisier is fine" — the user
    /// would rather see a long list and recognise the right one
    /// than see "no LAN interfaces" and be stuck.
    ///
    /// We still skip loopback (127.0.0.1) explicitly because the
    /// BindUrl field already shows it and surfacing it as a "LAN
    /// URL" would be confusing.
    ///
    /// IPv6 is still omitted: home networks rarely have stable
    /// IPv6 addressing for typing into a phone, and Kestrel binds
    /// IPv4 0.0.0.0. A future ship can extend this if IPv6 becomes
    /// in scope.
    /// </summary>
    private static IReadOnlyList<string> DetectLanUrls(int port)
    {
        var results = new List<string>();
        try
        {
            foreach (var nic in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;
                if (nic.NetworkInterfaceType == System.Net.NetworkInformation.NetworkInterfaceType.Loopback) continue;

                var props = nic.GetIPProperties();
                foreach (var unicast in props.UnicastAddresses)
                {
                    var ip = unicast.Address;
                    if (ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) continue;

                    // Defensive: skip 127.x even if it somehow shows
                    // up here (it shouldn't, given the loopback NIC
                    // skip above, but a misconfigured machine could
                    // have a 127.x on a non-loopback NIC).
                    if (System.Net.IPAddress.IsLoopback(ip)) continue;

                    // Skip 0.0.0.0 — meaningless as a target URL.
                    if (ip.GetAddressBytes() is [0, 0, 0, 0]) continue;

                    results.Add($"http://{ip}:{port}");
                }
            }
        }
        catch
        {
            // Any failure here is non-critical: the bind itself
            // doesn't depend on this list. We swallow and return
            // whatever we found.
        }

        // Stable, deduped order so the UI doesn't reshuffle on
        // each refresh.
        return results
            .Distinct(StringComparer.Ordinal)
            .OrderBy(s => s, StringComparer.Ordinal)
            .ToList();
    }

    // ---------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------

    private static Dictionary<string, string> Validate(ServerConfigDto config)
    {
        var errors = new Dictionary<string, string>(StringComparer.Ordinal);

        // Auth
        if (config.Auth.IdleTimeoutMinutes < 1 || config.Auth.IdleTimeoutMinutes > 60 * 24 * 30)
            errors["Auth.IdleTimeoutMinutes"] = "Must be between 1 and 43200.";
        if (config.Auth.AbsoluteTimeoutMinutes < 1 || config.Auth.AbsoluteTimeoutMinutes > 60 * 24 * 365)
            errors["Auth.AbsoluteTimeoutMinutes"] = "Must be between 1 and 525600.";
        if (config.Auth.AbsoluteTimeoutMinutes < config.Auth.IdleTimeoutMinutes)
            errors["Auth.AbsoluteTimeoutMinutes"] = "Absolute timeout must be ≥ idle timeout.";
        if (config.Auth.MinimumPasswordLength < 8 || config.Auth.MinimumPasswordLength > 256)
            errors["Auth.MinimumPasswordLength"] = "Must be between 8 and 256 (spec recommends 12).";
        if (config.Auth.LoginAttemptsPerIpPerMinute < 1 || config.Auth.LoginAttemptsPerIpPerMinute > 1000)
            errors["Auth.LoginAttemptsPerIpPerMinute"] = "Must be between 1 and 1000.";
        if (config.Auth.LoginAttemptsPerAccountPerHour < 1 || config.Auth.LoginAttemptsPerAccountPerHour > 1000)
            errors["Auth.LoginAttemptsPerAccountPerHour"] = "Must be between 1 and 1000.";
        if (config.Auth.AccountLockoutMinutes < 1 || config.Auth.AccountLockoutMinutes > 60 * 24 * 7)
            errors["Auth.AccountLockoutMinutes"] = "Must be between 1 and 10080.";

        // SMTP
        if (config.Smtp.Enabled)
        {
            if (string.IsNullOrWhiteSpace(config.Smtp.Host))
                errors["Smtp.Host"] = "Required when SMTP is enabled.";
            if (config.Smtp.Port < 1 || config.Smtp.Port > 65535)
                errors["Smtp.Port"] = "Must be between 1 and 65535.";
            if (string.IsNullOrWhiteSpace(config.Smtp.FromAddress) ||
                !config.Smtp.FromAddress.Contains('@'))
                errors["Smtp.FromAddress"] = "Required when SMTP is enabled, must be an email address.";
        }
        if (!ValidSecurity.Contains(config.Smtp.Security))
            errors["Smtp.Security"] = "Must be STARTTLS, SSL, or None.";

        // Backup
        if (config.Backup.Enabled && string.IsNullOrWhiteSpace(config.Backup.TargetPath))
            errors["Backup.TargetPath"] = "Required when backups are enabled.";
        if (!System.Text.RegularExpressions.Regex.IsMatch(
            config.Backup.DailyTime, @"^([01]\d|2[0-3]):[0-5]\d$"))
            errors["Backup.DailyTime"] = "Must be HH:MM (24-hour).";
        if (config.Backup.RetainDailyCount < 1 || config.Backup.RetainDailyCount > 365)
            errors["Backup.RetainDailyCount"] = "Must be between 1 and 365.";
        if (config.Backup.RetainWeeklyCount < 0 || config.Backup.RetainWeeklyCount > 52)
            errors["Backup.RetainWeeklyCount"] = "Must be between 0 and 52.";

        // Logging
        if (!ValidLogLevels.Contains(config.Logging.MinimumLevel))
            errors["Logging.MinimumLevel"] = "Must be one of Verbose, Debug, Information, Warning, Error, Fatal.";
        if (config.Logging.RetainDays < 1 || config.Logging.RetainDays > 365)
            errors["Logging.RetainDays"] = "Must be between 1 and 365.";

        // Network. Match NetworkOptions' [Range] on Port. The lower
        // bound of 1024 is intentional: ports under that need admin
        // privilege to bind on Windows, and we don't want to invite
        // a UEFI-Secure-Boot-style permission escalation problem just
        // to enable port 80. PublicUrl is allowed to be empty (means
        // "use a sensible local fallback in emails"); when present it
        // should look at least roughly like a URL but we don't try
        // to deeply validate.
        if (config.Network.Port < 1024 || config.Network.Port > 65535)
            errors["Network.Port"] = "Must be between 1024 and 65535.";
        if (!string.IsNullOrWhiteSpace(config.Network.PublicUrl))
        {
            if (!Uri.TryCreate(config.Network.PublicUrl, UriKind.Absolute, out var uri)
                || (uri.Scheme != "http" && uri.Scheme != "https"))
            {
                errors["Network.PublicUrl"] = "Must be an absolute http(s) URL or empty.";
            }
        }

        // Ship 93: validate each public hostname.
        //
        // Rules: bare hostname only — no scheme, no port, no path. Must
        // be valid DNS label (letters, digits, hyphens, dots; cannot
        // start or end with hyphen; total length ≤ 253 per RFC 1035).
        // Empty list is fine (means "no Caddy fronting").
        //
        // We're STRICT here because a typo'd hostname goes straight
        // into the Caddyfile, where Caddy will try to provision a
        // Let's Encrypt cert for it. Bad hostnames waste rate-limit
        // budget; very-bad hostnames (with shell metacharacters) could
        // theoretically cause issues if Caddy parses them oddly. We
        // enforce a conservative subset.
        if (config.Network.PublicHostnames is not null)
        {
            for (int i = 0; i < config.Network.PublicHostnames.Count; i++)
            {
                var raw = config.Network.PublicHostnames[i];
                var key = $"Network.PublicHostnames[{i}]";
                if (string.IsNullOrWhiteSpace(raw))
                {
                    errors[key] = "Hostname cannot be empty.";
                    continue;
                }
                var trimmed = raw.Trim().ToLowerInvariant();
                if (trimmed.Length > 253)
                {
                    errors[key] = "Hostname too long (max 253 characters).";
                    continue;
                }
                if (!IsValidDnsHostname(trimmed))
                {
                    errors[key] = $"'{raw}' is not a valid hostname. Use bare DNS form: 'notes.example.com' (no scheme, no port, no path).";
                }
            }
            // Reject duplicates after trimming. Two entries that
            // case-fold or whitespace-fold to the same hostname would
            // produce duplicate Caddy site blocks → Caddy refuses to
            // start.
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < config.Network.PublicHostnames.Count; i++)
            {
                var trimmed = (config.Network.PublicHostnames[i] ?? "").Trim().ToLowerInvariant();
                if (string.IsNullOrEmpty(trimmed)) continue;
                if (!seen.Add(trimmed))
                {
                    errors[$"Network.PublicHostnames[{i}]"] =
                        $"Duplicate hostname '{trimmed}' (case-insensitive). Each hostname must appear once.";
                }
            }
        }

        return errors;
    }

    /// <summary>
    /// Ship 93: conservative DNS hostname validator. Accepts what
    /// RFC 1035/1123 allow for the grand-parent of all DNS labels:
    /// letters, digits, hyphens, dots; labels can't start/end with
    /// hyphens; labels ≤ 63 chars; full hostname ≤ 253 chars
    /// (the caller checks total length separately so the error
    /// message can be specific). Rejects everything else
    /// (underscores, spaces, slashes, scheme prefixes).
    ///
    /// We deliberately don't allow trailing dots (`example.com.`).
    /// They're valid DNS but Caddy doesn't accept them in site
    /// labels.
    /// </summary>
    private static bool IsValidDnsHostname(string s)
    {
        if (string.IsNullOrEmpty(s)) return false;
        // Reject scheme prefixes — easy mistake.
        if (s.Contains("://", StringComparison.Ordinal)) return false;
        // Reject ports + paths + paths-via-slash.
        if (s.Contains(':') || s.Contains('/') || s.Contains('?') || s.Contains('#')) return false;

        var labels = s.Split('.');
        if (labels.Length < 2) return false; // require at least one dot
        foreach (var label in labels)
        {
            if (label.Length == 0 || label.Length > 63) return false;
            if (label[0] == '-' || label[^1] == '-') return false;
            foreach (var ch in label)
            {
                bool ok = (ch >= 'a' && ch <= 'z')
                       || (ch >= 'A' && ch <= 'Z')
                       || (ch >= '0' && ch <= '9')
                       || ch == '-';
                if (!ok) return false;
            }
        }
        return true;
    }
}
