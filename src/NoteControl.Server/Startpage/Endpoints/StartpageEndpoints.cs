using System.Text.Json;
using Microsoft.Extensions.Logging;
using NoteControl.Server.Startpage.Services;
using NoteControl.Server.Vaults;
using NoteControl.Shared.Startpage;

namespace NoteControl.Server.Startpage.Endpoints;

/// <summary>
/// HTTP surface for the per-vault startpage / dashboards.
///
/// Routes (all under <c>/api/vaults/{vaultId}/startpage</c>):
///   <c>GET  /config</c>                — read the saved layout
///                                        (multi-dashboard shape)
///   <c>PUT  /config</c>                — write the saved layout
///   <c>GET  /feed?url={encoded}</c>    — fetch + parse one feed
///
/// The endpoint group name "startpage" is preserved because the
/// route shape is the contract for the on-disk
/// <c>{vault}/.notesapp/startpage.json</c> file too — renaming
/// the endpoints would imply renaming the file, which would
/// break legacy-reader compat for nothing. The DTO shape it
/// returns is multi-dashboard now (see StartpageConfigDto).
///
/// Auth: viewers can read config and fetch feeds (they need to
/// see the dashboards); editors can save layout changes. The feed
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

    /// <summary>
    /// PUT /startpage/config: replace the saved config for a vault.
    ///
    /// Reads the body manually so JSON deserialisation errors land
    /// in our handler with full context. The default minimal-API
    /// body binding turns failures into 400 + empty body BEFORE the
    /// handler runs, so we never see why. Manual binding preserves
    /// the exception detail for the response (useful for the user's
    /// in-app error banner) and for the log.
    ///
    /// Ship 77 introduced this path with very loud Information-level
    /// logging on every save (the body, the byte count). Ship 90
    /// identified the bug as fractional pixel values failing
    /// `int Width` deserialisation (fixed client-side), and toned
    /// the success-path logs down to Debug. Errors stay at Error
    /// level — those are still rare and worth seeing.
    /// </summary>
    private static async Task<IResult> SaveConfigAsync(
        Guid vaultId,
        HttpContext http,
        IStartpageConfigService configs,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var log = loggerFactory.CreateLogger("StartpageSave");

        // Read the body manually so we can include it in any error
        // log/response. See class comment for why automatic binding
        // would lose this context.
        string raw;
        using (var reader = new StreamReader(http.Request.Body))
        {
            raw = await reader.ReadToEndAsync(ct);
        }

        StartpageConfigDto? config;
        try
        {
            // Match the casing/policy ASP.NET Core minimal APIs use
            // by default (Web defaults — camelCase, case-insensitive).
            var jsonOpts = new JsonSerializerOptions(JsonSerializerDefaults.Web);
            config = JsonSerializer.Deserialize<StartpageConfigDto>(raw, jsonOpts);
        }
        catch (JsonException ex)
        {
            log.LogError(ex,
                "JsonException deserializing PUT /startpage/config body for vault {VaultId}. Body was: {Body}",
                vaultId, raw);
            return Results.Problem(
                statusCode: 400,
                title: "Could not parse startpage config body.",
                detail: ex.Message);
        }
        catch (NotSupportedException ex)
        {
            log.LogError(ex,
                "NotSupportedException deserializing PUT /startpage/config for vault {VaultId}. Body was: {Body}",
                vaultId, raw);
            return Results.Problem(
                statusCode: 400,
                title: "Unsupported type while deserializing.",
                detail: ex.Message);
        }
        catch (Exception ex)
        {
            log.LogError(ex,
                "Unexpected exception deserializing PUT /startpage/config for vault {VaultId}. Body was: {Body}",
                vaultId, raw);
            return Results.Problem(
                statusCode: 500,
                title: "Unexpected error while deserializing.",
                detail: ex.Message);
        }

        if (config is null)
        {
            log.LogWarning(
                "Body deserialized to null for vault {VaultId}. Raw body: {Body}",
                vaultId, raw);
            return Results.Problem(statusCode: 400, title: "Body required.");
        }
        try
        {
            await configs.SaveAsync(vaultId, config, ct);
            // Debug-level: the user is debounce-saving every ~500ms while
            // dragging blocks, so this fires often. Information would
            // drown the log in routine activity.
            log.LogDebug(
                "Save succeeded for vault {VaultId} (dashboards={Dashboards})",
                vaultId, config.Dashboards?.Count);
            return Results.NoContent();
        }
        catch (StartpageException ex)
        {
            log.LogError(ex,
                "StartpageException during save for vault {VaultId}",
                vaultId);
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
