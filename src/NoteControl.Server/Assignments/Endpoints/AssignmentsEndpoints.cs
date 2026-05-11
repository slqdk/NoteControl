using System.Text.Json;
using Microsoft.Extensions.Logging;
using NoteControl.Server.Assignments.Services;
using NoteControl.Server.Vaults;
using NoteControl.Shared.Assignments;

namespace NoteControl.Server.Assignments.Endpoints;

/// <summary>
/// HTTP surface for the per-vault Assignments page.
///
/// Routes (all under <c>/api/vaults/{vaultId}/assignments</c>):
///   <c>GET</c>  — read the saved list
///   <c>PUT</c>  — write the saved list
///
/// Auth: viewers can read (they need to see the page); editors
/// can save. Same role split the startpage endpoints use.
///
/// Why not a /config sub-route like the startpage has? The startpage
/// group also owns /feed (the RSS proxy), so /config disambiguates.
/// Assignments has nothing else under it, so the bare route is fine
/// — and short URLs are easier to grep in logs.
/// </summary>
public static class AssignmentsEndpoints
{
    public static IEndpointRouteBuilder MapAssignmentsEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/vaults/{vaultId:guid}/assignments");

        group.MapGet("", GetAsync)
            .WithName("GetAssignments")
            .RequireVault("viewer");

        group.MapPut("", SaveAsync)
            .WithName("SaveAssignments")
            .RequireVault("editor");

        return app;
    }

    private static async Task<IResult> GetAsync(
        Guid vaultId,
        IAssignmentsConfigService configs,
        CancellationToken ct)
    {
        try
        {
            var dto = await configs.GetAsync(vaultId, ct);
            return Results.Ok(dto);
        }
        catch (AssignmentsException ex)
        {
            return Results.Problem(
                title: "Could not load assignments",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    /// <summary>
    /// PUT /assignments: replace the saved list for a vault.
    ///
    /// Manual body read + deserialize, same as StartpageEndpoints.SaveConfigAsync.
    /// Reason for not using minimal-API body binding: when the
    /// client sends a malformed payload (e.g. an int where the DTO
    /// expects a string), the default binding 400s before the
    /// handler runs and we lose the raw body for the log. Manual
    /// binding preserves that context so we can debug a misbehaving
    /// client without bisecting wire traffic.
    /// </summary>
    private static async Task<IResult> SaveAsync(
        Guid vaultId,
        HttpContext http,
        IAssignmentsConfigService configs,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var log = loggerFactory.CreateLogger("AssignmentsSave");

        string raw;
        using (var reader = new StreamReader(http.Request.Body))
        {
            raw = await reader.ReadToEndAsync(ct);
        }

        AssignmentsConfigDto? config;
        try
        {
            var jsonOpts = new JsonSerializerOptions(JsonSerializerDefaults.Web);
            config = JsonSerializer.Deserialize<AssignmentsConfigDto>(raw, jsonOpts);
        }
        catch (JsonException ex)
        {
            log.LogError(ex,
                "JsonException deserializing PUT /assignments body for vault {VaultId}. Body was: {Body}",
                vaultId, raw);
            return Results.Problem(
                statusCode: 400,
                title: "Could not parse assignments body.",
                detail: ex.Message);
        }
        catch (NotSupportedException ex)
        {
            log.LogError(ex,
                "NotSupportedException deserializing PUT /assignments for vault {VaultId}. Body was: {Body}",
                vaultId, raw);
            return Results.Problem(
                statusCode: 400,
                title: "Unsupported type while deserializing.",
                detail: ex.Message);
        }
        catch (Exception ex)
        {
            log.LogError(ex,
                "Unexpected exception deserializing PUT /assignments for vault {VaultId}. Body was: {Body}",
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
            // Debug-level for the success case — the client
            // debounces saves while the user edits, so this fires
            // often. Errors stay at Error so they surface in the
            // log even with the default minimum level.
            log.LogDebug(
                "Save succeeded for vault {VaultId} (count={Count})",
                vaultId, config.Assignments?.Count ?? 0);
            return Results.NoContent();
        }
        catch (AssignmentsException ex)
        {
            log.LogError(ex,
                "AssignmentsException during save for vault {VaultId}",
                vaultId);
            return Results.Problem(
                title: "Could not save assignments",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }
}
