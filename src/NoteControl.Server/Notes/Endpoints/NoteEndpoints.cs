using NoteControl.Server.Audit;
using NoteControl.Server.Auth;
using NoteControl.Server.Notes.Services;
using NoteControl.Server.Vaults;
using NoteControl.Server.Vaults.Services;
using NoteControl.Shared.Notes;

namespace NoteControl.Server.Notes.Endpoints;

/// <summary>
/// /api/vaults/{vaultId}/note and /folder.
///
/// All endpoints are gated by RequireVault(minRole). Read endpoints need
/// viewer; create/update need editor; delete needs editor (NOT owner —
/// editors should be able to manage notes in vaults they've been granted).
/// </summary>
public static class NoteEndpoints
{
    public static IEndpointRouteBuilder MapNoteEndpoints(this IEndpointRouteBuilder app)
    {
        // Folder listing — read access (viewer or above).
        app.MapGet("/api/vaults/{vaultId:guid}/folder", ListFolderAsync)
            .RequireVault(VaultService.RoleViewer);

        // Note CRUD. Read (viewer); create/update/delete (editor).
        app.MapGet("/api/vaults/{vaultId:guid}/note", GetNoteAsync)
            .RequireVault(VaultService.RoleViewer);
        app.MapPost("/api/vaults/{vaultId:guid}/note", CreateNoteAsync)
            .RequireVault(VaultService.RoleEditor);
        app.MapPut("/api/vaults/{vaultId:guid}/note", UpdateNoteAsync)
            .RequireVault(VaultService.RoleEditor);
        app.MapDelete("/api/vaults/{vaultId:guid}/note", DeleteNoteAsync)
            .RequireVault(VaultService.RoleEditor);

        // Note rename / move. Editor role.
        app.MapPut("/api/vaults/{vaultId:guid}/note/move", MoveNoteAsync)
            .RequireVault(VaultService.RoleEditor);

        return app;
    }

    private static async Task<IResult> ListFolderAsync(
        Guid vaultId,
        string? path,
        INoteService notes,
        CancellationToken ct)
    {
        try
        {
            var listing = await notes.ListFolderAsync(vaultId, path ?? string.Empty, ct);
            return Results.Ok(listing);
        }
        catch (NoteException ex)
        {
            return Results.Problem(statusCode: ex.StatusCode, title: ex.Message);
        }
    }

    private static async Task<IResult> GetNoteAsync(
        Guid vaultId,
        string path,
        INoteService notes,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return Results.Problem(statusCode: 400, title: "?path= is required.");
        }
        try
        {
            var note = await notes.GetAsync(vaultId, path, ct);
            return note is null ? Results.NotFound() : Results.Ok(note);
        }
        catch (NoteException ex)
        {
            return Results.Problem(statusCode: ex.StatusCode, title: ex.Message);
        }
    }

    private static async Task<IResult> CreateNoteAsync(
        Guid vaultId,
        CreateNoteRequest request,
        HttpContext http,
        INoteService notes,
        IAuditLog audit,
        CancellationToken ct)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.Path))
        {
            return Results.Problem(statusCode: 400, title: "Path is required.");
        }
        try
        {
            var note = await notes.CreateAsync(vaultId, request, ct);

            // Audit AFTER success. Step 19: structural note ops are
            // audited; per-keystroke updates are NOT (autosave noise
            // would balloon the audit table).
            var user = http.RequireUser();
            await audit.WriteAsync(
                AuditEventTypes.NoteCreated,
                user.Id,
                http.GetClientIp(),
                new { vaultId, path = note.Path },
                ct);

            // Locate by query-string, mirroring the GET shape.
            return Results.Created($"/api/vaults/{vaultId}/note?path={Uri.EscapeDataString(note.Path)}", note);
        }
        catch (NoteException ex)
        {
            return Results.Problem(statusCode: ex.StatusCode, title: ex.Message);
        }
    }

    private static async Task<IResult> UpdateNoteAsync(
        Guid vaultId,
        string path,
        UpdateNoteRequest request,
        INoteService notes,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return Results.Problem(statusCode: 400, title: "?path= is required.");
        }
        try
        {
            var note = await notes.UpdateAsync(vaultId, path, request, ct);
            return Results.Ok(note);
        }
        catch (NoteException ex)
        {
            return Results.Problem(statusCode: ex.StatusCode, title: ex.Message);
        }
    }

    private static async Task<IResult> DeleteNoteAsync(
        Guid vaultId,
        string path,
        HttpContext http,
        INoteService notes,
        IAuditLog audit,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return Results.Problem(statusCode: 400, title: "?path= is required.");
        }
        try
        {
            await notes.DeleteAsync(vaultId, path, ct);
            var user = http.RequireUser();
            await audit.WriteAsync(
                AuditEventTypes.NoteDeleted,
                user.Id,
                http.GetClientIp(),
                new { vaultId, path },
                ct);
            return Results.NoContent();
        }
        catch (NoteException ex)
        {
            return Results.Problem(statusCode: ex.StatusCode, title: ex.Message);
        }
    }

    private static async Task<IResult> MoveNoteAsync(
        Guid vaultId,
        MoveNoteRequest request,
        HttpContext http,
        INoteService notes,
        IAuditLog audit,
        CancellationToken ct)
    {
        if (request is null
            || string.IsNullOrWhiteSpace(request.OldPath)
            || string.IsNullOrWhiteSpace(request.NewPath))
        {
            return Results.Problem(
                statusCode: 400,
                title: "Both oldPath and newPath are required.");
        }

        try
        {
            var note = await notes.MoveAsync(vaultId, request.OldPath, request.NewPath, ct);
            var user = http.RequireUser();
            await audit.WriteAsync(
                AuditEventTypes.NoteMoved,
                user.Id,
                http.GetClientIp(),
                new { vaultId, oldPath = request.OldPath, newPath = request.NewPath },
                ct);
            return Results.Ok(note);
        }
        catch (InvalidNotePathException ex)
        {
            return Results.Problem(statusCode: 400, title: ex.Message);
        }
        catch (NoteException ex)
        {
            return Results.Problem(statusCode: ex.StatusCode, title: ex.Message);
        }
    }
}
