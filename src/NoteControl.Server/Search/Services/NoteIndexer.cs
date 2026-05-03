using System.Text.Json;
using NoteControl.Server.Notes.Frontmatter;

namespace NoteControl.Server.Search.Services;

/// <summary>
/// Bridge that <see cref="NoteControl.Server.Notes.Services.NoteService"/>
/// uses to keep the per-vault search index in sync with note CRUD.
/// <para>
/// Why a separate interface and not just call <see cref="IIndexService"/>
/// directly? Two reasons:
/// </para>
/// <list type="number">
///   <item>NoteService already has the parsed body and frontmatter in
///     hand, so we don't want to round-trip through disk to re-read them.</item>
///   <item>Indexing failures must not break CRUD. The implementation
///     below catches and logs so a corrupt index doesn't make notes
///     un-saveable.</item>
/// </list>
/// </summary>
public interface INoteIndexer
{
    /// <summary>
    /// Push a fresh note version to the index. Safe to call concurrently;
    /// errors are swallowed (logged) so the caller's CRUD path is never
    /// failed by an indexing problem.
    /// </summary>
    Task OnNoteSavedAsync(
        Guid vaultId,
        string canonicalNotePath,
        ParsedFrontmatter frontmatter,
        string body,
        DateTimeOffset updated,
        CancellationToken ct = default);

    /// <summary>Mirror of <see cref="OnNoteSavedAsync"/> for deletes.</summary>
    Task OnNoteDeletedAsync(Guid vaultId, string canonicalNotePath, CancellationToken ct = default);
}

public sealed class NoteIndexer : INoteIndexer
{
    private readonly IIndexService _index;
    private readonly ILogger<NoteIndexer> _log;

    public NoteIndexer(IIndexService index, ILogger<NoteIndexer> log)
    {
        _index = index;
        _log = log;
    }

    public async Task OnNoteSavedAsync(
        Guid vaultId,
        string canonicalNotePath,
        ParsedFrontmatter frontmatter,
        string body,
        DateTimeOffset updated,
        CancellationToken ct = default)
    {
        try
        {
            var note = new IndexedNote(
                Path: canonicalNotePath,
                Title: DeriveTitle(frontmatter, body, canonicalNotePath),
                Created: frontmatter.Created,
                Updated: updated,
                BodyText: body,
                FrontmatterJson: SerializeExtra(frontmatter.Extra),
                Tags: frontmatter.Tags.AsReadOnly());

            await _index.UpsertAsync(vaultId, note, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Logged as a warning, not error: the canonical data is the
            // file on disk, which has been saved successfully. The index
            // is just a cache and can be rebuilt.
            _log.LogWarning(ex,
                "Failed to update search index for note {Path} in vault {VaultId}; " +
                "search results may be stale until next rebuild.",
                canonicalNotePath, vaultId);
        }
    }

    public async Task OnNoteDeletedAsync(Guid vaultId, string canonicalNotePath, CancellationToken ct = default)
    {
        try
        {
            await _index.DeleteAsync(vaultId, canonicalNotePath, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex,
                "Failed to remove deleted note {Path} from search index for vault {VaultId}.",
                canonicalNotePath, vaultId);
        }
    }

    /// <summary>
    /// Same precedence as <see cref="NoteFileReader"/>: explicit title
    /// from frontmatter > first H1 > filename. Duplicated here rather
    /// than shared because the regex match is cheap and the alternative
    /// is to expose a public helper purely for testability.
    /// </summary>
    private static string DeriveTitle(ParsedFrontmatter fm, string body, string canonicalRelative)
    {
        if (fm.Extra.TryGetValue("title", out var raw) && raw is string s && !string.IsNullOrWhiteSpace(s))
        {
            return s.Trim();
        }

        // Inline H1 scan — cheaper than re-running a regex on the full body.
        // Walk lines; first non-blank line that starts with "# " wins.
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

        return Path.GetFileNameWithoutExtension(canonicalRelative);
    }

    private static string? SerializeExtra(IReadOnlyDictionary<string, object?> extra)
    {
        if (extra.Count == 0) return null;
        try { return JsonSerializer.Serialize(extra); }
        catch { return null; }
    }
}
