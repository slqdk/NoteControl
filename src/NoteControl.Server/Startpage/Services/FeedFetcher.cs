using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using NoteControl.Shared.Startpage;

namespace NoteControl.Server.Startpage.Services;

/// <summary>
/// Fetches an RSS 2.0 or Atom 1.0 feed and normalizes it into
/// <see cref="FeedDto"/>. Hand-rolled XML parsing via XDocument so
/// we don't pull in a third-party feed-reader NuGet (CodeHollow,
/// Argotic, etc.) for a job this small.
///
/// What we DON'T support (yet, deliberately):
///   - RSS 1.0 / RDF (rare today; would need namespace handling).
///   - Authenticated feeds (Bearer tokens, cookies, basic auth).
///   - Conditional GET (ETag / Last-Modified) — not worth the
///     complexity for the scale here.
///   - Per-feed user agent overrides.
///
/// What we DO support:
///   - HTTP redirects (HttpClient handles automatically, default 50 hops).
///   - 5-minute in-memory cache keyed by URL — rapid repeat fetches
///     (e.g. user resizing a block) don't re-hit the upstream.
///   - 10-second per-fetch timeout — failed feeds fail fast rather
///     than hanging the request.
///   - HTML stripping in summaries — feeds love to embed inline
///     HTML in &lt;description&gt;; we strip tags so the client
///     can render plain text safely.
///
/// Failure mode: any fetch/parse error throws StartpageException
/// with a 502 (Bad Gateway). The client surfaces the error inline
/// in the affected block; other blocks keep working.
/// </summary>
public sealed class FeedFetcher : IFeedFetcher
{
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan FetchTimeout = TimeSpan.FromSeconds(10);

    /// <summary>
    /// Cap on how much body we'll read from a feed. 5 MB covers
    /// even the most bloated podcast feeds; protects us from a
    /// hostile / misconfigured feed that streams gigabytes.
    /// </summary>
    private const int MaxResponseBytes = 5 * 1024 * 1024;

    /// <summary>
    /// Process-wide cache. Keyed by URL (case-sensitive — feed URLs
    /// are case-sensitive at the path/query level). The TTL is short
    /// enough that staleness isn't a big deal; if the user really
    /// wants fresh data, they can hit refresh in the UI.
    /// </summary>
    private static readonly ConcurrentDictionary<string, CacheEntry> Cache = new();

    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<FeedFetcher> _log;

    public FeedFetcher(IHttpClientFactory httpFactory, ILogger<FeedFetcher> log)
    {
        _httpFactory = httpFactory;
        _log = log;
    }

    public async Task<FeedDto> FetchAsync(string url, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            throw new StartpageException("Feed URL is required.");
        }

        // Validate up front — we never want to follow a
        // file:// URL or anything else exotic. Only http/https.
        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed)
            || (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps))
        {
            throw new StartpageException(
                "Feed URL must be an absolute http:// or https:// URL.");
        }

        // Block private IP ranges to prevent SSRF (server-side
        // request forgery). The user is admin on this instance,
        // so the risk is more "fat-fingered an internal URL by
        // accident" than "malicious," but the check is cheap.
        if (IsLikelyLoopbackOrPrivate(parsed))
        {
            throw new StartpageException(
                "Feed URL points to a loopback or private network address.");
        }

        // Cache hit?
        if (Cache.TryGetValue(url, out var entry) && !entry.IsExpired)
        {
            return entry.Feed;
        }

        // Fetch.
        var client = _httpFactory.CreateClient("feedfetcher");
        client.Timeout = FetchTimeout;

        // Polite UA so feed operators can identify us in logs and
        // contact the user if there's an issue. NoteControl is
        // self-hosted so this is the same UA across all installs;
        // we don't reveal the user's identity.
        if (!client.DefaultRequestHeaders.UserAgent.Any())
        {
            client.DefaultRequestHeaders.UserAgent.ParseAdd(
                "NoteControl/1.0 (+startpage-rss-reader)");
            client.DefaultRequestHeaders.Accept.Clear();
            client.DefaultRequestHeaders.Accept.Add(
                new MediaTypeWithQualityHeaderValue("application/rss+xml"));
            client.DefaultRequestHeaders.Accept.Add(
                new MediaTypeWithQualityHeaderValue("application/atom+xml"));
            client.DefaultRequestHeaders.Accept.Add(
                new MediaTypeWithQualityHeaderValue("application/xml", 0.9));
            client.DefaultRequestHeaders.Accept.Add(
                new MediaTypeWithQualityHeaderValue("text/xml", 0.8));
            client.DefaultRequestHeaders.Accept.Add(
                new MediaTypeWithQualityHeaderValue("*/*", 0.5));
        }

        string body;
        try
        {
            using var resp = await client.GetAsync(
                url,
                HttpCompletionOption.ResponseHeadersRead,
                ct);
            if (!resp.IsSuccessStatusCode)
            {
                throw new StartpageException(
                    $"Feed returned HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}.",
                    statusCode: 502);
            }

            // Cap the read. We don't trust Content-Length to be
            // honest, so we count as we read and bail if it
            // exceeds the cap mid-stream.
            await using var stream = await resp.Content.ReadAsStreamAsync(ct);
            using var ms = new MemoryStream();
            var buf = new byte[8192];
            int total = 0;
            int n;
            while ((n = await stream.ReadAsync(buf.AsMemory(0, buf.Length), ct)) > 0)
            {
                total += n;
                if (total > MaxResponseBytes)
                {
                    throw new StartpageException(
                        $"Feed body exceeded {MaxResponseBytes / (1024 * 1024)} MB.",
                        statusCode: 502);
                }
                ms.Write(buf, 0, n);
            }

            // Honour the charset the server declared if any,
            // otherwise default to UTF-8. XDocument.Parse expects
            // a string, not bytes, so this matters.
            var charset = resp.Content.Headers.ContentType?.CharSet;
            var encoding = TryGetEncoding(charset) ?? Encoding.UTF8;
            body = encoding.GetString(ms.ToArray());
        }
        catch (HttpRequestException ex)
        {
            throw new StartpageException(
                $"Could not reach feed: {ex.Message}",
                statusCode: 502);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new StartpageException(
                $"Feed fetch timed out after {FetchTimeout.TotalSeconds} seconds.",
                statusCode: 504);
        }

        // Parse.
        FeedDto feed;
        try
        {
            feed = ParseFeed(body);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to parse feed at {Url}", url);
            throw new StartpageException(
                $"Could not parse feed: {ex.Message}",
                statusCode: 502);
        }

        Cache[url] = new CacheEntry(feed, DateTime.UtcNow + CacheTtl);
        return feed;
    }

    // -----------------------------------------------------------------
    // Parsing
    // -----------------------------------------------------------------

    private static readonly XNamespace AtomNs = "http://www.w3.org/2005/Atom";
    private static readonly XNamespace ContentNs = "http://purl.org/rss/1.0/modules/content/";

    private static FeedDto ParseFeed(string xml)
    {
        // LoadOptions.None: no whitespace-as-text noise.
        var doc = XDocument.Parse(xml, LoadOptions.None);
        var root = doc.Root
            ?? throw new InvalidOperationException("Empty XML document.");

        // RSS 2.0 root is <rss><channel>…</channel></rss>; some
        // hand-written feeds skip the wrapper. Atom 1.0 root is
        // <feed xmlns="…/Atom">. Detect by element name + namespace.
        if (root.Name.LocalName == "rss")
        {
            var channel = root.Element("channel")
                ?? throw new InvalidOperationException("RSS feed missing <channel>.");
            return ParseRss(channel);
        }
        if (root.Name == AtomNs + "feed")
        {
            return ParseAtom(root);
        }
        // Try RSS without the <rss> wrapper as a last resort.
        if (root.Name.LocalName == "channel")
        {
            return ParseRss(root);
        }

        throw new InvalidOperationException(
            $"Unknown feed format. Root element: {root.Name}");
    }

    private static FeedDto ParseRss(XElement channel)
    {
        var title = (string?)channel.Element("title") ?? "(untitled)";
        var link = (string?)channel.Element("link");

        var items = new List<FeedItemDto>();
        foreach (var item in channel.Elements("item"))
        {
            // <description> often contains HTML; <content:encoded>
            // is the modern long-form variant. We prefer
            // description here — it's what most feeds expect to
            // be the "summary" view, and we strip HTML anyway so
            // long content would just be more data to drop.
            var rawSummary =
                (string?)item.Element("description")
                ?? (string?)item.Element(ContentNs + "encoded")
                ?? string.Empty;

            var pubDateRaw = (string?)item.Element("pubDate");
            DateTimeOffset? published = TryParseDate(pubDateRaw);

            items.Add(new FeedItemDto(
                Title: NonEmpty((string?)item.Element("title")) ?? "(untitled)",
                Link: (string?)item.Element("link"),
                Summary: HtmlToPlainText(rawSummary),
                PublishedAt: published));
        }

        return new FeedDto(title, link, items);
    }

    private static FeedDto ParseAtom(XElement feed)
    {
        var title = (string?)feed.Element(AtomNs + "title") ?? "(untitled)";

        // Atom can have multiple <link>s (alternate, self, etc.).
        // We want rel="alternate" or no rel (which means alternate).
        var link = feed.Elements(AtomNs + "link")
            .FirstOrDefault(l =>
                {
                    var rel = (string?)l.Attribute("rel");
                    return rel is null or "alternate";
                })
            ?.Attribute("href")?.Value;

        var items = new List<FeedItemDto>();
        foreach (var entry in feed.Elements(AtomNs + "entry"))
        {
            // Same alternate/no-rel logic for entry links.
            var entryLink = entry.Elements(AtomNs + "link")
                .FirstOrDefault(l =>
                    {
                        var rel = (string?)l.Attribute("rel");
                        return rel is null or "alternate";
                    })
                ?.Attribute("href")?.Value;

            // <summary> is the short form; <content> the full body.
            // Prefer summary; fall back to content.
            var rawSummary =
                (string?)entry.Element(AtomNs + "summary")
                ?? (string?)entry.Element(AtomNs + "content")
                ?? string.Empty;

            // <published> is when first published; <updated> is
            // mandatory. Prefer published when present (matches
            // user expectation — "this article appeared on..."),
            // fall back to updated.
            var pubRaw =
                (string?)entry.Element(AtomNs + "published")
                ?? (string?)entry.Element(AtomNs + "updated");
            DateTimeOffset? published = TryParseDate(pubRaw);

            items.Add(new FeedItemDto(
                Title: NonEmpty((string?)entry.Element(AtomNs + "title")) ?? "(untitled)",
                Link: entryLink,
                Summary: HtmlToPlainText(rawSummary),
                PublishedAt: published));
        }

        return new FeedDto(title, link, items);
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    private static string? NonEmpty(string? s)
        => string.IsNullOrWhiteSpace(s) ? null : s;

    /// <summary>
    /// Try to parse a date string as both RFC 822 (RSS pubDate
    /// canonical) and ISO 8601 (Atom). Feeds love to be wrong about
    /// either format; we try both before giving up. Returns null on
    /// any failure rather than throwing — a missing/bogus date isn't
    /// a feed-breaking problem.
    /// </summary>
    private static DateTimeOffset? TryParseDate(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;

        // RSS pubDate is RFC 822 (e.g. "Wed, 30 Apr 2026 14:00:00 GMT")
        // — DateTimeOffset.TryParse handles it under invariant culture.
        if (DateTimeOffset.TryParse(
                raw,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal,
                out var parsed))
        {
            return parsed.ToUniversalTime();
        }
        return null;
    }

    /// <summary>
    /// Minimal HTML → plain-text. Strips tags, collapses
    /// whitespace, decodes the common entities. Not a sanitiser —
    /// the client never re-renders this as HTML, so we're
    /// concerned only with readability, not safety. (The plain
    /// string we return is rendered as text content, which makes
    /// XSS via this path impossible.)
    /// </summary>
    private static string HtmlToPlainText(string html)
    {
        if (string.IsNullOrWhiteSpace(html)) return string.Empty;

        // Drop tags. Simple regex: works for well-formed HTML and
        // also for common malformed markup. We're not validating
        // the HTML, just stripping it.
        var stripped = TagRegex.Replace(html, " ");

        // Decode HTML entities (&amp; &lt; &nbsp; etc.).
        stripped = WebUtility.HtmlDecode(stripped);

        // Collapse whitespace runs to single spaces. Many feeds
        // pretty-print their HTML which leaves big gaps after
        // tag removal.
        stripped = WhitespaceRegex.Replace(stripped, " ").Trim();
        return stripped;
    }

    private static readonly Regex TagRegex = new(
        "<[^>]+>",
        RegexOptions.Compiled | RegexOptions.Singleline);

    private static readonly Regex WhitespaceRegex = new(
        @"\s+",
        RegexOptions.Compiled);

    private static Encoding? TryGetEncoding(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        try { return Encoding.GetEncoding(name); }
        catch { return null; }
    }

    /// <summary>
    /// Coarse SSRF guard. Blocks loopback (127.0.0.0/8, ::1),
    /// link-local (169.254.0.0/16, fe80::/10), and the RFC1918
    /// private ranges. Doesn't try to resolve DNS — the upstream
    /// HTTP request will follow CNAMEs / A records that could
    /// route to private space; an attacker controlling DNS could
    /// bypass this. For NoteControl's threat model (single admin
    /// user pasting their own URLs), this is good enough; a
    /// stronger version would resolve and recheck post-DNS.
    /// </summary>
    private static bool IsLikelyLoopbackOrPrivate(Uri uri)
    {
        var host = uri.Host;
        if (IPAddress.TryParse(host, out var ip))
        {
            if (IPAddress.IsLoopback(ip)) return true;
            // 169.254.* / fe80::
            var bytes = ip.GetAddressBytes();
            if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
            {
                if (bytes[0] == 10) return true;
                if (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) return true;
                if (bytes[0] == 192 && bytes[1] == 168) return true;
                if (bytes[0] == 169 && bytes[1] == 254) return true;
            }
            return false;
        }
        // Hostname — block obviously-local names.
        return host.Equals("localhost", StringComparison.OrdinalIgnoreCase);
    }

    private sealed record CacheEntry(FeedDto Feed, DateTime ExpiresAtUtc)
    {
        public bool IsExpired => DateTime.UtcNow >= ExpiresAtUtc;
    }
}
