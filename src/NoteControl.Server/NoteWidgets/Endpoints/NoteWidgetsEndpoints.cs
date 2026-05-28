using System.Text.Json;
using Microsoft.Extensions.Logging;
using NoteControl.Server.NoteWidgets.Services;
using NoteControl.Server.Vaults;
using NoteControl.Shared.NoteWidgets;

namespace NoteControl.Server.NoteWidgets.Endpoints;

/// <summary>
/// HTTP surface for per-note widgets.
///
/// Routes (all under <c>/api/vaults/{vaultId}/note-widgets</c>):
///   <c>GET</c>  — read the whole per-vault map (note path → widgets)
///   <c>PUT</c>  — replace the whole per-vault map
///
/// Granularity note: the whole-map GET/PUT mirrors how the startpage
/// and assignments persist (one file, replaced wholesale). The editor
/// loads the map once when a note opens and saves the whole map back
/// on a debounce — same shape the dashboard uses for its blocks. A
/// per-note sub-route would be tidier but would fragment the single
/// sidecar file into a read-modify-write race across notes open in
/// two tabs; the single-user assumption makes whole-file simpler and
/// safe enough.
///
/// Auth: viewers can read (they need to see a note's widgets); editors
/// can save. Same role split as the startpage / assignments endpoints.
/// </summary>
public static class NoteWidgetsEndpoints
{
    public static IEndpointRouteBuilder MapNoteWidgetsEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/vaults/{vaultId:guid}/note-widgets");

        group.MapGet("", GetAsync)
            .WithName("GetNoteWidgets")
            .RequireVault("viewer");

        group.MapPut("", SaveAsync)
            .WithName("SaveNoteWidgets")
            .RequireVault("editor");

        return app;
    }

    private static async Task<IResult> GetAsync(
        Guid vaultId,
        INoteWidgetsConfigService configs,
        CancellationToken ct)
    {
        try
        {
            var dto = await configs.GetAsync(vaultId, ct);
            return Results.Ok(dto);
        }
        catch (NoteWidgetsException ex)
        {
            return Results.Problem(
                title: "Could not load note widgets",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    /// <summary>
    /// PUT /note-widgets: replace the saved map for a vault.
    ///
    /// Manual body read + deserialize, same as
    /// AssignmentsEndpoints.SaveAsync — when the client sends a
    /// malformed payload, default minimal-API binding 400s before the
    /// handler runs and we lose the raw body for the log. Manual
    /// binding preserves it so a misbehaving client is debuggable
    /// without bisecting wire traffic.
    /// </summary>
    private static async Task<IResult> SaveAsync(
        Guid vaultId,
        HttpContext http,
        INoteWidgetsConfigService configs,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var log = loggerFactory.CreateLogger("NoteWidgetsSave");

        string raw;
        using (var reader = new StreamReader(http.Request.Body))
        {
            raw = await reader.ReadToEndAsync(ct);
        }

        NoteWidgetsConfigDto? config;
        try
        {
            var jsonOpts = new JsonSerializerOptions(JsonSerializerDefaults.Web);
            config = JsonSerializer.Deserialize<NoteWidgetsConfigDto>(raw, jsonOpts);
        }
        catch (JsonException ex)
        {
            log.LogError(ex,
                "JsonException deserializing PUT /note-widgets body for vault {VaultId}. Body was: {Body}",
                vaultId, raw);
            return Results.Problem(
                statusCode: 400,
                title: "Could not parse note-widgets body.",
                detail: ex.Message);
        }
        catch (NotSupportedException ex)
        {
            log.LogError(ex,
                "NotSupportedException deserializing PUT /note-widgets for vault {VaultId}. Body was: {Body}",
                vaultId, raw);
            return Results.Problem(
                statusCode: 400,
                title: "Unsupported type while deserializing.",
                detail: ex.Message);
        }
        catch (Exception ex)
        {
            log.LogError(ex,
                "Unexpected exception deserializing PUT /note-widgets for vault {VaultId}. Body was: {Body}",
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
            log.LogDebug(
                "Save succeeded for vault {VaultId} (notes={Count})",
                vaultId, config.ByNote?.Count ?? 0);
            return Results.NoContent();
        }
        catch (NoteWidgetsException ex)
        {
            log.LogError(ex,
                "NoteWidgetsException during save for vault {VaultId}",
                vaultId);
            return Results.Problem(
                title: "Could not save note widgets",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }
}
