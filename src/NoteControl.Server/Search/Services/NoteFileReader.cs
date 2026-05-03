using System.Text.Json;
using System.Text.RegularExpressions;
using NoteControl.Server.Notes.Frontmatter;

namespace NoteControl.Server.Search.Services;

/// <summary>
/// Reads a single <c>.md</c> file from disk and produces an
/// <see cref="IndexedNote"/> for the indexer. Used by
/// <see cref="IndexService.RebuildAsync"/>; not used on the live update
/// path (where <see cref="INoteIndexer"/> already has the parsed body
/// in hand).
/// </summary>
internal static class NoteFileReader
{
    /// <summary>
    /// Pulls a level-1 heading out of the body. Matches both
    /// "# Title" and the rare "Title\n=====" form. Returns null if no
    /// heading is found, in which case <see cref="DeriveTitle"/> falls
    /// back to the filename.
    /// </summary>
    private static readonly Regex H1Atx = new(@"^\s*#\s+(.+?)\s*$", RegexOptions.Compiled | RegexOptions.Multiline);
    private static readonly Regex H1Setext = new(@"^(.+?)\r?\n=+\s*$", RegexOptions.Compiled | RegexOptions.Multiline);

    public static IndexedNote Read(string fullPath, string canonicalRelative)
    {
        // ReadAllText handles BOM stripping for us.
        var text = File.ReadAllText(fullPath);

        var (fm, body) = FrontmatterCodec.Split(text);

        var title = DeriveTitle(fm, body, canonicalRelative);
        var updated = new DateTimeOffset(File.GetLastWriteTimeUtc(fullPath), TimeSpan.Zero);
        var fmJson = SerializeExtra(fm.Extra);

        return new IndexedNote(
            Path: canonicalRelative,
            Title: title,
            Created: fm.Created,
            Updated: updated,
            BodyText: body,
            FrontmatterJson: fmJson,
            Tags: fm.Tags.AsReadOnly());
    }

    /// <summary>
    /// Title precedence: explicit "title" frontmatter field > first H1 in
    /// body > filename without extension. Filename is the last-resort
    /// fallback so search results always have *something* to display.
    /// </summary>
    private static string DeriveTitle(ParsedFrontmatter fm, string body, string canonicalRelative)
    {
        // 1. Frontmatter "title" — stored under Extra since it's not one of
        //    the well-known typed fields on ParsedFrontmatter.
        if (fm.Extra.TryGetValue("title", out var raw) && raw is string s && !string.IsNullOrWhiteSpace(s))
        {
            return s.Trim();
        }

        // 2. First H1 in body. ATX form (# ...) is by far the common case.
        var atx = H1Atx.Match(body);
        if (atx.Success)
        {
            return atx.Groups[1].Value.Trim();
        }
        var setext = H1Setext.Match(body);
        if (setext.Success)
        {
            return setext.Groups[1].Value.Trim();
        }

        // 3. Filename without extension.
        return System.IO.Path.GetFileNameWithoutExtension(canonicalRelative);
    }

    /// <summary>
    /// Serialise the unknown-fields map to JSON so it round-trips through
    /// SQLite's TEXT column. Today this is stored but not searched; future
    /// steps may add filters over typed frontmatter fields.
    /// </summary>
    private static string? SerializeExtra(IReadOnlyDictionary<string, object?> extra)
    {
        if (extra.Count == 0)
        {
            return null;
        }

        try
        {
            return JsonSerializer.Serialize(extra);
        }
        catch
        {
            // YamlDotNet may produce nested object?-typed graphs that
            // System.Text.Json refuses; in that rare case we drop the
            // frontmatter from the index rather than fail the whole file.
            return null;
        }
    }
}
