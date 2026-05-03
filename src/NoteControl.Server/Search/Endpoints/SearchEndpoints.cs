using NoteControl.Server.Search.Services;
using NoteControl.Server.Vaults;
using NoteControl.Shared.Search;

namespace NoteControl.Server.Search.Endpoints;

/// <summary>
/// HTTP surface for the search index.
/// <para>
/// Three routes, all under <c>/api/vaults/{vaultId}</c>:
/// </para>
/// <list type="bullet">
///   <item><c>GET  /search</c>          — query the index (viewer role).</item>
///   <item><c>GET  /index/status</c>    — current index state (viewer role).</item>
///   <item><c>POST /index/rebuild</c>   — full rebuild from disk (owner role).</item>
/// </list>
/// </summary>
public static class SearchEndpoints
{
    public static void MapSearchEndpoints(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/api/vaults/{vaultId:guid}");

        group.MapGet("/search", SearchAsync)
            .WithName("SearchVault")
            .RequireVault("viewer");

        group.MapGet("/index/status", GetIndexStatusAsync)
            .WithName("GetIndexStatus")
            .RequireVault("viewer");

        group.MapPost("/index/rebuild", RebuildIndexAsync)
            .WithName("RebuildIndex")
            .RequireVault("owner");
    }

    /// <summary>
    /// <c>GET /api/vaults/{id}/search?q=foo&amp;tag=todo&amp;path=Projects&amp;limit=50</c>.
    /// At least one of <c>q</c> or <c>tag</c> is required (the underlying
    /// service enforces this and surfaces a 400 with detail).
    /// </summary>
    private static async Task<IResult> SearchAsync(
        Guid vaultId,
        string? q,
        string? tag,
        string? path,
        int? limit,
        IIndexService index,
        CancellationToken ct)
    {
        try
        {
            var folderPath = NormalizeFolder(path);
            var result = await index.SearchAsync(vaultId, q, tag, folderPath, limit ?? 50, ct);
            return Results.Ok(result);
        }
        catch (IndexException ex)
        {
            return Results.Problem(
                title: "Search failed",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    private static async Task<IResult> GetIndexStatusAsync(
        Guid vaultId,
        IIndexService index,
        CancellationToken ct)
    {
        try
        {
            var status = await index.GetStatusAsync(vaultId, ct);
            return Results.Ok(status);
        }
        catch (IndexException ex)
        {
            return Results.Problem(
                title: "Could not read index status",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    private static async Task<IResult> RebuildIndexAsync(
        Guid vaultId,
        IIndexService index,
        CancellationToken ct)
    {
        try
        {
            var count = await index.RebuildAsync(vaultId, ct);
            // Echo back the new status so the UI doesn't need a follow-up GET.
            var status = await index.GetStatusAsync(vaultId, ct);
            return Results.Ok(new RebuildResponse(count, status));
        }
        catch (IndexException ex)
        {
            return Results.Problem(
                title: "Rebuild failed",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    /// <summary>
    /// Convert the optional <c>?path=</c> query parameter to the canonical
    /// form the index uses internally. Empty / null means "whole vault".
    /// We deliberately don't run the full <c>NotePathResolver</c> here
    /// because we want lenient matching (callers may pass folders with
    /// trailing slashes, leading slashes, etc.) and the worst case is an
    /// empty result set.
    /// </summary>
    private static string NormalizeFolder(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return "";
        return path.Trim().Replace('\\', '/').Trim('/');
    }

    private sealed record RebuildResponse(int IndexedNotes, IndexStatusDto Status);
}
