using System.Text.Json;
using Microsoft.Extensions.Logging;
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

    /// <summary>
    /// Ship 77: instrumented version. Reads the body as a raw stream,
    /// logs it to the server log, then deserializes manually with a
    /// try/catch so any binding exception ends up in the log too.
    /// Pre-Ship-77 the framework's automatic body-binding was failing
    /// with a 400 + empty body and there was no logged exception
    /// because the failure was happening before our endpoint code ran.
    ///
    /// Once we identify the cause from the streaming log, this can
    /// be reverted to the simpler `StartpageConfigDto config` body
    /// parameter — the manual binding has the same end result, just
    /// noisier on the wire.
    /// </summary>
    private static async Task<IResult> SaveConfigAsync(
        Guid vaultId,
        HttpContext http,
        IStartpageConfigService configs,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var log = loggerFactory.CreateLogger("StartpageSaveDiag");

        // Read the body manually so we can log it. The default minimal-API
        // body binding turns failures into 400+empty-body responses BEFORE
        // our handler runs, so we never see why.
        string raw;
        using (var reader = new StreamReader(http.Request.Body))
        {
            raw = await reader.ReadToEndAsync(ct);
        }
        log.LogInformation(
            "[Ship77 diag] Received PUT /startpage/config body ({Bytes} bytes) for vault {VaultId}: {Body}",
            raw.Length,
            vaultId,
            raw);

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
                "[Ship77 diag] JsonException deserializing PUT /startpage/config body for vault {VaultId}. Body was: {Body}",
                vaultId, raw);
            return Results.Problem(
                statusCode: 400,
                title: "Could not parse startpage config body.",
                detail: ex.Message);
        }
        catch (NotSupportedException ex)
        {
            log.LogError(ex,
                "[Ship77 diag] NotSupportedException deserializing PUT /startpage/config for vault {VaultId}. Body was: {Body}",
                vaultId, raw);
            return Results.Problem(
                statusCode: 400,
                title: "Unsupported type while deserializing.",
                detail: ex.Message);
        }
        catch (Exception ex)
        {
            log.LogError(ex,
                "[Ship77 diag] Unexpected exception deserializing PUT /startpage/config for vault {VaultId}. Body was: {Body}",
                vaultId, raw);
            return Results.Problem(
                statusCode: 500,
                title: "Unexpected error while deserializing.",
                detail: ex.Message);
        }

        if (config is null)
        {
            log.LogWarning(
                "[Ship77 diag] Body deserialized to null for vault {VaultId}. Raw body: {Body}",
                vaultId, raw);
            return Results.Problem(statusCode: 400, title: "Body required.");
        }
        try
        {
            await configs.SaveAsync(vaultId, config, ct);
            log.LogInformation(
                "[Ship77 diag] Save succeeded for vault {VaultId} (blocks={Blocks}, taskAreas={TaskAreas}, links={Links})",
                vaultId, config.Blocks?.Count, config.TaskAreas?.Count, config.Links?.Count);
            return Results.NoContent();
        }
        catch (StartpageException ex)
        {
            log.LogError(ex,
                "[Ship77 diag] StartpageException during save for vault {VaultId}",
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
