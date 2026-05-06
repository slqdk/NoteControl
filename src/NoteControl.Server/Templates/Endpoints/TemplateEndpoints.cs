using NoteControl.Server.Templates.Services;
using NoteControl.Server.Vaults;
using NoteControl.Shared.Templates;

namespace NoteControl.Server.Templates.Endpoints;

/// <summary>
/// HTTP surface for templates.
///
/// Routes (under <c>/api/vaults/{vaultId}</c>):
///   <c>GET    /templates</c>                — list summary + lastModified
///   <c>GET    /templates/{name}</c>         — full body
///   <c>POST   /templates</c>                — create new (409 on collision)
///   <c>POST   /templates/from-selection</c> — Ship 98b: create from
///                                              an in-note selection,
///                                              auto-named, with image
///                                              copy + path rewrite
///   <c>POST   /templates/{name}/render</c>  — Ship 98c: render the
///                                              template for insertion
///                                              into a target note.
///                                              Copies images into the
///                                              target's asset folder,
///                                              returns rewritten body
///   <c>PUT    /templates/{name}</c>         — update body, optionally rename
///   <c>DELETE /templates/{name}</c>         — remove
///
/// Auth: viewers can list and read, editors can write/delete.
/// The render route is editor-only because it WRITES to the target
/// note's asset folder, even though it doesn't change the template
/// itself.
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

        // Ship 98b: dedicated route for "save selection as template".
        // Order matters — must be registered before "/templates/{name}"
        // would match the path? Actually no: minimal API route matching
        // on literal segments beats parameter segments, so
        // "/templates/from-selection" wins over "/templates/{name}"
        // automatically. Listing it after the other POST is fine.
        group.MapPost("/templates/from-selection", CreateFromSelectionAsync)
            .WithName("CreateTemplateFromSelection")
            .RequireVault("editor");

        // Ship 98c: render a template for insertion into a target
        // note. POST (not GET) because the call has side effects —
        // it writes copies of any images into the target note's
        // asset folder.
        group.MapPost("/templates/{name}/render", RenderForInsertAsync)
            .WithName("RenderTemplateForInsert")
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

    private static async Task<IResult> CreateFromSelectionAsync(
        Guid vaultId,
        TemplateFromSelectionRequest request,
        ITemplateService templates,
        CancellationToken ct)
    {
        if (request is null)
        {
            return Results.Problem(statusCode: 400, title: "Body required.");
        }
        try
        {
            var dto = await templates.CreateFromSelectionAsync(vaultId, request, ct);
            return Results.Created($"/api/vaults/{vaultId}/templates/{dto.Name}", dto);
        }
        catch (TemplateException ex)
        {
            return Results.Problem(
                title: "Could not create template from selection",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    /// <summary>
    /// Ship 98c: render a template's body for insertion into a
    /// specific target note.
    ///
    /// <c>targetNotePath</c> is a query string parameter rather than
    /// a request body so the URL alone fully describes the operation
    /// — easier to debug from access logs and curl.
    /// </summary>
    private static async Task<IResult> RenderForInsertAsync(
        Guid vaultId,
        string name,
        string? targetNotePath,
        ITemplateService templates,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(targetNotePath))
        {
            return Results.Problem(
                statusCode: 400,
                title: "?targetNotePath= is required.");
        }
        try
        {
            var resp = await templates.RenderForInsertAsync(
                vaultId, name, targetNotePath, ct);
            return Results.Ok(resp);
        }
        catch (TemplateException ex)
        {
            return Results.Problem(
                title: "Could not render template for insert",
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
