using NoteControl.Server.Folders.Services;
using NoteControl.Server.Notes.Services;
using NoteControl.Server.Vaults;
using NoteControl.Shared.Folders;

namespace NoteControl.Server.Folders.Endpoints;

/// <summary>
/// HTTP surface for explicit folder management.
///
/// Routes (all under <c>/api/vaults/{vaultId}</c>):
///   <c>POST   /folder</c>             — create empty folder (editor role)
///   <c>DELETE /folder?path=...</c>    — delete empty folder (editor role)
///
/// Why editor (not owner)? Creating/deleting an empty folder is no
/// more destructive than creating/deleting a note, and the existing
/// note endpoints accept editor. Owner is reserved for vault-level
/// operations (rename vault, share vault).
/// </summary>
public static class FolderEndpoints
{
    public static void MapFolderEndpoints(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/api/vaults/{vaultId:guid}");

        group.MapPost("/folder", CreateAsync)
            .WithName("CreateFolder")
            .RequireVault("editor");

        group.MapDelete("/folder", DeleteAsync)
            .WithName("DeleteFolder")
            .RequireVault("editor");

        group.MapPut("/folder/move", MoveAsync)
            .WithName("MoveFolder")
            .RequireVault("editor");
    }

    private static async Task<IResult> CreateAsync(
        Guid vaultId,
        CreateFolderRequest request,
        IFolderService folders,
        INotePathResolver paths,
        CancellationToken ct)
    {
        try
        {
            // Canonicalise here so the response carries the canonical
            // form, not whatever the user happened to type.
            var canonical = paths.CanonicalizeFolder(request.Path);
            await folders.CreateAsync(vaultId, canonical, ct);
            return Results.Created(
                $"/api/vaults/{vaultId}/folder?path={Uri.EscapeDataString(canonical)}",
                new FolderDto(canonical));
        }
        catch (InvalidNotePathException ex)
        {
            return Results.Problem(
                title: "Invalid folder path",
                detail: ex.Message,
                statusCode: 400);
        }
        catch (FolderException ex)
        {
            return Results.Problem(
                title: "Could not create folder",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    private static async Task<IResult> DeleteAsync(
        Guid vaultId,
        string path,
        IFolderService folders,
        INotePathResolver paths,
        CancellationToken ct)
    {
        try
        {
            var canonical = paths.CanonicalizeFolder(path);
            await folders.DeleteAsync(vaultId, canonical, ct);
            return Results.NoContent();
        }
        catch (InvalidNotePathException ex)
        {
            return Results.Problem(
                title: "Invalid folder path",
                detail: ex.Message,
                statusCode: 400);
        }
        catch (FolderException ex)
        {
            return Results.Problem(
                title: "Could not delete folder",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    private static async Task<IResult> MoveAsync(
        Guid vaultId,
        MoveFolderRequest request,
        IFolderService folders,
        INotePathResolver paths,
        CancellationToken ct)
    {
        if (request is null
            || string.IsNullOrWhiteSpace(request.OldPath)
            || string.IsNullOrWhiteSpace(request.NewPath))
        {
            return Results.Problem(
                title: "Invalid request",
                detail: "Both oldPath and newPath are required.",
                statusCode: 400);
        }

        try
        {
            var oldCanonical = paths.CanonicalizeFolder(request.OldPath);
            var newCanonical = paths.CanonicalizeFolder(request.NewPath);
            await folders.MoveAsync(vaultId, oldCanonical, newCanonical, ct);
            return Results.Ok(new FolderDto(newCanonical));
        }
        catch (InvalidNotePathException ex)
        {
            return Results.Problem(
                title: "Invalid folder path",
                detail: ex.Message,
                statusCode: 400);
        }
        catch (FolderException ex)
        {
            return Results.Problem(
                title: "Could not move folder",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }
}
