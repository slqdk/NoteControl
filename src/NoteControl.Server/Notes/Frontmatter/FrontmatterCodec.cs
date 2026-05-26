using System.Globalization;
using System.Text;
using NoteControl.Shared.Notes;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace NoteControl.Server.Notes.Frontmatter;

/// <summary>
/// Thrown by <see cref="FrontmatterCodec.ApplyUpdate"/> when a requested
/// version/state change violates an invariant (version lowered, releasing
/// below 1.0, setting a lifecycle state at version 0.0, unknown state
/// string). <see cref="NoteControl.Server.Notes.Services.NoteService"/>
/// catches this and surfaces it as a 400 to the caller.
/// </summary>
public sealed class FrontmatterValidationException : Exception
{
    public FrontmatterValidationException(string message) : base(message) { }
}

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
    /// Version major component. Persisted on disk as the integer part of
    /// the bare "major.minor" `version` string. Defaults to 0.
    /// </summary>
    public int VersionMajor { get; set; }

    /// <summary>
    /// Version minor component. Persisted as the fractional part of the
    /// bare "major.minor" `version` string. Defaults to 0.
    /// </summary>
    public int VersionMinor { get; set; }

    /// <summary>
    /// Lifecycle state: one of <see cref="FrontmatterCodec.StateNotVersioned"/>,
    /// <see cref="FrontmatterCodec.StateDevelopment"/>,
    /// <see cref="FrontmatterCodec.StateReleased"/>. At version 0.0 the state
    /// is always "not-versioned" (the parser/normaliser enforces this); the
    /// `state` YAML key is only emitted for development/released notes.
    /// </summary>
    public string State { get; set; } = FrontmatterCodec.StateNotVersioned;

    /// <summary>
    /// Derived "major.minor" string — the source of truth is the two int
    /// fields. Used by the docx export header and any read-only display.
    /// </summary>
    public string Version => $"{VersionMajor}.{VersionMinor}";

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
            VersionMajor, VersionMinor, State, Version,
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

    // ---------------------------------------------------------------
    // Version / state model
    // ---------------------------------------------------------------

    /// <summary>The only valid state at version 0.0. Not user-selectable.</summary>
    public const string StateNotVersioned = "not-versioned";

    /// <summary>Any version &gt; 0.0 that isn't Released.</summary>
    public const string StateDevelopment = "development";

    /// <summary>Selectable only at version &ge; 1.0.</summary>
    public const string StateReleased = "released";

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
    /// missing; replace Tags / Locked / Font / FontSize / Width if the
    /// request supplied them; leave Extra alone.
    ///
    /// Empty-string Font, or 0 FontSize / Width, are interpreted as
    /// "remove this field" — the codec will then emit no key for them.
    ///
    /// Version / state: newMajor / newMinor / newState are null = "leave
    /// alone", non-null = set. After resolving the target values the method
    /// enforces the invariants and throws
    /// <see cref="FrontmatterValidationException"/> on a violation:
    ///   - target version may not be lower than the current version
    ///     (monotonic; equal is fine for a pure state change);
    ///   - at target version 0.0 the state is forced to "not-versioned"
    ///     and supplying any other state is an error;
    ///   - "released" requires target major &ge; 1;
    ///   - the only accepted state strings are the three constants.
    ///
    /// NOTE: this method does NOT take the release-copy snapshot on a
    /// released-&gt;development transition — that's the service layer's job
    /// (it needs the on-disk file + vault root). ApplyUpdate only validates
    /// and mutates the in-memory frontmatter.
    /// </summary>
    public static void ApplyUpdate(
        ParsedFrontmatter fm,
        DateTimeOffset now,
        IReadOnlyList<string>? newTags,
        bool? newLocked,
        string? newFont = null,
        int? newFontSize = null,
        int? newWidth = null,
        int? newMajor = null,
        int? newMinor = null,
        string? newState = null)
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

        // --- Version / state ---------------------------------------

        var curMajor = fm.VersionMajor;
        var curMinor = fm.VersionMinor;

        var tgtMajor = newMajor ?? curMajor;
        var tgtMinor = newMinor ?? curMinor;

        if (tgtMajor < 0 || tgtMinor < 0)
        {
            throw new FrontmatterValidationException("Version components cannot be negative.");
        }

        // Monotonic check (major first, then minor). Equal is allowed so a
        // pure state change can be sent with the same version.
        if (Compare(tgtMajor, tgtMinor, curMajor, curMinor) < 0)
        {
            throw new FrontmatterValidationException(
                $"Version cannot be lowered (currently {curMajor}.{curMinor}, requested {tgtMajor}.{tgtMinor}).");
        }

        var targetZero = tgtMajor == 0 && tgtMinor == 0;
        string tgtState;

        if (targetZero)
        {
            // At 0.0 the only valid state is not-versioned. A caller that
            // explicitly asked for development/released here is wrong.
            if (newState is not null
                && !string.Equals(NormaliseStateString(newState), StateNotVersioned, StringComparison.Ordinal))
            {
                throw new FrontmatterValidationException(
                    "A note can only be set to Under Development or Released once its version is above 0.0.");
            }
            tgtState = StateNotVersioned;
        }
        else if (newState is not null)
        {
            var s = NormaliseStateString(newState);
            if (s is null)
            {
                throw new FrontmatterValidationException(
                    $"Unknown state '{newState}'. Expected '{StateDevelopment}' or '{StateReleased}'.");
            }
            if (string.Equals(s, StateNotVersioned, StringComparison.Ordinal))
            {
                throw new FrontmatterValidationException(
                    "'not-versioned' is only valid at version 0.0; it cannot be set explicitly.");
            }
            if (string.Equals(s, StateReleased, StringComparison.Ordinal) && tgtMajor < 1)
            {
                throw new FrontmatterValidationException(
                    "Releasing requires version 1.0 or higher.");
            }
            tgtState = s;
        }
        else
        {
            // No explicit state. Keep the current one, but a note that just
            // crossed from 0.0 into a real version (or whose on-disk state
            // was still not-versioned) becomes Under Development.
            tgtState = string.Equals(fm.State, StateNotVersioned, StringComparison.Ordinal)
                ? StateDevelopment
                : fm.State;
        }

        // Defensive: a stored "released" below 1.0 is inconsistent on-disk
        // data — clamp it down so we never emit an impossible combination.
        if (string.Equals(tgtState, StateReleased, StringComparison.Ordinal) && tgtMajor < 1)
        {
            tgtState = StateDevelopment;
        }

        fm.VersionMajor = tgtMajor;
        fm.VersionMinor = tgtMinor;
        fm.State = tgtState;
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

        string? rawState = null;

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
                    // Parse leniently. Handles the bare "1.2" form we now
                    // write, the legacy "v0.1" free-text form, and junk
                    // ("draft" -> 0.0). See ParseVersion.
                    var (maj, min) = ParseVersion(ReadOptionalString(kvp.Value));
                    fm.VersionMajor = maj;
                    fm.VersionMinor = min;
                    break;
                case "state":
                    rawState = ReadOptionalString(kvp.Value);
                    break;
                default:
                    fm.Extra[key] = kvp.Value;
                    break;
            }
        }

        // Normalise state against the parsed version. At 0.0 the state is
        // always not-versioned regardless of what was on disk; above 0.0 a
        // missing/unknown state defaults to development, and a stored
        // "released" below 1.0 (inconsistent data) is clamped to
        // development. The on-disk file ISN'T rewritten here — that happens
        // on the next ApplyUpdate-driven save.
        fm.State = NormaliseState(fm.VersionMajor, fm.VersionMinor, rawState);

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

        // Version is always emitted as a bare "major.minor" string, so the
        // file format is predictable (every saved note has a `version:`
        // line). State is emitted only when the note is actually versioned
        // — a 0.0 / not-versioned note carries no `state:` key, keeping the
        // frontmatter minimal for the common unversioned case.
        output["version"] = $"{fm.VersionMajor}.{fm.VersionMinor}";
        var state = NormaliseState(fm.VersionMajor, fm.VersionMinor, fm.State);
        if (!string.Equals(state, StateNotVersioned, StringComparison.Ordinal))
        {
            output["state"] = state;
        }

        foreach (var kvp in fm.Extra)
        {
            output.TryAdd(kvp.Key, kvp.Value);
        }
        return Serializer.Serialize(output);
    }

    // ---------------------------------------------------------------
    // version / state helpers
    // ---------------------------------------------------------------

    /// <summary>
    /// Parse a frontmatter version value into (major, minor). Tolerant by
    /// design so we can migrate Ship 68's free-text values:
    ///   "1.2"        -> (1, 2)
    ///   "v0.1"       -> (0, 1)   (a single leading v/V is stripped)
    ///   "1"          -> (1, 0)
    ///   "1.2.3-rc1"  -> (1, 2)   (first two numeric components)
    ///   "draft" / "" -> (0, 0)
    /// Negative or non-numeric components fall back to 0.
    /// </summary>
    public static (int Major, int Minor) ParseVersion(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return (0, 0);
        var s = value.Trim();
        if (s.Length > 0 && (s[0] == 'v' || s[0] == 'V')) s = s[1..];

        var parts = s.Split('.');
        var major = ParseLeadingInt(parts.Length > 0 ? parts[0] : null);
        var minor = parts.Length > 1 ? ParseLeadingInt(parts[1]) : 0;
        return (major, minor);
    }

    /// <summary>
    /// Resolve the on-disk / in-memory state to a valid value given the
    /// version. 0.0 is always not-versioned; above 0.0 a null/unknown state
    /// is development, and a "released" below 1.0 is clamped to development.
    /// </summary>
    public static string NormaliseState(int major, int minor, string? rawState)
    {
        if (major == 0 && minor == 0) return StateNotVersioned;

        var s = NormaliseStateString(rawState);
        if (s is null || string.Equals(s, StateNotVersioned, StringComparison.Ordinal))
        {
            return StateDevelopment;
        }
        if (string.Equals(s, StateReleased, StringComparison.Ordinal) && major < 1)
        {
            return StateDevelopment;
        }
        return s;
    }

    /// <summary>
    /// Map a free-form state string to one of the three canonical constants,
    /// or null if it isn't recognised. Case-insensitive; tolerates a couple
    /// of friendly spellings ("under development", "under-development").
    /// </summary>
    private static string? NormaliseStateString(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var s = raw.Trim().ToLowerInvariant().Replace(' ', '-');
        return s switch
        {
            "not-versioned" or "notversioned" or "none" or "unversioned" => StateNotVersioned,
            "development" or "under-development" or "dev" => StateDevelopment,
            "released" or "release" => StateReleased,
            _ => null,
        };
    }

    private static int Compare(int aMajor, int aMinor, int bMajor, int bMinor)
    {
        if (aMajor != bMajor) return aMajor.CompareTo(bMajor);
        return aMinor.CompareTo(bMinor);
    }

    private static int ParseLeadingInt(string? token)
    {
        if (string.IsNullOrEmpty(token)) return 0;
        var i = 0;
        while (i < token.Length && char.IsDigit(token[i])) i++;
        if (i == 0) return 0;
        return int.TryParse(token.AsSpan(0, i), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n)
            ? n
            : 0;
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
