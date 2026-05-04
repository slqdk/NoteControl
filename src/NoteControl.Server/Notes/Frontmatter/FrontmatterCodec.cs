using System.Globalization;
using System.Text;
using NoteControl.Shared.Notes;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace NoteControl.Server.Notes.Frontmatter;

/// <summary>
/// In-memory representation of parsed frontmatter. Created/Updated/Tags/Locked
/// + Font/FontSize/Width are the well-known fields. Extra holds anything else
/// from the YAML, with values typed as YamlDotNet's untyped graph
/// (Dictionary&lt;object,object&gt; / List&lt;object&gt; / string) so we can
/// round-trip arbitrary nested YAML without modelling it.
///
/// Step 14: Font / FontSize / Width let each note override the editor's
/// look. They're optional — when null, the editor uses its default style.
/// </summary>
public sealed class ParsedFrontmatter
{
    public DateTimeOffset? Created { get; set; }
    public DateTimeOffset? Updated { get; set; }
    public List<string> Tags { get; set; } = new();
    public bool Locked { get; set; }

    /// <summary>CSS font-family value (or short alias like "Inter"). Null = inherit.</summary>
    public string? Font { get; set; }

    /// <summary>Font size in pixels. Null = inherit.</summary>
    public int? FontSize { get; set; }

    /// <summary>Page width override in pixels. Null = use the default 700px.</summary>
    public int? Width { get; set; }

    /// <summary>
    /// Ship 68: free-text per-note version string. Defaults to
    /// <see cref="FrontmatterCodec.DefaultVersion"/> ("v0.0") for notes
    /// whose YAML frontmatter doesn't carry a `version` key — the codec
    /// fills the default during Split so consumers always see a value.
    /// On write, EmitYaml always emits the key (so once a note is saved
    /// after Ship 68 it has v0.0 persisted). Free-text by design — the
    /// user picks the format.
    /// </summary>
    public string Version { get; set; } = FrontmatterCodec.DefaultVersion;

    /// <summary>
    /// Unknown YAML keys preserved verbatim. Insertion order is preserved.
    /// Values are the deserialised YAML graph; pass them straight back to
    /// the serialiser to round-trip.
    /// </summary>
    public Dictionary<string, object?> Extra { get; set; } = new();

    public FrontmatterDto ToDto()
    {
        // For the wire-side dictionary we flatten Extra values to their
        // string representation. The HTTP API doesn't try to expose nested
        // structures — that comes if/when a frontend metadata editor wants
        // typed access.
        var extraStrings = new Dictionary<string, string>(Extra.Count);
        foreach (var kvp in Extra)
        {
            extraStrings[kvp.Key] = kvp.Value switch
            {
                null => string.Empty,
                string s => s,
                IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
                { } v => v.ToString() ?? string.Empty,
            };
        }
        return new FrontmatterDto(
            Created, Updated, Tags.ToList(), Locked,
            Font, FontSize, Width,
            Version,
            extraStrings);
    }
}

/// <summary>
/// Splits a markdown document into frontmatter + body and rebuilds it on
/// write. The frontmatter block is always emitted, even when all named
/// fields are empty, so the file format stays predictable.
/// </summary>
public static class FrontmatterCodec
{
    private const string Delim = "---";

    /// <summary>
    /// Ship 68: every note has a free-text version string. New notes
    /// and pre-Ship-68 notes that have no `version` YAML key both
    /// default to this value. The constant lives here (single source
    /// of truth) so the parser, emitter, ApplyUpdate, and any future
    /// caller that needs to pre-fill a sensible default all read it
    /// from one place.
    /// </summary>
    public const string DefaultVersion = "v0.0";

    private static readonly IDeserializer Deserializer = new DeserializerBuilder()
        .WithNamingConvention(NullNamingConvention.Instance)
        .IgnoreUnmatchedProperties()
        .Build();

    private static readonly ISerializer Serializer = new SerializerBuilder()
        .WithNamingConvention(NullNamingConvention.Instance)
        .DisableAliases()
        .Build();

    public static (ParsedFrontmatter Frontmatter, string Body) Split(string fullText)
    {
        if (string.IsNullOrEmpty(fullText))
        {
            return (new ParsedFrontmatter(), string.Empty);
        }

        var text = NormaliseLineEndings(fullText);

        if (!StartsWithDelim(text))
        {
            return (new ParsedFrontmatter(), text);
        }

        var lines = text.Split('\n');
        var closeIndex = -1;
        for (var i = 1; i < lines.Length; i++)
        {
            if (lines[i] == Delim)
            {
                closeIndex = i;
                break;
            }
        }

        if (closeIndex < 0)
        {
            // Looks like frontmatter but never closes — refuse to interpret
            // and treat as plain body so we don't lose data.
            return (new ParsedFrontmatter(), text);
        }

        var yamlText = string.Join('\n', lines.Skip(1).Take(closeIndex - 1));
        var bodyText = string.Join('\n', lines.Skip(closeIndex + 1));
        if (bodyText.StartsWith('\n')) bodyText = bodyText[1..];

        var fm = ParseYaml(yamlText);
        return (fm, bodyText);
    }

    public static string Combine(ParsedFrontmatter frontmatter, string body)
    {
        // YamlDotNet's serializer may emit CRLF on Windows by default. Force
        // LF to satisfy the spec's "LF inside files" rule.
        var yaml = NormaliseLineEndings(EmitYaml(frontmatter));
        var sb = new StringBuilder(yaml.Length + body.Length + 16);
        sb.Append(Delim).Append('\n');
        sb.Append(yaml);
        if (!yaml.EndsWith('\n')) sb.Append('\n');
        sb.Append(Delim).Append('\n');
        sb.Append('\n');
        sb.Append(NormaliseLineEndings(body).TrimStart('\n'));
        return sb.ToString();
    }

    /// <summary>
    /// Apply create/update semantics: bump Updated to now; set Created if
    /// missing; replace Tags / Locked / Font / FontSize / Width / Version
    /// if the request supplied them; leave Extra alone.
    ///
    /// Empty-string Font, or 0 FontSize / Width, are interpreted as
    /// "remove this field" — the codec will then emit no key for them.
    /// This is how the frontend clears a previously-set value without a
    /// separate "delete" verb.
    ///
    /// Ship 68: Version is treated differently — it's never "removed".
    /// Empty-string newVersion resets to <see cref="DefaultVersion"/>
    /// rather than deleting the YAML key. Null/whitespace on the
    /// existing fm.Version is also healed to the default here, which
    /// is the backfill mechanism for pre-Ship-68 notes: any save
    /// (tags, locked, body, etc.) lands a v0.0 in their frontmatter.
    /// </summary>
    public static void ApplyUpdate(
        ParsedFrontmatter fm,
        DateTimeOffset now,
        IReadOnlyList<string>? newTags,
        bool? newLocked,
        string? newFont = null,
        int? newFontSize = null,
        int? newWidth = null,
        string? newVersion = null)
    {
        fm.Created ??= now;
        fm.Updated = now;
        if (newTags is not null) fm.Tags = newTags.ToList();
        if (newLocked.HasValue) fm.Locked = newLocked.Value;

        // Sentinel handling: empty string / 0 means "clear", non-null
        // truthy means "set", null means "leave alone".
        if (newFont is not null)
        {
            fm.Font = string.IsNullOrWhiteSpace(newFont) ? null : newFont;
        }
        if (newFontSize.HasValue)
        {
            fm.FontSize = newFontSize.Value <= 0 ? null : newFontSize.Value;
        }
        if (newWidth.HasValue)
        {
            fm.Width = newWidth.Value <= 0 ? null : newWidth.Value;
        }

        // Version: explicit value -> trim and set; empty -> reset to
        // default (NOT delete); null -> don't touch.
        if (newVersion is not null)
        {
            var trimmed = newVersion.Trim();
            fm.Version = trimmed.Length == 0 ? DefaultVersion : trimmed;
        }

        // Backfill safety net: if the note has no version (pre-Ship-68
        // file just read off disk where Split couldn't fill it because
        // someone constructed ParsedFrontmatter manually, or the
        // string field somehow ended up empty), make sure we write
        // SOMETHING sensible. This is what "v0.0 added on first save"
        // refers to in the user's spec.
        if (string.IsNullOrWhiteSpace(fm.Version))
        {
            fm.Version = DefaultVersion;
        }
    }

    private static ParsedFrontmatter ParseYaml(string yaml)
    {
        var fm = new ParsedFrontmatter();
        if (string.IsNullOrWhiteSpace(yaml)) return fm;

        Dictionary<object, object?>? graph;
        try
        {
            graph = Deserializer.Deserialize<Dictionary<object, object?>>(yaml);
        }
        catch
        {
            // Malformed frontmatter — return empty, preserve nothing. The
            // body is unaffected. Better to wipe a corrupt frontmatter than
            // misinterpret it.
            return fm;
        }

        if (graph is null) return fm;

        foreach (var kvp in graph)
        {
            var key = kvp.Key.ToString();
            if (key is null) continue;

            switch (key)
            {
                case "created":
                    fm.Created = TryParseDate(kvp.Value);
                    break;
                case "updated":
                    fm.Updated = TryParseDate(kvp.Value);
                    break;
                case "tags":
                    fm.Tags = ReadStringList(kvp.Value);
                    break;
                case "locked":
                    fm.Locked = ReadBool(kvp.Value);
                    break;
                case "font":
                    fm.Font = ReadOptionalString(kvp.Value);
                    break;
                case "fontSize":
                    fm.FontSize = ReadOptionalInt(kvp.Value);
                    break;
                case "width":
                    fm.Width = ReadOptionalInt(kvp.Value);
                    break;
                case "version":
                    // Ship 68: read free-text version. Empty/whitespace
                    // becomes the default below — we don't preserve a
                    // blank version key as "blank version".
                    fm.Version = ReadOptionalString(kvp.Value) ?? string.Empty;
                    break;
                default:
                    fm.Extra[key] = kvp.Value;
                    break;
            }
        }

        // Ship 68: backfill at READ time. If the on-disk frontmatter
        // had no `version` key, fm.Version is still whatever the
        // ParsedFrontmatter constructor set it to (DefaultVersion).
        // If the key existed but was blank/whitespace, the case above
        // wrote string.Empty — fix that up too. Either way, after
        // ParseYaml returns the field is non-empty. The on-disk file
        // ISN'T touched here; that happens whenever ApplyUpdate runs
        // for any other reason ("on first save" semantics).
        if (string.IsNullOrWhiteSpace(fm.Version))
        {
            fm.Version = DefaultVersion;
        }

        return fm;
    }

    private static string EmitYaml(ParsedFrontmatter fm)
    {
        // Single dictionary so YamlDotNet emits keys in our chosen order
        // (Dictionary<,> preserves insertion order in modern .NET).
        var output = new Dictionary<object, object?>();
        if (fm.Created.HasValue) output["created"] = FormatDate(fm.Created.Value);
        if (fm.Updated.HasValue) output["updated"] = FormatDate(fm.Updated.Value);
        output["tags"] = fm.Tags.Count == 0
            ? new List<object>()
            : fm.Tags.Cast<object>().ToList();
        output["locked"] = fm.Locked;

        // Optional appearance fields: emit only if set. Unset keys are
        // simply omitted from the YAML so a default-styled note has a
        // minimal frontmatter block.
        if (!string.IsNullOrWhiteSpace(fm.Font)) output["font"] = fm.Font;
        if (fm.FontSize.HasValue) output["fontSize"] = fm.FontSize.Value;
        if (fm.Width.HasValue) output["width"] = fm.Width.Value;

        // Ship 68: version is always emitted (unlike the appearance
        // fields). A note that's been read or written under Ship 68+
        // has fm.Version set — either from disk, from a user edit, or
        // backfilled by ApplyUpdate. Always-emit means the file format
        // is predictable: every saved note has a `version:` line.
        // Defensive guard: if Version somehow ended up null/empty (a
        // direct ParsedFrontmatter construction that bypassed
        // ApplyUpdate, e.g.), fall back to the default rather than
        // emitting `version:` with a blank value.
        output["version"] = string.IsNullOrWhiteSpace(fm.Version)
            ? DefaultVersion
            : fm.Version;

        foreach (var kvp in fm.Extra)
        {
            output.TryAdd(kvp.Key, kvp.Value);
        }
        return Serializer.Serialize(output);
    }

    // ---------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------

    private static string NormaliseLineEndings(string s)
        => s.Replace("\r\n", "\n").Replace('\r', '\n');

    private static bool StartsWithDelim(string text)
    {
        if (!text.StartsWith(Delim, StringComparison.Ordinal)) return false;
        if (text.Length == Delim.Length) return true;
        return text[Delim.Length] == '\n';
    }

    private static DateTimeOffset? TryParseDate(object? value)
    {
        if (value is null) return null;
        var s = value.ToString();
        if (string.IsNullOrEmpty(s)) return null;
        return DateTimeOffset.TryParse(
                s, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out var dto)
            ? dto
            : null;
    }

    private static List<string> ReadStringList(object? value)
    {
        if (value is null) return new();
        if (value is List<object> list)
        {
            return list
                .Where(x => x is not null)
                .Select(x => x!.ToString()!)
                .ToList();
        }
        if (value is string s && !string.IsNullOrEmpty(s))
        {
            // Single-string tag value is unusual but tolerated.
            return new List<string> { s };
        }
        return new List<string>();
    }

    private static bool ReadBool(object? value)
    {
        if (value is bool b) return b;
        if (value is string s && bool.TryParse(s, out var parsed)) return parsed;
        return false;
    }

    private static string? ReadOptionalString(object? value)
    {
        if (value is null) return null;
        var s = value.ToString();
        return string.IsNullOrWhiteSpace(s) ? null : s;
    }

    private static int? ReadOptionalInt(object? value)
    {
        if (value is null) return null;
        if (value is int i) return i > 0 ? i : null;
        var s = value.ToString();
        if (string.IsNullOrWhiteSpace(s)) return null;
        if (int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
        {
            return parsed > 0 ? parsed : null;
        }
        return null;
    }

    private static string FormatDate(DateTimeOffset dto)
        => dto.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
}
