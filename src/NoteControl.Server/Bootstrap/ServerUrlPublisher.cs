using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using NoteControl.Server.Options;

namespace NoteControl.Server.Bootstrap;

/// <summary>
/// Writes the bound server URL(s) to <c>{DataRoot}/.server/server.url</c>
/// at <see cref="IHostApplicationLifetime.ApplicationStarted"/>.
/// The tray app reads this file at startup so it can talk to the
/// server on whatever port the user actually configured — without
/// the tray having to parse appsettings.json or do guesswork.
///
/// Written file shape (JSON):
/// <code>
/// {
///   "trayUrl":   "http://127.0.0.1:1234",
///   "publicUrl": "http://30.11.0.101:1234"
/// }
/// </code>
///
/// <list type="bullet">
///   <item>
///     <description>
///     <b>trayUrl</b>: always loopback + the actual bound port.
///     The tray uses this for everything: API calls, the
///     Open-in-Browser link, the Ship-38 health probe. Loopback
///     is the right choice because the tray runs on the same
///     machine, browsers handle 127.0.0.1 reliably (unlike
///     0.0.0.0), and it works whether the server is exposed on
///     LAN or not.
///     </description>
///   </item>
///   <item>
///     <description>
///     <b>publicUrl</b>: the server's externally-typeable URL.
///     If Kestrel bound to 0.0.0.0 we substitute the first
///     non-loopback IPv4 we can find on this machine. If it's
///     bound to a specific IP we keep that. Informational —
///     used by the Server Settings window's "Public URL" field
///     as a sensible default and by anything else that needs
///     to display "the address others type."
///     </description>
///   </item>
/// </list>
///
/// Why a JSON file rather than two separate files: lets us add
/// fields later (TLS URL, alt port, host name) without changing
/// the file naming convention. Tray just reads keys it knows.
///
/// We do NOT lock the file or use a temp+rename atomic write
/// here, because the tray reads it at startup and tolerates a
/// torn read by falling back to its hardcoded default. A torn
/// read on a 200-byte file is unlikely anyway.
/// </summary>
public sealed class ServerUrlPublisher : IHostedService
{
    private const string AppFolder = ".server";
    private const string FileName = "server.url";

    private readonly IServer _server;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly IOptions<StorageOptions> _storage;
    private readonly ILogger<ServerUrlPublisher> _log;

    public ServerUrlPublisher(
        IServer server,
        IHostApplicationLifetime lifetime,
        IOptions<StorageOptions> storage,
        ILogger<ServerUrlPublisher> log)
    {
        _server = server;
        _lifetime = lifetime;
        _storage = storage;
        _log = log;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Defer until Kestrel has finished binding. Reading
        // IServerAddressesFeature before that gives us either
        // null or the unbound URLs from configuration, which
        // doesn't help — we want the actually-bound ones (which
        // also covers port=0 "any free port" if anyone uses it).
        _lifetime.ApplicationStarted.Register(WriteUrlFile);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private void WriteUrlFile()
    {
        var dataRoot = _storage.Value.DataRoot;
        if (string.IsNullOrWhiteSpace(dataRoot))
        {
            _log.LogWarning(
                "Storage:DataRoot not configured; skipping server.url publication. " +
                "Tray app will fall back to its default URL.");
            return;
        }

        var addresses = _server.Features.Get<IServerAddressesFeature>()?.Addresses;
        if (addresses is null || addresses.Count == 0)
        {
            _log.LogWarning(
                "No server addresses available at ApplicationStarted; skipping " +
                "server.url publication.");
            return;
        }

        // Pick an HTTP address. We currently bind one URL (no
        // HTTPS in self-hosted mode), so this is usually a single
        // entry. If somehow multiple are present we prefer http://
        // (skipping https:// for now — the tray talks plain HTTP
        // to its server).
        string? raw = addresses.FirstOrDefault(
            a => a.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            ?? addresses.FirstOrDefault();

        if (string.IsNullOrWhiteSpace(raw))
        {
            _log.LogWarning("No HTTP address in bound list; skipping server.url publication.");
            return;
        }

        // Parse it. The bound URL is always a Uri-shaped thing;
        // Kestrel normalises to "http://0.0.0.0:1234" or
        // "http://127.0.0.1:1234". Failure here means something
        // changed in Kestrel internals — log + bail.
        Uri parsed;
        try
        {
            parsed = new Uri(raw);
        }
        catch (UriFormatException ex)
        {
            _log.LogWarning(ex,
                "Bound address {Raw} is not a valid URI; skipping server.url publication.",
                raw);
            return;
        }

        var port = parsed.Port;
        var trayUrl = $"http://127.0.0.1:{port}";
        var publicUrl = ComputePublicUrl(parsed);

        var dto = new ServerUrlFile(trayUrl, publicUrl);
        var folder = Path.Combine(dataRoot, AppFolder);
        var path = Path.Combine(folder, FileName);

        try
        {
            Directory.CreateDirectory(folder);
            // Pretty-printed JSON so an admin opening the file
            // in a text editor can read it. The tray uses
            // case-insensitive deserialisation so the casing
            // here doesn't matter for clients, but camelCase
            // matches everything else we write.
            var json = JsonSerializer.Serialize(dto, JsonOpts);
            File.WriteAllText(path, json);
            _log.LogInformation(
                "Published server URLs to {Path}: tray={Tray} public={Public}",
                path, trayUrl, publicUrl);
        }
        catch (Exception ex)
        {
            // Non-fatal. The tray falls back to a default URL if
            // it can't read this file; better to keep the server
            // running than to fail startup over a writability
            // glitch.
            _log.LogWarning(ex,
                "Could not write server URL file {Path}; tray app will use its default URL.",
                path);
        }
    }

    /// <summary>
    /// Compute the "public" URL — the one external devices would
    /// type. If the server bound to a specific IP, return that
    /// IP. If it bound to 0.0.0.0 (LAN-exposed), substitute the
    /// first non-loopback IPv4 address on the machine. If we
    /// can't find one, fall back to localhost.
    /// </summary>
    private string ComputePublicUrl(Uri bound)
    {
        var host = bound.Host;
        var port = bound.Port;

        if (host is "0.0.0.0" or "[::]")
        {
            var ip = FirstNonLoopbackIPv4();
            if (ip is not null) host = ip;
            else host = "127.0.0.1"; // graceful degrade
        }
        // If host was "*" (older Kestrel idiom), same treatment.
        else if (host == "*")
        {
            var ip = FirstNonLoopbackIPv4();
            host = ip ?? "127.0.0.1";
        }

        return $"http://{host}:{port}";
    }

    /// <summary>
    /// First non-loopback IPv4 on an "Up" interface. Mirrors the
    /// permissive logic in ConfigService.DetectLanUrls (Ship 41):
    /// no RFC1918 filter, just "any IPv4 that isn't loopback."
    /// We don't try to pick a "best" one — the tray's ServerSettings
    /// "Public URL" field is editable so the user can override.
    /// </summary>
    private static string? FirstNonLoopbackIPv4()
    {
        try
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up) continue;
                if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;

                var props = nic.GetIPProperties();
                foreach (var unicast in props.UnicastAddresses)
                {
                    var ip = unicast.Address;
                    if (ip.AddressFamily != AddressFamily.InterNetwork) continue;
                    if (IPAddress.IsLoopback(ip)) continue;
                    if (ip.GetAddressBytes() is [0, 0, 0, 0]) continue;
                    return ip.ToString();
                }
            }
        }
        catch
        {
            // Same posture as DetectLanUrls — non-critical, swallow.
        }
        return null;
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    /// <summary>On-disk shape. Public so the tray can deserialise the same record.</summary>
    private sealed record ServerUrlFile(string TrayUrl, string PublicUrl);
}
