using NoteControl.Server.Search.Services;
using NoteControl.Server.Vaults;
using NoteControl.Shared.Notes;

namespace NoteControl.Server.Search.Endpoints;

/// <summary>
/// HTTP surface for the "recursive list of notes under a folder" view
/// the folder page uses. Lives next to <see cref="SearchEndpoints"/>
/// because it queries the same per-vault index DB; logically it's
/// a folder-listing concern, not a search one.
///
/// Why a separate endpoint instead of extending <c>/folder</c>?
/// The existing <c>/folder</c> returns only direct children plus a
/// small "recently updated" list. This new route is a different
/// shape — flat, recursive, sorted by mtime, paginated. Mixing the
/// two would force callers to opt into recursion via a query flag
/// and complicate the response DTO.
/// </summary>
public static class FolderRecursiveEndpoints
{
    public static void MapFolderRecursiveEndpoints(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/api/vaults/{vaultId:guid}");

        group.MapGet("/folder/recursive", ListRecursiveAsync)
            .WithName("ListFolderRecursive")
            .RequireVault("viewer");
    }

    /// <summary>
    /// <c>GET /api/vaults/{id}/folder/recursive?path=Sub/Folder&amp;limit=100</c>
    /// Returns every note under the given folder (recursively),
    /// sorted by most-recently-updated first.
    ///
    /// Path semantics: empty/missing <c>path</c> means whole vault.
    /// Limit defaults to 100; max 200.
    ///
    /// Each row carries <c>VersionMajor</c> / <c>VersionMinor</c> /
    /// <c>State</c> so the frontend can group rows by lifecycle state
    /// (released → development → not-versioned). The values are sniffed
    /// from each file's frontmatter prefix — same per-note cost the
    /// non-recursive folder listing already pays.
    /// </summary>
    private static async Task<IResult> ListRecursiveAsync(
        Guid vaultId,
        string? path,
        int? limit,
        IIndexService index,
        CancellationToken ct)
    {
        try
        {
            var folderPath = NormalizeFolder(path);
            var notes = await index.ListNotesWithVersionAsync(
                vaultId, folderPath, limit ?? 100, ct);

            // Project to NoteSummaryDto so the frontend can reuse the
            // same TypeScript type it uses for /folder responses.
            // Name = title from the index (H1 / frontmatter / filename).
            var summaries = notes
                .Select(n => new NoteSummaryDto(
                    Path: n.Path,
                    Name: TitleAsDisplayName(n.Title, n.Path),
                    LastModified: n.Updated,
                    // Size isn't tracked in the index. The folder page
                    // doesn't display it for the recursive list, so 0
                    // is acceptable; if a future caller needs accurate
                    // sizes we'd need either to add a `size` column to
                    // the index or stat each file (defeats the purpose).
                    SizeBytes: 0,
                    VersionMajor: n.VersionMajor,
                    VersionMinor: n.VersionMinor,
                    State: n.State))
                .ToList();

            return Results.Ok(summaries);
        }
        catch (IndexException ex)
        {
            return Results.Problem(
                title: "Could not list folder",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    /// <summary>
    /// Convert an indexed title into the display name we want to show
    /// in lists. Falls back to the filename (no extension) so we never
    /// render an empty string even if a note has no H1 / frontmatter
    /// title.
    /// </summary>
    private static string TitleAsDisplayName(string? indexTitle, string path)
    {
        if (!string.IsNullOrWhiteSpace(indexTitle))
        {
            return indexTitle;
        }

        var lastSlash = path.LastIndexOf('/');
        var fileName = lastSlash >= 0 ? path[(lastSlash + 1)..] : path;
        if (fileName.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
        {
            fileName = fileName[..^3];
        }
        return fileName;
    }

    private static string NormalizeFolder(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return "";
        return path.Trim().Replace('\\', '/').Trim('/');
    }
}
