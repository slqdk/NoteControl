using NoteControl.Server.Startpage.Services;
using NoteControl.Server.Vaults;
using NoteControl.Shared.Startpage;

namespace NoteControl.Server.Startpage.Endpoints;

/// <summary>
/// HTTP surface for the per-vault startpage.
///
/// Routes (all under <c>/api/vaults/{vaultId}/startpage</c>):
///   <c>GET  /config</c>                — read the saved layout
///   <c>PUT  /config</c>                — write the saved layout
///   <c>GET  /feed?url={encoded}</c>    — fetch + parse one feed
///
/// Auth: viewers can read config and fetch feeds (they need to
/// see the page); editors can save layout changes. The feed
/// fetch is gated as viewer because read-only users still see
/// the same feeds; we want them to render, not 403.
///
/// The feed proxy could be abused as a generic HTTP fetcher by
/// any logged-in viewer. Mitigations: SSRF guard inside
/// FeedFetcher (blocks loopback/private IPs), strict HTTP-only
/// scheme allowlist, response size cap, fetch timeout.
/// </summary>
public static class StartpageEndpoints
{
    public static IEndpointRouteBuilder MapStartpageEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/vaults/{vaultId:guid}/startpage");

        group.MapGet("/config", GetConfigAsync)
            .WithName("GetStartpageConfig")
            .RequireVault("viewer");

        group.MapPut("/config", SaveConfigAsync)
            .WithName("SaveStartpageConfig")
            .RequireVault("editor");

        group.MapGet("/feed", FetchFeedAsync)
            .WithName("FetchStartpageFeed")
            .RequireVault("viewer");

        return app;
    }

    private static async Task<IResult> GetConfigAsync(
        Guid vaultId,
        IStartpageConfigService configs,
        CancellationToken ct)
    {
        try
        {
            var dto = await configs.GetAsync(vaultId, ct);
            return Results.Ok(dto);
        }
        catch (StartpageException ex)
        {
            return Results.Problem(
                title: "Could not load startpage config",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    private static async Task<IResult> SaveConfigAsync(
        Guid vaultId,
        StartpageConfigDto config,
        IStartpageConfigService configs,
        CancellationToken ct)
    {
        if (config is null)
        {
            return Results.Problem(statusCode: 400, title: "Body required.");
        }
        try
        {
            await configs.SaveAsync(vaultId, config, ct);
            return Results.NoContent();
        }
        catch (StartpageException ex)
        {
            return Results.Problem(
                title: "Could not save startpage config",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    /// <summary>
    /// GET /feed?url={encoded}. The URL is in the query string so
    /// it's easy to call from the client (no body for GET) and so
    /// the feed lives outside the route, which would otherwise
    /// have to handle escaped slashes etc.
    /// </summary>
    private static async Task<IResult> FetchFeedAsync(
        Guid vaultId,
        string? url,
        IFeedFetcher fetcher,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return Results.Problem(
                statusCode: 400,
                title: "Missing 'url' query parameter.");
        }
        try
        {
            var feed = await fetcher.FetchAsync(url, ct);
            return Results.Ok(feed);
        }
        catch (StartpageException ex)
        {
            return Results.Problem(
                title: "Could not load feed",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }
}
