using System.Net;
using System.Net.Sockets;

namespace NoteControl.Server.Startpage.Services;

/// <summary>
/// SSRF guard for the server-side fetchers (RSS feeds, link previews).
/// <para>
/// Those endpoints are open to every signed-in user — viewers
/// included — and fetch a URL the caller supplies. The old guard only
/// looked at the URL as typed (a literal private IP or "localhost"),
/// so a DNS name pointing at 127.0.0.1 / the LAN, or a public URL that
/// redirects to one, reached internal services: page titles and feed
/// contents came back to the caller, and response times probed ports.
/// </para>
/// <para>
/// Now the check runs where it can't be dodged: in the socket
/// <see cref="SocketsHttpHandler.ConnectCallback"/>, against the
/// addresses the host name actually resolved to, for EVERY connection
/// — including each redirect hop and any DNS answer that changed
/// since the first look. If any resolved address is non-public the
/// connection is refused.
/// </para>
/// <para>
/// No proxy: with a proxy the callback would see the proxy's address,
/// not the target's, and couldn't judge the request. An install that
/// can only reach the internet through a proxy can't use feeds / link
/// previews (they'd fail with "could not reach").
/// </para>
/// </summary>
public static class OutboundAddressGuard
{
    /// <summary>Redirect hops allowed per fetch (HttpClient's default is 50).</summary>
    public const int MaxRedirects = 5;

    /// <summary>Thrown (wrapped in HttpRequestException) when a connection is refused.</summary>
    public sealed class BlockedAddressException : Exception
    {
        public BlockedAddressException(string host)
            : base($"'{host}' resolves to a loopback, private or otherwise non-public address.") { }
    }

    /// <summary>Primary handler for the "feedfetcher" / "linkpreviewfetcher" clients.</summary>
    public static SocketsHttpHandler CreateHandler() => new()
    {
        UseProxy = false,
        AllowAutoRedirect = true,
        MaxAutomaticRedirections = MaxRedirects,
        PooledConnectionLifetime = TimeSpan.FromMinutes(2),
        ConnectCallback = ConnectAsync,
    };

    private static async ValueTask<Stream> ConnectAsync(
        SocketsHttpConnectionContext context, CancellationToken ct)
    {
        var host = context.DnsEndPoint.Host;
        var addresses = IPAddress.TryParse(host.Trim('[', ']'), out var literal)
            ? new[] { literal }
            : await Dns.GetHostAddressesAsync(host, ct).ConfigureAwait(false);

        if (addresses.Length == 0 || addresses.Any(IsBlocked))
        {
            // Refuse when ANY answer is non-public: with a mixed answer
            // the OS could pick the private one, and an attacker's DNS
            // controls the mix.
            throw new BlockedAddressException(host);
        }

        var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(addresses, context.DnsEndPoint.Port, ct).ConfigureAwait(false);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Quick pre-check on the URL as typed, for a clear error before any
    /// network traffic: literal non-public IPs and localhost names. The
    /// connect-time check above is the one that actually protects.
    /// </summary>
    public static bool IsObviouslyLocal(Uri uri)
    {
        var host = uri.DnsSafeHost;
        if (IPAddress.TryParse(host, out var ip)) return IsBlocked(ip);
        return host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>True when the server must not connect to <paramref name="ip"/>.</summary>
    public static bool IsBlocked(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();

        if (ip.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = ip.GetAddressBytes();
            return b[0] == 0                                   // 0.0.0.0/8 "this network"
                || b[0] == 10                                  // RFC 1918
                || b[0] == 127                                 // loopback
                || (b[0] == 100 && b[1] >= 64 && b[1] <= 127)  // 100.64/10 carrier-grade NAT
                || (b[0] == 169 && b[1] == 254)                // link-local (cloud metadata)
                || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)   // RFC 1918
                || (b[0] == 192 && b[1] == 0 && b[2] == 0)     // 192.0.0.0/24 IETF protocol
                || (b[0] == 192 && b[1] == 168)                // RFC 1918
                || (b[0] == 198 && (b[1] == 18 || b[1] == 19)) // 198.18/15 benchmarking
                || b[0] >= 224;                                // multicast + reserved + broadcast
        }

        if (ip.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (IPAddress.IsLoopback(ip) || ip.Equals(IPAddress.IPv6None) || ip.Equals(IPAddress.IPv6Any))
                return true;
            if (ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal || ip.IsIPv6Multicast)
                return true;
            var b = ip.GetAddressBytes();
            if ((b[0] & 0xFE) == 0xFC) return true;            // fc00::/7 unique local
            // 6to4 (2002::/16) and NAT64 (64:ff9b::/96) embed an IPv4
            // address — judge the embedded one.
            if (b[0] == 0x20 && b[1] == 0x02)
                return IsBlocked(new IPAddress(new[] { b[2], b[3], b[4], b[5] }));
            if (b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xFF && b[3] == 0x9B
                && b.Skip(4).Take(8).All(x => x == 0))
                return IsBlocked(new IPAddress(new[] { b[12], b[13], b[14], b[15] }));
            return false;
        }

        return true; // unknown family — refuse
    }

    /// <summary>True when a fetch failed because of this guard.</summary>
    public static bool IsBlockedFailure(Exception ex)
    {
        for (var e = ex; e is not null; e = e.InnerException)
        {
            if (e is BlockedAddressException) return true;
        }
        return false;
    }
}
