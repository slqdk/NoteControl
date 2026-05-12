using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using NoteControl.Shared.Startpage;

namespace NoteControl.Server.Startpage.Services;

/// <summary>
/// Fetches an arbitrary HTTP(S) page and extracts metadata —
/// Open Graph tags first, falling back to Twitter Card tags, and
/// finally to plain &lt;title&gt; / &lt;meta name="description"&gt;
/// / favicon. Returns a <see cref="LinkPreviewDto"/> the client
/// uses to auto-fill a new Links-block entry.
///
/// What this is NOT:
///   - A general scraper / readability extractor — we only read
///     a fixed set of meta tags from the head. The page body is
///     ignored beyond &lt;title&gt; and the favicon link.
///   - A JavaScript-aware fetcher. SPA pages that render meta
///     server-side work; SPA pages that inject &lt;meta og:..&gt;
///     after page load won't have the tags in our snapshot.
///   - An image downloader. We return the og:image URL string;
///     the client hotlinks it. If the image is paywalled or 403s,
///     it just doesn't render — the title/description still fill.
///
/// SSRF guard: same as <see cref="FeedFetcher"/> — block loopback,
/// link-local, RFC1918, and the literal "localhost" hostname. DNS
/// rebinding remains a theoretical risk and an attacker controlling
/// DNS could route around it; for NoteControl's single-admin
/// threat model this is good enough.
///
/// Failure modes throw <see cref="StartpageException"/> with an
/// appropriate status code; the endpoint maps to RFC 7807 Problem
/// responses the client surfaces inline.
/// </summary>
public sealed class LinkPreviewFetcher : ILinkPreviewFetcher
{
    /// <summary>
    /// Cache results for an hour. Link metadata changes much less
    /// often than feed content, and the user is likely to type a
    /// URL once and not re-trigger the fetch — but a paste + undo
    /// + paste cycle could fire the same URL several times within
    /// seconds, and cached responses make that free.
    /// </summary>
    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(1);

    /// <summary>
    /// 8 seconds. Slow sites exist — picking 8s rather than the
    /// feedfetcher's 10s because metadata fetch is user-facing
    /// (they're waiting for the title to fill in) while feed
    /// fetch is background block render.
    /// </summary>
    private static readonly TimeSpan FetchTimeout = TimeSpan.FromSeconds(8);

    /// <summary>
    /// 1 MB. The metadata we care about lives in the &lt;head&gt;,
    /// which is rarely above a few hundred KB even on bloated sites.
    /// Cap protects against pages that stream megabytes of body
    /// (we discard it all anyway).
    /// </summary>
    private const int MaxResponseBytes = 1 * 1024 * 1024;

    private static readonly ConcurrentDictionary<string, CacheEntry> Cache = new();

    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<LinkPreviewFetcher> _log;

    public LinkPreviewFetcher(IHttpClientFactory httpFactory, ILogger<LinkPreviewFetcher> log)
    {
        _httpFactory = httpFactory;
        _log = log;
    }

    public async Task<LinkPreviewDto> FetchAsync(string url, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            throw new StartpageException("URL is required.");
        }

        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed)
            || (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps))
        {
            throw new StartpageException(
                "URL must be an absolute http:// or https:// URL.");
        }

        if (IsLikelyLoopbackOrPrivate(parsed))
        {
            throw new StartpageException(
                "URL points to a loopback or private network address.");
        }

        // Cache hit?
        if (Cache.TryGetValue(url, out var entry) && !entry.IsExpired)
        {
            return entry.Preview;
        }

        var client = _httpFactory.CreateClient("linkpreviewfetcher");
        client.Timeout = FetchTimeout;

        // Polite UA. Some sites (notably Cloudflare-fronted ones and
        // certain news sites) refuse responses to obvious bot UAs;
        // a browser-like UA gets us further without crossing into
        // outright lying. We still self-identify the project so a
        // server admin can grep their logs for us.
        if (!client.DefaultRequestHeaders.UserAgent.Any())
        {
            client.DefaultRequestHeaders.UserAgent.ParseAdd(
                "Mozilla/5.0 (compatible; NoteControl/1.0; +link-preview)");
            client.DefaultRequestHeaders.Accept.Clear();
            client.DefaultRequestHeaders.Accept.Add(
                new MediaTypeWithQualityHeaderValue("text/html"));
            client.DefaultRequestHeaders.Accept.Add(
                new MediaTypeWithQualityHeaderValue("application/xhtml+xml", 0.9));
            client.DefaultRequestHeaders.Accept.Add(
                new MediaTypeWithQualityHeaderValue("*/*", 0.5));
        }

        string body;
        Uri finalUri;
        try
        {
            using var resp = await client.GetAsync(
                url,
                HttpCompletionOption.ResponseHeadersRead,
                ct);

            if (!resp.IsSuccessStatusCode)
            {
                throw new StartpageException(
                    $"Page returned HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}.",
                    statusCode: 502);
            }

            // Only parse if it actually looks like HTML. A user could
            // paste a link to a PDF or image; those legitimately have
            // no OG metadata and we shouldn't try to parse them as
            // HTML — empty preview is the honest answer.
            var ctype = resp.Content.Headers.ContentType?.MediaType ?? "";
            var looksLikeHtml = ctype.Contains("html", StringComparison.OrdinalIgnoreCase)
                || ctype.Contains("xhtml", StringComparison.OrdinalIgnoreCase)
                || string.IsNullOrEmpty(ctype); // some servers omit Content-Type
            if (!looksLikeHtml)
            {
                _log.LogDebug(
                    "Link preview skipped non-HTML content-type {ContentType} at {Url}",
                    ctype, url);
                // Return a near-empty preview rather than 502 — the
                // page is reachable and valid, it just doesn't expose
                // OG metadata. The client treats this as "fetch
                // succeeded, no auto-fill data."
                var emptyPreview = new LinkPreviewDto(
                    Url: resp.RequestMessage?.RequestUri?.ToString() ?? url,
                    Title: string.Empty,
                    Description: string.Empty,
                    ImageUrl: string.Empty);
                Cache[url] = new CacheEntry(emptyPreview, DateTime.UtcNow + CacheTtl);
                return emptyPreview;
            }

            // Capture the post-redirect URL so relative paths in OG
            // tags resolve correctly. We need the FINAL URL because
            // a redirect from http://x.com to https://www.x.com/path
            // changes what "/image.png" resolves to.
            finalUri = resp.RequestMessage?.RequestUri ?? parsed;

            // Cap the read.
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
                    // We've still got the head by now in 99% of cases,
                    // so try to parse what we have. If we don't have
                    // the head yet (unlikely at 1 MB), the parser
                    // returns empty fields which is fine.
                    _log.LogDebug(
                        "Link preview truncated at {Bytes} bytes for {Url}",
                        MaxResponseBytes, url);
                    break;
                }
                ms.Write(buf, 0, n);
            }

            // Charset: honour the server's declaration; fall back to
            // UTF-8. Many pages also declare via <meta charset="..">
            // in the head — we don't re-decode for that, because the
            // OG-tag values we read are ASCII property names; only
            // the content strings might be non-UTF-8, and mojibake
            // in a description string isn't a feature-breaking bug.
            var charset = resp.Content.Headers.ContentType?.CharSet;
            var encoding = TryGetEncoding(charset) ?? Encoding.UTF8;
            body = encoding.GetString(ms.ToArray());
        }
        catch (HttpRequestException ex)
        {
            throw new StartpageException(
                $"Could not reach page: {ex.Message}",
                statusCode: 502);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new StartpageException(
                $"Page fetch timed out after {FetchTimeout.TotalSeconds} seconds.",
                statusCode: 504);
        }

        // Parse.
        var preview = ExtractMetadata(body, finalUri);
        Cache[url] = new CacheEntry(preview, DateTime.UtcNow + CacheTtl);
        return preview;
    }

    // -----------------------------------------------------------------
    // Parsing
    // -----------------------------------------------------------------

    /// <summary>
    /// Extract the metadata fields from raw HTML. Uses regex rather
    /// than a full HTML parser — the meta tags we care about have
    /// extremely consistent shapes and live in &lt;head&gt;, and
    /// pulling in AngleSharp/HtmlAgilityPack just to read half a
    /// dozen tags isn't justified. If a page ships malformed HTML
    /// that our regexes can't read, the user can hand-fill the row.
    /// </summary>
    internal static LinkPreviewDto ExtractMetadata(string html, Uri baseUri)
    {
        // Resolution order matches the DTO comment:
        //   Title:       og:title -> twitter:title -> <title>
        //   Description: og:description -> twitter:description -> meta name="description"
        //   Image:       og:image -> twitter:image -> apple-touch-icon -> <link rel="icon">
        var title =
            FirstNonEmpty(
                ReadMetaProperty(html, "og:title"),
                ReadMetaName(html, "twitter:title"),
                ReadTitleTag(html));

        var description =
            FirstNonEmpty(
                ReadMetaProperty(html, "og:description"),
                ReadMetaName(html, "twitter:description"),
                ReadMetaName(html, "description"));

        var imageRaw =
            FirstNonEmpty(
                ReadMetaProperty(html, "og:image"),
                ReadMetaName(html, "twitter:image"),
                ReadLinkRel(html, "apple-touch-icon"),
                ReadLinkRel(html, "icon"));

        // Resolve relative image URLs against the page URL. Some
        // sites use protocol-relative ("//cdn.example.com/x.png"),
        // root-relative ("/x.png"), or document-relative
        // ("img/x.png") image URLs; all need the base.
        var imageAbs = ResolveAbsolute(imageRaw, baseUri);

        // Final fallback: the well-known /favicon.ico path at the
        // page's host. Every browser tries this when no <link rel>
        // declares a favicon, and most sites have one served from
        // the document root regardless of whether they advertise it
        // in HTML. This rescues two common cases:
        //   1. Pages with no OG/twitter/<link rel> meta at all
        //      (lots of plain content pages, internal tools).
        //   2. Cookie-consent / interstitial pages that serve a
        //      stub HTML before the real content (Beckhoff's
        //      "Inden du fortsætter" gate, GDPR walls, etc.) —
        //      the gate has no OG meta but the favicon is still
        //      served from the same host.
        // We don't HEAD-check the URL exists. The client hotlinks
        // it and the <img onError> handler hides it if the file
        // genuinely doesn't exist (returns 404 / 403). This trades
        // one network round-trip server-side for graceful degrade
        // client-side, which matches the existing trade-off for
        // og:image (also un-HEAD-checked).
        if (string.IsNullOrEmpty(imageAbs))
        {
            // Build "{scheme}://{authority}/favicon.ico". Authority
            // is host + non-default port (e.g. "example.com:8080"),
            // so a service on a custom port still gets the right
            // favicon URL. UriBuilder is overkill for a fixed path;
            // string interpolation is fine here.
            var port = baseUri.IsDefaultPort ? "" : $":{baseUri.Port}";
            imageAbs = $"{baseUri.Scheme}://{baseUri.Host}{port}/favicon.ico";
        }

        return new LinkPreviewDto(
            Url: baseUri.ToString(),
            Title: DecodeAndCollapse(title),
            Description: DecodeAndCollapse(description),
            ImageUrl: imageAbs);
    }

    // Each regex below is anchored to the start of a meta/link/title
    // tag, with the attributes order-flexible (real-world HTML puts
    // them in any order). RegexOptions.IgnoreCase so <META>, <Meta>,
    // <meta> all match; Singleline so . crosses newlines in case a
    // tag is split across lines.
    private const RegexOptions REGEX_OPTS =
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.Compiled;

    /// <summary>
    /// Match: &lt;meta property="og:something" content="..."&gt;
    /// (or content first, property second — order varies in the wild).
    /// </summary>
    private static string ReadMetaProperty(string html, string property)
    {
        // Property-first form
        var r1 = new Regex(
            @"<meta\s+[^>]*?property\s*=\s*[""']" + Regex.Escape(property)
                + @"[""']\s+[^>]*?content\s*=\s*[""']([^""']*)[""'][^>]*?>",
            REGEX_OPTS);
        var m = r1.Match(html);
        if (m.Success) return m.Groups[1].Value;

        // Content-first form
        var r2 = new Regex(
            @"<meta\s+[^>]*?content\s*=\s*[""']([^""']*)[""']\s+[^>]*?property\s*=\s*[""']"
                + Regex.Escape(property) + @"[""'][^>]*?>",
            REGEX_OPTS);
        m = r2.Match(html);
        return m.Success ? m.Groups[1].Value : string.Empty;
    }

    /// <summary>
    /// Match: &lt;meta name="twitter:something" content="..."&gt;
    /// Same dual-order handling as ReadMetaProperty.
    /// </summary>
    private static string ReadMetaName(string html, string name)
    {
        var r1 = new Regex(
            @"<meta\s+[^>]*?name\s*=\s*[""']" + Regex.Escape(name)
                + @"[""']\s+[^>]*?content\s*=\s*[""']([^""']*)[""'][^>]*?>",
            REGEX_OPTS);
        var m = r1.Match(html);
        if (m.Success) return m.Groups[1].Value;

        var r2 = new Regex(
            @"<meta\s+[^>]*?content\s*=\s*[""']([^""']*)[""']\s+[^>]*?name\s*=\s*[""']"
                + Regex.Escape(name) + @"[""'][^>]*?>",
            REGEX_OPTS);
        m = r2.Match(html);
        return m.Success ? m.Groups[1].Value : string.Empty;
    }

    /// <summary>
    /// Match: &lt;link rel="icon" href="..."&gt;.
    /// rel can carry multiple tokens ("shortcut icon", "icon"); we
    /// match by substring so either matches.
    /// </summary>
    private static string ReadLinkRel(string html, string rel)
    {
        // rel-first form
        var r1 = new Regex(
            @"<link\s+[^>]*?rel\s*=\s*[""'][^""']*\b" + Regex.Escape(rel)
                + @"\b[^""']*[""']\s+[^>]*?href\s*=\s*[""']([^""']*)[""'][^>]*?>",
            REGEX_OPTS);
        var m = r1.Match(html);
        if (m.Success) return m.Groups[1].Value;

        // href-first form
        var r2 = new Regex(
            @"<link\s+[^>]*?href\s*=\s*[""']([^""']*)[""']\s+[^>]*?rel\s*=\s*[""'][^""']*\b"
                + Regex.Escape(rel) + @"\b[^""']*[""'][^>]*?>",
            REGEX_OPTS);
        m = r2.Match(html);
        return m.Success ? m.Groups[1].Value : string.Empty;
    }

    private static readonly Regex TitleRegex = new(
        @"<title[^>]*>(.*?)</title>",
        REGEX_OPTS);

    private static string ReadTitleTag(string html)
    {
        var m = TitleRegex.Match(html);
        return m.Success ? m.Groups[1].Value : string.Empty;
    }

    /// <summary>
    /// Resolve a (possibly relative) URL against the page's final URL
    /// into an absolute http(s) URL. Returns empty for empty input,
    /// for relative-paths that fail resolution, or for resolved URLs
    /// with a non-http(s) scheme (e.g. "javascript:", "data:").
    /// </summary>
    private static string ResolveAbsolute(string raw, Uri baseUri)
    {
        if (string.IsNullOrWhiteSpace(raw)) return string.Empty;

        // Decode HTML entities in the URL first — &amp; in query
        // strings is common ("https://x.com/?a=1&amp;b=2").
        var decoded = WebUtility.HtmlDecode(raw).Trim();

        if (Uri.TryCreate(baseUri, decoded, out var combined)
            && (combined.Scheme == Uri.UriSchemeHttp
                || combined.Scheme == Uri.UriSchemeHttps))
        {
            return combined.ToString();
        }
        return string.Empty;
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    private static string FirstNonEmpty(params string[] candidates)
    {
        foreach (var c in candidates)
        {
            if (!string.IsNullOrWhiteSpace(c)) return c;
        }
        return string.Empty;
    }

    /// <summary>
    /// Decode HTML entities (&amp;amp; -> &amp;, &amp;quot; -> ",
    /// &amp;#39; -> ', etc.) and collapse whitespace runs to single
    /// spaces. Meta-tag values come from CMSes that emit literal
    /// entities; the user wants to see the rendered string in their
    /// link entry, not "Cookies &amp;amp; Cream."
    /// </summary>
    private static string DecodeAndCollapse(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return string.Empty;
        var decoded = WebUtility.HtmlDecode(raw);
        return WhitespaceRegex.Replace(decoded, " ").Trim();
    }

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
    /// Same SSRF guard as <see cref="FeedFetcher.IsLikelyLoopbackOrPrivate"/>.
    /// Kept duplicated rather than extracted to a shared helper because
    /// the two fetchers may diverge (e.g. allowing http://localhost for
    /// dev-mode RSS feeds while still blocking it here); when/if they
    /// converge for good, refactor to one place.
    /// </summary>
    private static bool IsLikelyLoopbackOrPrivate(Uri uri)
    {
        var host = uri.Host;
        if (IPAddress.TryParse(host, out var ip))
        {
            if (IPAddress.IsLoopback(ip)) return true;
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
        return host.Equals("localhost", StringComparison.OrdinalIgnoreCase);
    }

    private sealed record CacheEntry(LinkPreviewDto Preview, DateTime ExpiresAtUtc)
    {
        public bool IsExpired => DateTime.UtcNow >= ExpiresAtUtc;
    }
}
