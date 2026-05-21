using NoteControl.Server.Folders.Services;
using NoteControl.Server.Notes.Services;
using NoteControl.Server.Vaults;

namespace NoteControl.Server.Folders.Endpoints;

/// <summary>
/// HTTP surface for per-folder cover images. Routes (all under
/// <c>/api/vaults/{vaultId}</c>):
///   <c>GET    /folder/cover?path=...</c>  — stream cover bytes (viewer)
///   <c>POST   /folder/cover?path=...</c>  — multipart upload/replace (editor)
///   <c>DELETE /folder/cover?path=...</c>  — remove cover (editor)
///
/// <para>
/// <c>?path=</c> may be empty — that's the vault root, which is also
/// a navigable folder in the UI. <see cref="INotePathResolver.CanonicalizeFolder"/>
/// accepts empty as "vault root" (note paths reject empty; folder paths don't).
/// </para>
///
/// <para>
/// The GET endpoint is its own route rather than reusing
/// <c>GET /asset?path=</c> because the asset endpoint's load-bearing
/// safety rule — "the path must contain a <c>.assets/</c> segment" —
/// would have to be loosened, and a dedicated route is clearer for
/// the frontend (a single URL it can drop into <c>&lt;img src&gt;</c>
/// without thinking about hashes or layout). The cover is also a
/// distinct concept from a note/template asset; keeping it on its
/// own route documents that.
/// </para>
/// </summary>
public static class FolderCoverEndpoints
{
    public static IEndpointRouteBuilder MapFolderCoverEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/vaults/{vaultId:guid}");

        group.MapGet("/folder/cover", DownloadAsync)
            .WithName("GetFolderCover")
            .RequireVault("viewer");

        group.MapPost("/folder/cover", UploadAsync)
            .WithName("UploadFolderCover")
            .RequireVault("editor");
            // CSRF is enforced by the global CsrfFilter on POST.

        group.MapDelete("/folder/cover", DeleteAsync)
            .WithName("DeleteFolderCover")
            .RequireVault("editor");

        return app;
    }

    private static async Task<IResult> DownloadAsync(
        Guid vaultId,
        string? path,
        IFolderCoverService covers,
        INotePathResolver paths,
        CancellationToken ct)
    {
        string canonical;
        try
        {
            canonical = paths.CanonicalizeFolder(path ?? string.Empty);
        }
        catch (InvalidNotePathException ex)
        {
            return Results.Problem(
                title: "Invalid folder path",
                detail: ex.Message,
                statusCode: 400);
        }

        var file = await covers.GetAsync(vaultId, canonical, ct);
        if (file is null)
        {
            return Results.NotFound();
        }

        // Range processing enabled so very large covers (animated GIFs,
        // tall screenshots, etc.) seek/stream like other binary assets.
        // The browser will set Accept-Ranges itself.
        return Results.File(
            file.AbsolutePath,
            contentType: file.ContentType,
            fileDownloadName: null,
            enableRangeProcessing: true);
    }

    private static async Task<IResult> UploadAsync(
        Guid vaultId,
        string? path,
        HttpRequest request,
        IFolderCoverService covers,
        INotePathResolver paths,
        CancellationToken ct)
    {
        if (!request.HasFormContentType)
        {
            return Results.Problem(
                title: "Multipart form data required",
                statusCode: 415);
        }

        IFormCollection form;
        try
        {
            form = await request.ReadFormAsync(ct);
        }
        catch (Exception ex) when (ex is BadHttpRequestException)
        {
            return Results.Problem(
                title: "Upload too large or malformed",
                detail: ex.Message,
                statusCode: 413);
        }

        var file = form.Files.GetFile("file");
        if (file is null || file.Length == 0)
        {
            return Results.Problem(
                title: "file is required",
                statusCode: 400);
        }

        string canonical;
        try
        {
            canonical = paths.CanonicalizeFolder(path ?? string.Empty);
        }
        catch (InvalidNotePathException ex)
        {
            return Results.Problem(
                title: "Invalid folder path",
                detail: ex.Message,
                statusCode: 400);
        }

        try
        {
            await using var stream = file.OpenReadStream();
            var info = await covers.SaveAsync(
                vaultId,
                canonical,
                file.FileName,
                file.ContentType ?? "application/octet-stream",
                stream,
                file.Length,
                ct);

            return Results.Ok(new FolderCoverUploadResponse(
                CoverUrl: BuildCoverUrl(vaultId, canonical, info.LastWriteUtc),
                ContentType: info.ContentType,
                SizeBytes: info.SizeBytes));
        }
        catch (FolderCoverException ex)
        {
            return Results.Problem(
                title: "Could not save cover",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    private static async Task<IResult> DeleteAsync(
        Guid vaultId,
        string? path,
        IFolderCoverService covers,
        INotePathResolver paths,
        CancellationToken ct)
    {
        string canonical;
        try
        {
            canonical = paths.CanonicalizeFolder(path ?? string.Empty);
        }
        catch (InvalidNotePathException ex)
        {
            return Results.Problem(
                title: "Invalid folder path",
                detail: ex.Message,
                statusCode: 400);
        }

        try
        {
            await covers.DeleteAsync(vaultId, canonical, ct);
            // Idempotent: 204 whether or not there was one to delete.
            // Matches the typical DELETE convention; the caller has
            // already decided to remove anything that's there.
            return Results.NoContent();
        }
        catch (FolderCoverException ex)
        {
            return Results.Problem(
                title: "Could not delete cover",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    /// <summary>
    /// Build the cache-bustable URL the frontend uses as
    /// <c>&lt;img src&gt;</c>. The <c>v</c> query parameter is the
    /// cover's mtime in unix-ms, so a re-upload changes the URL
    /// (defeats the browser cache) without us having to set
    /// no-store headers on the GET response.
    /// </summary>
    internal static string BuildCoverUrl(Guid vaultId, string canonicalFolderPath, DateTime lastWriteUtc)
    {
        var ms = new DateTimeOffset(lastWriteUtc, TimeSpan.Zero).ToUnixTimeMilliseconds();
        return $"/api/vaults/{vaultId}/folder/cover?path={Uri.EscapeDataString(canonicalFolderPath)}&v={ms}";
    }
}

/// <summary>
/// Response body for <c>POST /api/vaults/{id}/folder/cover</c>.
/// The frontend uses <see cref="CoverUrl"/> as the <c>&lt;img src&gt;</c>
/// directly — it embeds the mtime as a cache-buster, so a re-upload
/// of the same folder produces a different URL.
/// </summary>
public sealed record FolderCoverUploadResponse(
    string CoverUrl,
    string ContentType,
    long SizeBytes);
