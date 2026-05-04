using System.Globalization;
using System.Text;
using AngleSharp;
using AngleSharp.Dom;
using AngleSharp.Html.Dom;
using AngleSharp.Html.Parser;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using HtmlToOpenXml;
using Markdig;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using NoteControl.Server.Data;
using NoteControl.Server.Notes.Frontmatter;
using NoteControl.Server.Notes.Services;
using NoteControl.Server.Vaults.Services;

namespace NoteControl.Server.Notes.Export;

/// <summary>
/// Exports a note to a binary file the user can download.
/// <para>
/// Pipeline:
/// <list type="number">
///   <item>Read .md from disk (existing INoteService.GetAsync would
///         re-canonicalise; we go direct because we need both the
///         frontmatter and the absolute path for asset lookups).</item>
///   <item>Split into frontmatter + body via FrontmatterCodec.</item>
///   <item>Render body markdown to HTML via Markdig with the
///         "advanced" extensions (tables, autolinks, task lists).
///         Custom callout HTML and code-block-with-title HTML
///         survive intact since Markdig passes literal HTML blocks
///         through.</item>
///   <item>Post-process the HTML:
///         <list type="bullet">
///           <item>Resolve relative image src into absolute file
///                 paths inside the vault, read the bytes, and
///                 rewrite as data: URIs so HtmlToOpenXml embeds
///                 them as part files.</item>
///           <item>Replace each &lt;div class="nc-callout..."&gt;
///                 with a single-cell colored table that
///                 HtmlToOpenXml renders predictably.</item>
///           <item>Skip videos (docx can't carry inline video) —
///                 substitute a placeholder paragraph.</item>
///         </list>
///   </item>
///   <item>Hand the cleaned HTML to HtmlToOpenXml.HtmlConverter
///         which writes to the docx's MainDocumentPart.</item>
///   <item>Configure A4 page geometry + 1-inch margins, set the
///         document default font from frontmatter (or fall back
///         to Cambria 11pt — Word's default).</item>
/// </list>
/// </para>
/// </summary>
public interface INoteExportService
{
    /// <summary>
    /// Render the note at <paramref name="notePath"/> as a docx
    /// document. Returns the bytes plus a suggested filename
    /// (without extension — the endpoint adds .docx).
    /// </summary>
    Task<NoteExport> ExportDocxAsync(
        Guid vaultId,
        string notePath,
        CancellationToken ct = default);
}

/// <summary>
/// Result of an export. <see cref="Bytes"/> is the rendered
/// document; <see cref="BaseFileName"/> is the note's filename
/// without the .md extension, suitable for use in
/// Content-Disposition.
/// </summary>
public sealed record NoteExport(byte[] Bytes, string BaseFileName);

public sealed class NoteExportService : INoteExportService
{
    private const string DefaultFont = "Cambria";
    private const int DefaultFontSizePt = 11;

    // A4 in twips (1 inch = 1440 twips, 1 cm ≈ 567 twips).
    // 210 mm × 297 mm → 11906 × 16838 twips. Standard.
    private const int A4WidthTwips = 11906;
    private const int A4HeightTwips = 16838;
    private const int OneInchTwips = 1440;

    // Callout colour mapping. Light fill + a stripe-like left
    // border colour. Words match the variants in
    // Frontend/src/editor/CalloutExtension.ts.
    private static readonly Dictionary<string, (string Fill, string Border, string Icon, string Title)>
        CalloutStyles = new(StringComparer.OrdinalIgnoreCase)
    {
        { "error",   ("#fef2f2", "#dc2626", "🚫", "Error")   },
        { "warning", ("#fefce8", "#ca8a04", "⚠",  "Warning") },
        { "info",    ("#eff6ff", "#2563eb", "ℹ",  "Info")    },
        { "tip",     ("#ecfdf5", "#16a34a", "💡", "Tip")     },
        { "note",    ("#f8fafc", "#64748b", "📝", "Note")    },
    };

    // Marker text used to bracket callout bodies in the HTML stream.
    // After HtmlToOpenXml converts the HTML to OOXML paragraphs,
    // we walk the body looking for these exact text values to find
    // where each callout starts/ends and wrap the bracketed
    // paragraphs in a hand-built styled table. Strings are chosen
    // to be unlikely to appear in real notes — wrap markers with
    // <<< >>> on both ends and use SHOUTY identifiers so an
    // accidental match in user content is essentially impossible.
    private const string CalloutMarkerBegin = "<<<NC_CALLOUT_BEGIN:";
    private const string CalloutMarkerSep   = ">>>";
    private const string CalloutMarkerEnd   = "<<<NC_CALLOUT_END>>>";

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;
    private readonly INotePathResolver _notePaths;
    private readonly ILogger<NoteExportService> _log;

    public NoteExportService(
        ServerDbContext db,
        IVaultPathResolver vaultPaths,
        INotePathResolver notePaths,
        ILogger<NoteExportService> log)
    {
        _db = db;
        _vaultPaths = vaultPaths;
        _notePaths = notePaths;
        _log = log;
    }

    public async Task<NoteExport> ExportDocxAsync(
        Guid vaultId,
        string notePath,
        CancellationToken ct = default)
    {
        // ---- 1. Resolve + read the note ----------------------------
        var vaultRoot = await ResolveVaultRootAsync(vaultId, ct);
        string canonical, absolute;
        try
        {
            canonical = _notePaths.CanonicalizeNote(notePath);
            absolute = _notePaths.Resolve(vaultRoot, canonical);
        }
        catch (InvalidNotePathException ex)
        {
            throw new NoteException(ex.Message);
        }

        if (!File.Exists(absolute))
        {
            throw new NoteException("Note not found.", statusCode: 404);
        }

        var raw = await File.ReadAllTextAsync(absolute, Encoding.UTF8, ct);
        var (fm, body) = FrontmatterCodec.Split(raw);

        // ---- 2. Markdown → HTML ------------------------------------
        // UseAdvancedExtensions enables tables, task lists, autolinks,
        // GFM-style lists, footnotes, and HTML inline. The HTML inline
        // matters: it's how callouts and code-block-with-title survive
        // round-trip from the editor's markdown serialisation.
        var pipeline = new MarkdownPipelineBuilder()
            .UseAdvancedExtensions()
            .Build();
        var html = Markdown.ToHtml(body, pipeline);

        // ---- 3. Post-process the HTML ------------------------------
        var noteParent = Path.GetDirectoryName(absolute) ?? string.Empty;
        var processed = await PostProcessHtmlAsync(html, vaultRoot, noteParent, ct);

        // Filename: strip the .md from the canonical path's last
        // segment. Sanitise so Content-Disposition doesn't choke.
        var baseName = Path.GetFileNameWithoutExtension(canonical);
        if (string.IsNullOrEmpty(baseName)) baseName = "note";

        // Ship 68: derive a display title for the docx header.
        // Same precedence as the search indexer (frontmatter "title"
        // > first H1 > filename) so the export matches what the
        // user sees in search results.
        var title = DeriveTitle(fm, body, canonical);

        // ---- 4. Build the docx -------------------------------------
        var bytes = await BuildDocxAsync(processed, fm, title, ct);

        return new NoteExport(bytes, baseName);
    }

    // ----------------------------------------------------------------
    // HTML post-processing
    // ----------------------------------------------------------------

    private async Task<string> PostProcessHtmlAsync(
        string html,
        string vaultRoot,
        string noteParent,
        CancellationToken ct)
    {
        // AngleSharp is a transitive dep of HtmlToOpenXml v3 so we
        // get a real DOM walker for free. Wrapping the markdown
        // output in a <div> root makes life easier for selectors;
        // we extract the wrapper's innerHTML at the end.
        //
        // AngleSharp.Configuration is fully qualified because step 16
        // introduced a NoteControl.Server.Configuration namespace
        // (the layered config plumbing). C# resolves enclosing-
        // namespace types before using-d ones, so a bare
        // `Configuration.Default` would now bind to our own namespace
        // and fail to find Default. Qualifying the type at the call
        // site keeps the rest of the using directives working.
        var config = AngleSharp.Configuration.Default;
        var context = BrowsingContext.New(config);
        var parser = context.GetService<IHtmlParser>()!;
        var doc = parser.ParseDocument($"<div id='nc-root'>{html}</div>");
        var root = doc.GetElementById("nc-root")!;

        // Image embedding: replace relative src with a data: URI.
        // Same-origin http(s) and data: URIs are left untouched.
        // Failures (missing file, unreadable) drop the <img>
        // entirely with a stub paragraph — better than a broken
        // image part in the docx.
        foreach (var img in root.QuerySelectorAll("img").ToArray())
        {
            ct.ThrowIfCancellationRequested();
            var src = img.GetAttribute("src");
            if (string.IsNullOrWhiteSpace(src)) { img.Remove(); continue; }
            if (src.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) continue;

            // Video files saved as <img> (Markdig doesn't know about
            // .mp4 etc. and renders any ![]() as <img>) won't render
            // as images. Stub them.
            var ext = Path.GetExtension(src).ToLowerInvariant();
            if (ext is ".mp4" or ".webm" or ".mov" or ".m4v" or ".ogv")
            {
                ReplaceWithStub(img, $"[Video: {src}]");
                continue;
            }

            if (src.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                src.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                // Remote URLs aren't fetched here — HtmlToOpenXml
                // can do that itself but we don't want the export
                // to make outbound network calls. Replace with a
                // text stub.
                ReplaceWithStub(img, $"[Image: {src}]");
                continue;
            }

            try
            {
                var (bytes, mime) = await ReadAssetAsync(src, vaultRoot, noteParent, ct);
                if (bytes is null || mime is null)
                {
                    ReplaceWithStub(img, $"[Image not found: {src}]");
                    continue;
                }
                var b64 = Convert.ToBase64String(bytes);
                img.SetAttribute("src", $"data:{mime};base64,{b64}");
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Failed to embed image {Src} for export", src);
                ReplaceWithStub(img, $"[Image error: {src}]");
            }
        }

        // Videos: docx can't carry video, so substitute a labelled
        // paragraph. Markdig itself doesn't emit <video>, but the
        // editor's VideoExtension serialises `![](file.mp4)` as
        // an <img> for known image MIME types and as raw HTML
        // <video> for video MIMEs. Cover both.
        foreach (var vid in root.QuerySelectorAll("video, source").ToArray())
        {
            var src = vid.GetAttribute("src") ?? "";
            ReplaceWithStub(vid, $"[Video: {src}]");
        }

        // Callouts: rewrite each <div class="nc-callout nc-callout-X">
        // as a pair of TEXT MARKER paragraphs bracketing the body
        // content. After HtmlToOpenXml runs we find these markers
        // in the docx body and replace them with a hand-built styled
        // table — bypassing HtmlToOpenXml's flaky CSS-on-table
        // rendering (it tends to drop background fill and border-left
        // on tables in 3.3.x).
        //
        // The marker shape is  __NC_CALLOUT_BEGIN_<variant>__ /
        // __NC_CALLOUT_END__ inside their own paragraphs, with no
        // surrounding markup so they render as plain runs the
        // post-pass can match exactly.
        //
        // Why not build the table in HTML and trust HtmlToOpenXml?
        // We tried (this comment is the receipt). HtmlToOpenXml 3.3
        // ignores `border-left` on tables and treats `background`
        // inconsistently across cells. Hand-built OOXML gets us a
        // pixel-correct Word callout every time.
        foreach (var div in root.QuerySelectorAll("div.nc-callout").ToArray())
        {
            var variant = div.GetAttribute("data-variant") ?? "note";
            if (!CalloutStyles.ContainsKey(variant)) variant = "note";

            // Fragment that goes BEFORE the callout body in HTML.
            var beginMarker = doc.CreateElement("p");
            beginMarker.TextContent = $"{CalloutMarkerBegin}{variant}{CalloutMarkerSep}";
            var endMarker = doc.CreateElement("p");
            endMarker.TextContent = CalloutMarkerEnd;

            var parent = div.Parent!;
            parent.InsertBefore(beginMarker, div);

            // Move the callout body's children INTO the parent, in
            // place, so they sit between the markers as ordinary
            // paragraphs. HtmlToOpenXml will render them with normal
            // styling; we just bracket them.
            foreach (var child in div.ChildNodes.ToArray())
            {
                parent.InsertBefore(child, div);
            }

            parent.InsertBefore(endMarker, div);
            div.Remove();
        }

        // Code blocks with titles: <pre data-title="x"><code>...</code></pre>.
        // Lift the title into a <p><strong> above the <pre>.
        // Plain code blocks (no data-title) are left alone — they
        // still render fine through HtmlToOpenXml.
        foreach (var pre in root.QuerySelectorAll("pre[data-title]").ToArray())
        {
            var title = pre.GetAttribute("data-title");
            if (string.IsNullOrWhiteSpace(title)) continue;

            var caption = doc.CreateElement("p");
            var captionStrong = doc.CreateElement("strong");
            captionStrong.TextContent = title;
            caption.AppendChild(captionStrong);
            pre.Parent!.InsertBefore(caption, pre);
        }

        // Code blocks: nudge with a background + border so they
        // visually stand out in the docx. HtmlToOpenXml respects
        // inline `style` on <pre> for these.
        //
        // Empty fix: an empty <pre> (no text content) renders as
        // NOTHING in HtmlToOpenXml — not a blank paragraph, not a
        // styled box, just gone. The styling has nothing to attach
        // to. To preserve the visual cue that "there's a code block
        // here" we inject a non-breaking space when the body is
        // whitespace-only, so HtmlToOpenXml has at least one run to
        // emit. Word renders it as a small empty styled paragraph.
        foreach (var pre in root.QuerySelectorAll("pre").ToArray())
        {
            var existing = pre.GetAttribute("style") ?? "";
            pre.SetAttribute(
                "style",
                $"{existing};background:#f4f4f5;padding:8px;" +
                "border:1px solid #e5e7eb;font-family:Consolas,monospace;");

            if (string.IsNullOrWhiteSpace(pre.TextContent))
            {
                // Find the deepest <code> child so the NBSP lands
                // inside the typical structure HtmlToOpenXml expects;
                // fall back to the <pre> itself for malformed inputs.
                var code = pre.QuerySelector("code") ?? pre;
                code.TextContent = "\u00A0";
            }
        }

        return root.InnerHtml;
    }

    /// <summary>
    /// Resolve a markdown-relative image src to a file inside the
    /// vault and read its bytes + MIME. Returns (null, null) if the
    /// resolved path doesn't exist or is outside the vault.
    /// </summary>
    private async Task<(byte[]? Bytes, string? Mime)> ReadAssetAsync(
        string src,
        string vaultRoot,
        string noteParent,
        CancellationToken ct)
    {
        // Image sources land in two shapes:
        //   "image.png"               (sibling of the note)
        //   "subfolder/image.png"     (nested)
        //   "/api/vaults/.../asset?path=..." (already-resolved
        //     editor URLs — we extract the canonical path).
        // We URL-decode each segment because the markdown source
        // tends to have %20 etc. for safety.
        string absoluteImage;
        if (src.StartsWith("/api/vaults/", StringComparison.OrdinalIgnoreCase))
        {
            // Already-resolved server URL: pull the path query.
            // Tiny manual parse so we don't depend on System.Web.
            var qIdx = src.IndexOf('?');
            if (qIdx < 0) return (null, null);
            string? p = null;
            foreach (var pair in src[(qIdx + 1)..].Split('&'))
            {
                var eq = pair.IndexOf('=');
                if (eq < 0) continue;
                var key = pair[..eq];
                if (string.Equals(key, "path", StringComparison.OrdinalIgnoreCase))
                {
                    p = Uri.UnescapeDataString(pair[(eq + 1)..]);
                    break;
                }
            }
            if (string.IsNullOrEmpty(p)) return (null, null);

            try
            {
                var canonical = _notePaths.CanonicalizeNote(p);
                absoluteImage = _notePaths.Resolve(vaultRoot, canonical);
            }
            catch (InvalidNotePathException)
            {
                return (null, null);
            }
        }
        else
        {
            var rel = src.TrimStart('.', '/');
            var decoded = string.Join('/',
                rel.Split('/').Select(seg =>
                {
                    try { return Uri.UnescapeDataString(seg); }
                    catch { return seg; }
                }));

            // Combine with the note's folder, then sanity-check the
            // result is under vaultRoot. Path.GetFullPath collapses
            // any ../.. that snuck through the markdown.
            var combined = Path.Combine(noteParent, decoded.Replace('/', Path.DirectorySeparatorChar));
            absoluteImage = Path.GetFullPath(combined);
            var rootFull = Path.GetFullPath(vaultRoot);
            if (!absoluteImage.StartsWith(
                    rootFull + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase))
            {
                // Path traversal — refuse silently.
                return (null, null);
            }
        }

        if (!File.Exists(absoluteImage)) return (null, null);

        var bytes = await File.ReadAllBytesAsync(absoluteImage, ct);
        var mime = MimeFromExtension(Path.GetExtension(absoluteImage));
        return (bytes, mime);
    }

    private static string? MimeFromExtension(string ext) => ext.ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".svg" => "image/svg+xml",
        _ => null,
    };

    private static void ReplaceWithStub(IElement el, string text)
    {
        var doc = el.Owner!;
        var p = doc.CreateElement("p");
        var em = doc.CreateElement("em");
        em.TextContent = text;
        p.AppendChild(em);
        if (el.Parent is not null)
        {
            el.Parent.ReplaceChild(p, el);
        }
    }

    // ----------------------------------------------------------------
    // docx assembly
    // ----------------------------------------------------------------

    private async Task<byte[]> BuildDocxAsync(
        string html,
        ParsedFrontmatter fm,
        string title,
        CancellationToken ct)
    {
        var fontFamily = ExtractPrimaryFontFamily(fm.Font) ?? DefaultFont;
        var fontSizePt = fm.FontSize.HasValue && fm.FontSize.Value > 0
            ? fm.FontSize.Value
            : DefaultFontSizePt;

        // Word stores font sizes in half-points (so 22 = 11 pt).
        var halfPoints = (fontSizePt * 2).ToString(CultureInfo.InvariantCulture);

        await using var ms = new MemoryStream();
        using (var docx = WordprocessingDocument.Create(ms, DocumentFormat.OpenXml.WordprocessingDocumentType.Document))
        {
            var mainPart = docx.AddMainDocumentPart();
            // Fully-qualify both Document types: AngleSharp also
            // exports a Document type from its Dom namespace, and
            // both `using` directives are in scope here.
            mainPart.Document = new DocumentFormat.OpenXml.Wordprocessing.Document(new Body());

            // Document-level defaults: font + size for the entire
            // doc. HtmlToOpenXml will create paragraph runs without
            // overriding these unless the HTML carries an explicit
            // font/size.
            ApplyDocumentDefaults(mainPart, fontFamily, halfPoints);

            // A4 page + 1-inch margins.
            ApplyPageSetup(mainPart);

            // Ship 68: header line — title left, version right, on a
            // single line. Built as a 2-cell borderless table because
            // a paragraph with a right-aligned tab stop is fragile
            // across Word/LibreOffice/Pages, while a table renders
            // identically. The header is appended BEFORE ParseBody
            // so it ends up as the first body child, ahead of any
            // user content. Style is intentionally subdued (10pt,
            // not bold, default font) — it's a reference header,
            // not a title page.
            AppendHeaderRow(mainPart, title, fm.Version, fontFamily);

            // Body conversion. We wrap in try/catch so a single
            // unparseable element doesn't sink the export — log
            // and produce whatever docx came out before the error.
            // Most failures here are CSS edge cases that don't
            // affect document validity.
            var converter = new HtmlConverter(mainPart);
            try
            {
                await converter.ParseBody(html);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "HtmlToOpenXml ParseBody errored partway; export will be partial");
            }

            // Replace the callout text-marker pairs that
            // PostProcessHtmlAsync emitted with hand-built styled
            // tables. Done AFTER ParseBody so we operate on real
            // OOXML paragraphs, not HTML — it's the reliable way
            // to get fill colour and border-left rendered in Word.
            MaterializeCallouts(mainPart);

            mainPart.Document.Save();
        }

        return ms.ToArray();
    }

    /// <summary>
    /// Take a font stack like "Inter, system-ui, sans-serif" and
    /// pull the first family name. Strips quotes around multi-word
    /// names ("Segoe UI" → Segoe UI). Returns null if the input
    /// is null/empty or the first segment is also empty.
    /// </summary>
    private static string? ExtractPrimaryFontFamily(string? stack)
    {
        if (string.IsNullOrWhiteSpace(stack)) return null;
        var first = stack.Split(',')[0].Trim();
        if (first.Length >= 2 &&
            ((first.StartsWith('"') && first.EndsWith('"')) ||
             (first.StartsWith('\'') && first.EndsWith('\''))))
        {
            first = first.Substring(1, first.Length - 2);
        }
        return string.IsNullOrWhiteSpace(first) ? null : first;
    }

    private static void ApplyDocumentDefaults(
        MainDocumentPart mainPart,
        string fontFamily,
        string halfPoints)
    {
        // HtmlConverter creates its own StyleDefinitionsPart on first
        // run; reuse it if present so we don't try to add a second
        // one (OpenXml throws on duplicate parts).
        var stylesPart = mainPart.StyleDefinitionsPart
            ?? mainPart.AddNewPart<StyleDefinitionsPart>();

        // If we just created the part, it has no Styles root yet.
        // If we're reusing one, preserve any styles the converter
        // added and only inject our DocDefaults.
        stylesPart.Styles ??= new Styles();

        var docDefaults = new DocDefaults(
            new RunPropertiesDefault(
                new RunPropertiesBaseStyle(
                    new RunFonts
                    {
                        Ascii = fontFamily,
                        HighAnsi = fontFamily,
                        ComplexScript = fontFamily,
                    },
                    new FontSize { Val = halfPoints },
                    new FontSizeComplexScript { Val = halfPoints })));

        // Replace any existing DocDefaults; otherwise prepend so it
        // sits at the start of the Styles element where Word
        // expects it.
        var existing = stylesPart.Styles.Elements<DocDefaults>().FirstOrDefault();
        if (existing is not null) existing.Remove();
        stylesPart.Styles.PrependChild(docDefaults);

        stylesPart.Styles.Save();
    }

    private static void ApplyPageSetup(MainDocumentPart mainPart)
    {
        // Append a SectionProperties at the end of the body. Word's
        // schema requires this to live as the last child of <body>
        // for it to apply to the whole doc.
        //
        // Defensive null handling: nullable analysis can't see that
        // BuildDocxAsync just assigned mainPart.Document above, so
        // we re-establish the invariant here. Same for Body.
        var doc = mainPart.Document ??= new DocumentFormat.OpenXml.Wordprocessing.Document();
        var body = doc.Body ??= new Body();
        var sectPr = new SectionProperties(
            new PageSize
            {
                Width = (uint)A4WidthTwips,
                Height = (uint)A4HeightTwips,
                Orient = PageOrientationValues.Portrait,
            },
            new PageMargin
            {
                Top = OneInchTwips,
                Right = (uint)OneInchTwips,
                Bottom = OneInchTwips,
                Left = (uint)OneInchTwips,
                Header = 720,  // 0.5 inch
                Footer = 720,
                Gutter = 0,
            });
        body.Append(sectPr);
    }

    /// <summary>
    /// Ship 68: derive the display title for the docx header.
    /// Mirrors NoteIndexer.DeriveTitle precedence: frontmatter
    /// "title" Extra key > first H1 in the body > filename. Kept
    /// here as a private static (rather than shared with the
    /// indexer) because the alternative is exposing a public
    /// helper purely for cross-module use, and the duplication is
    /// six lines.
    /// </summary>
    private static string DeriveTitle(ParsedFrontmatter fm, string body, string canonicalRelative)
    {
        // 1. Frontmatter "title" — stored under Extra (not a typed
        //    field on ParsedFrontmatter).
        if (fm.Extra.TryGetValue("title", out var raw) && raw is string s && !string.IsNullOrWhiteSpace(s))
        {
            return s.Trim();
        }

        // 2. First H1.
        using var reader = new StringReader(body);
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;
            if (line.StartsWith("# ", StringComparison.Ordinal))
            {
                return line[2..].Trim();
            }
            // First non-blank, non-H1 line wins us nothing — fall through.
            break;
        }

        // 3. Fallback to filename without extension.
        return Path.GetFileNameWithoutExtension(canonicalRelative);
    }

    /// <summary>
    /// Ship 68: build a borderless 2-cell table that puts the title
    /// on the left and the version on the right, on a single line.
    /// Appended as the first child of the document body so it sits
    /// at the top of page 1 ahead of any markdown content.
    ///
    /// Why a table and not a tab-stop paragraph: tab-stop alignment
    /// with a right-aligned tab to the page edge is fragile across
    /// Word / LibreOffice / Pages — different defaults for the
    /// usable text width, different handling of right-tab fill,
    /// occasional glitches with wide page margins. A table cell
    /// with width=50%pct + jc=right renders identically everywhere.
    ///
    /// Style intent: small (10 pt half-points = 20), not bold,
    /// default font family. Just a reference header; the body
    /// content is the document.
    /// </summary>
    private static void AppendHeaderRow(
        MainDocumentPart mainPart,
        string title,
        string version,
        string fontFamily)
    {
        // Word half-point sizes; 20 = 10 pt. Smaller than the body
        // default (22 = 11 pt) so the header reads as metadata, not
        // content. Bold deliberately omitted as per user's spec.
        const string HeaderHalfPoints = "20";

        // Run properties shared by both cells. RunFonts pinned to
        // the same family as the document defaults so the header
        // doesn't visually drift if the user picked an unusual
        // body font (Cambria default; per-note Font override
        // possible). FontSize forces the smaller header size.
        static OpenXmlElement BuildCell(string text, string fontFamily, JustificationValues justify)
        {
            var runProps = new RunProperties(
                new RunFonts
                {
                    Ascii = fontFamily,
                    HighAnsi = fontFamily,
                    ComplexScript = fontFamily,
                },
                new FontSize { Val = HeaderHalfPoints },
                new FontSizeComplexScript { Val = HeaderHalfPoints });

            // Title and version come from already-trimmed sources, so
            // we don't need xml:space="preserve" handling on the run.
            var run = new Run(runProps, new Text(text));

            var paraProps = new ParagraphProperties(
                new Justification { Val = justify },
                // Match the line-height with the rest of the
                // document so the header doesn't get an oversized
                // line gap from the table-cell default.
                new SpacingBetweenLines
                {
                    After = "0",
                    Before = "0",
                    LineRule = LineSpacingRuleValues.Auto,
                });

            // No cell borders; cell width is set in the parent.
            var cellProps = new TableCellProperties(
                new TableCellBorders(
                    new TopBorder    { Val = BorderValues.Nil },
                    new BottomBorder { Val = BorderValues.Nil },
                    new LeftBorder   { Val = BorderValues.Nil },
                    new RightBorder  { Val = BorderValues.Nil }));

            return new TableCell(cellProps, new Paragraph(paraProps, run));
        }

        var leftCell  = BuildCell(title,   fontFamily, JustificationValues.Left);
        var rightCell = BuildCell(version, fontFamily, JustificationValues.Right);

        // Two-column grid, equal width (50% each via pct=2500 of
        // 5000 = 100%). Borderless table-level too.
        var tblProps = new TableProperties(
            new TableWidth { Width = "5000", Type = TableWidthUnitValues.Pct },
            new TableBorders(
                new TopBorder     { Val = BorderValues.Nil },
                new BottomBorder  { Val = BorderValues.Nil },
                new LeftBorder    { Val = BorderValues.Nil },
                new RightBorder   { Val = BorderValues.Nil },
                new InsideHorizontalBorder { Val = BorderValues.Nil },
                new InsideVerticalBorder   { Val = BorderValues.Nil }),
            new TableLook
            {
                Val = "0000",
                FirstRow = false,
                LastRow = false,
                FirstColumn = false,
                LastColumn = false,
                NoHorizontalBand = true,
                NoVerticalBand = true,
            });

        var grid = new TableGrid(
            new GridColumn { Width = "4500" },
            new GridColumn { Width = "4500" });

        var row = new TableRow(leftCell, rightCell);
        var table = new Table(tblProps, grid, row);

        // A blank paragraph after the header gives a small gap
        // before body content starts. Without this the next
        // paragraph hugs the table top edge.
        var spacer = new Paragraph(
            new ParagraphProperties(
                new SpacingBetweenLines
                {
                    After = "0",
                    Before = "0",
                    LineRule = LineSpacingRuleValues.Auto,
                }));

        // BuildDocxAsync assigns mainPart.Document + body before
        // calling us. Use the same defensive ??= idiom that
        // ApplyPageSetup uses so the compiler's nullability flow
        // is happy without needing `!` on a reference chain.
        var doc = mainPart.Document ??= new DocumentFormat.OpenXml.Wordprocessing.Document();
        var body = doc.Body ??= new Body();
        body.AppendChild(table);
        body.AppendChild(spacer);
    }

    /// <summary>
    /// Walk the docx body, find each pair of callout markers placed
    /// by <see cref="PostProcessHtmlAsync"/>, and replace the
    /// marker-bracketed range with a single-cell styled table
    /// (fill colour, left border stripe, padding). The marker
    /// paragraphs themselves are removed in the process.
    ///
    /// We do this AFTER <c>HtmlConverter.ParseBody</c> because
    /// HtmlToOpenXml in 3.3.x does not reliably honour CSS-on-table
    /// for fill colour or border-left — going around it via
    /// hand-built OOXML is the reliable path.
    ///
    /// Robustness:
    ///   - An unmatched begin marker (no matching end before EOF)
    ///     is left untouched — better to leave a literal marker
    ///     visible in the docx than to swallow content.
    ///   - Unknown variants fall back to "note".
    ///   - Empty callout (no body paragraphs between markers) still
    ///     renders correctly: we produce a table containing only
    ///     the title row.
    /// </summary>
    private static void MaterializeCallouts(MainDocumentPart mainPart)
    {
        var body = mainPart.Document?.Body;
        if (body is null) return;

        // Snapshot child paragraphs as an indexed list so we can
        // splice safely. We only care about top-level body children
        // — markers were emitted as top-level <p>, and HtmlToOpenXml
        // preserves that structure.
        var children = body.ChildElements.ToList();

        // Track ranges to replace as (beginIndex, endIndex, variant).
        // Built in a forward pass; applied in REVERSE so earlier
        // ranges' indices stay valid while we mutate.
        var ranges = new List<(int Begin, int End, string Variant)>();

        for (int i = 0; i < children.Count; i++)
        {
            if (children[i] is not Paragraph p) continue;
            var text = p.InnerText ?? "";
            if (!text.StartsWith(CalloutMarkerBegin, StringComparison.Ordinal)) continue;

            // Parse variant out of "<<<NC_CALLOUT_BEGIN:error>>>".
            var sepIdx = text.IndexOf(CalloutMarkerSep, CalloutMarkerBegin.Length, StringComparison.Ordinal);
            if (sepIdx < 0) continue;
            var variant = text.Substring(CalloutMarkerBegin.Length, sepIdx - CalloutMarkerBegin.Length);

            // Find the matching end paragraph.
            int endIdx = -1;
            for (int j = i + 1; j < children.Count; j++)
            {
                if (children[j] is Paragraph candidate &&
                    string.Equals(candidate.InnerText, CalloutMarkerEnd, StringComparison.Ordinal))
                {
                    endIdx = j;
                    break;
                }
            }
            if (endIdx < 0)
            {
                // Unmatched begin marker — skip and continue scanning.
                // The visible literal marker is the user-facing
                // signal that something went sideways.
                continue;
            }

            ranges.Add((i, endIdx, variant));
            // Skip past the end marker so a subsequent callout
            // doesn't pick up paragraphs already consumed.
            i = endIdx;
        }

        // Apply ranges in REVERSE so prior-range index validity
        // is preserved during list mutation.
        for (int r = ranges.Count - 1; r >= 0; r--)
        {
            var (begin, end, variant) = ranges[r];
            if (!CalloutStyles.TryGetValue(variant, out var style))
            {
                style = CalloutStyles["note"];
            }

            // Collect the body paragraphs (BETWEEN markers, exclusive).
            // These are the user's note content for the callout.
            var inner = new List<OpenXmlElement>();
            for (int k = begin + 1; k < end; k++)
            {
                inner.Add(children[k]);
            }

            // Build the OOXML table.
            var table = BuildCalloutTable(style, inner);

            // Splice: remove begin marker, all inner paragraphs,
            // and end marker; insert the table at the begin
            // position. We work on the live body, not the snapshot,
            // to ensure the changes show up in mainPart.Document.
            var beginNode = children[begin];

            // Insert table BEFORE the begin marker, then remove the
            // bracketed range. Order: build invariant first.
            beginNode.InsertBeforeSelf(table);
            for (int k = begin; k <= end; k++)
            {
                children[k].Remove();
            }
        }
    }

    /// <summary>
    /// Build a single-row, single-cell table styled as a callout:
    /// pale fill, coloured left border stripe, modest padding,
    /// full available width. Cell holds a bold title row (icon +
    /// variant name) followed by the user's body paragraphs.
    /// </summary>
    private static Table BuildCalloutTable(
        (string Fill, string Border, string Icon, string Title) style,
        IList<OpenXmlElement> innerBody)
    {
        // Hex helpers — Word wants "RRGGBB" without the leading #.
        static string Hex(string css) => css.StartsWith('#') ? css[1..] : css;
        var fillHex = Hex(style.Fill);
        var borderHex = Hex(style.Border);

        // Table-level properties: pct width 100%, no inter-cell
        // padding bumps, no default cell margins. We keep table
        // borders empty and put the visible left border on the
        // cell instead — that's where Word renders it cleanly.
        var tblProps = new TableProperties(
            new TableWidth { Width = "5000", Type = TableWidthUnitValues.Pct },
            new TableLook
            {
                Val = "04A0",
                FirstRow = true,
                LastRow = false,
                FirstColumn = true,
                LastColumn = false,
                NoHorizontalBand = false,
                NoVerticalBand = true,
            });

        // Single-row grid. Word needs a TableGrid even for one cell
        // or some viewers render it weirdly.
        var grid = new TableGrid(new GridColumn { Width = "9000" });

        // Cell properties: fill colour + border-left as a 24-eighth-
        // point (3 pt) thick coloured bar; other borders set to
        // "nil" so we don't get a default grid look.
        // Cell margins use Word's default (around 115 twips per
        // side) — explicit margins via TableCellMargin are skipped
        // to avoid OOXML SDK naming inconsistencies (the SDK has
        // both LeftMargin/RightMargin and StartMargin/EndMargin
        // depending on package version). The default looks fine.
        var cellProps = new TableCellProperties(
            new TableCellWidth { Width = "5000", Type = TableWidthUnitValues.Pct },
            new Shading
            {
                Val = ShadingPatternValues.Clear,
                Color = "auto",
                Fill = fillHex,
            },
            new TableCellBorders(
                new LeftBorder
                {
                    Val = BorderValues.Single,
                    Size = 24,
                    Color = borderHex,
                },
                new TopBorder { Val = BorderValues.Nil },
                new BottomBorder { Val = BorderValues.Nil },
                new RightBorder { Val = BorderValues.Nil }));

        var cell = new TableCell(cellProps);

        // Title row: bold, icon + variant name. RunFonts ascii is
        // omitted so the document default font wins; ComplexScript
        // covers emoji / symbol fallback handling on Word.
        var titlePara = new Paragraph(
            new Run(
                new RunProperties(new Bold()),
                new Text($"{style.Icon} {style.Title}")));
        cell.Append(titlePara);

        // Body paragraphs: append the user's content directly. They
        // already exist as fully-formed OOXML elements (paragraphs,
        // lists, code blocks, inner tables, etc.) thanks to
        // HtmlToOpenXml — we just relocate them into the cell.
        foreach (var bodyEl in innerBody)
        {
            // Detach from current parent first, otherwise OpenXml
            // throws because elements can't have two parents.
            bodyEl.Remove();
            cell.Append(bodyEl);
        }

        // If there were no body paragraphs (empty callout), Word
        // renders a single-paragraph cell which is fine — the title
        // row still shows.

        var row = new TableRow(cell);
        return new Table(tblProps, grid, row);
    }

    // ----------------------------------------------------------------
    // helpers
    // ----------------------------------------------------------------

    private async Task<string> ResolveVaultRootAsync(Guid vaultId, CancellationToken ct)
    {
        var vault = await _db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Path })
            .FirstOrDefaultAsync(ct)
            ?? throw new NoteException("Vault not found.", statusCode: 404);

        return _vaultPaths.Resolve(vault.Path);
    }
}
