using NoteControl.Server.Templates.Services;
using NoteControl.Server.Vaults;
using NoteControl.Shared.Templates;

namespace NoteControl.Server.Templates.Endpoints;

/// <summary>
/// HTTP surface for templates.
///
/// Routes (under <c>/api/vaults/{vaultId}</c>):
///   <c>GET    /templates</c>        — list summary + lastModified
///   <c>GET    /templates/{name}</c> — full body
///   <c>POST   /templates</c>        — create new (409 on collision)
///   <c>PUT    /templates/{name}</c> — update body, optionally rename
///   <c>DELETE /templates/{name}</c> — remove
///
/// Auth: viewers can list and read, editors can write/delete.
/// </summary>
public static class TemplateEndpoints
{
    public static IEndpointRouteBuilder MapTemplateEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/vaults/{vaultId:guid}");

        group.MapGet("/templates", ListAsync)
            .WithName("ListTemplates")
            .RequireVault("viewer");

        group.MapGet("/templates/{name}", GetAsync)
            .WithName("GetTemplate")
            .RequireVault("viewer");

        group.MapPost("/templates", CreateAsync)
            .WithName("CreateTemplate")
            .RequireVault("editor");

        group.MapPut("/templates/{name}", UpdateAsync)
            .WithName("UpdateTemplate")
            .RequireVault("editor");

        group.MapDelete("/templates/{name}", DeleteAsync)
            .WithName("DeleteTemplate")
            .RequireVault("editor");

        return app;
    }

    private static async Task<IResult> ListAsync(
        Guid vaultId,
        ITemplateService templates,
        CancellationToken ct)
    {
        try
        {
            var list = await templates.ListAsync(vaultId, ct);
            return Results.Ok(list);
        }
        catch (TemplateException ex)
        {
            return Results.Problem(
                title: "Could not list templates",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    private static async Task<IResult> GetAsync(
        Guid vaultId,
        string name,
        ITemplateService templates,
        CancellationToken ct)
    {
        try
        {
            var dto = await templates.GetAsync(vaultId, name, ct);
            return dto is null ? Results.NotFound() : Results.Ok(dto);
        }
        catch (TemplateException ex)
        {
            return Results.Problem(
                title: "Could not load template",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    private static async Task<IResult> CreateAsync(
        Guid vaultId,
        TemplateUpsertRequest request,
        ITemplateService templates,
        CancellationToken ct)
    {
        if (request is null)
        {
            return Results.Problem(statusCode: 400, title: "Body required.");
        }
        try
        {
            var dto = await templates.CreateAsync(vaultId, request, ct);
            return Results.Created($"/api/vaults/{vaultId}/templates/{dto.Name}", dto);
        }
        catch (TemplateException ex)
        {
            return Results.Problem(
                title: "Could not create template",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    private static async Task<IResult> UpdateAsync(
        Guid vaultId,
        string name,
        TemplateUpsertRequest request,
        ITemplateService templates,
        CancellationToken ct)
    {
        if (request is null)
        {
            return Results.Problem(statusCode: 400, title: "Body required.");
        }
        try
        {
            var dto = await templates.UpdateAsync(vaultId, name, request, ct);
            return Results.Ok(dto);
        }
        catch (TemplateException ex)
        {
            return Results.Problem(
                title: "Could not update template",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    private static async Task<IResult> DeleteAsync(
        Guid vaultId,
        string name,
        ITemplateService templates,
        CancellationToken ct)
    {
        try
        {
            await templates.DeleteAsync(vaultId, name, ct);
            return Results.NoContent();
        }
        catch (TemplateException ex)
        {
            return Results.Problem(
                title: "Could not delete template",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }
}
