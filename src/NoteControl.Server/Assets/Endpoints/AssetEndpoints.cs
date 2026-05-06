using NoteControl.Server.Assets.Services;
using NoteControl.Server.Vaults;
using NoteControl.Shared.Assets;

namespace NoteControl.Server.Assets.Endpoints;

/// <summary>
/// HTTP surface for asset upload / retrieval.
///
/// Routes (under <c>/api/vaults/{vaultId}</c>):
///   <c>POST /note/asset?notePath=…</c>  — multipart upload (editor)
///   <c>GET  /asset?path=…</c>           — stream the bytes (viewer)
///
/// Why <c>/note/asset</c> instead of <c>/asset</c> for upload?
/// Because the upload is intrinsically tied to a specific note —
/// it determines which <c>.assets/</c> folder the file lands in.
/// The GET, by contrast, just needs the canonical asset path.
/// </summary>
public static class AssetEndpoints
{
    public static IEndpointRouteBuilder MapAssetEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/vaults/{vaultId:guid}");

        group.MapPost("/note/asset", UploadAsync)
            .WithName("UploadAsset")
            .RequireVault("editor");
            // CSRF is enforced by the global CsrfFilter (X-CSRF-Token
            // header) — same as every other mutating endpoint.

        // Ship 98: parallel upload endpoint for template assets.
        // Lives under the same vaults group so RequireVault("editor")
        // still scopes auth to the vault — but uses templateName
        // rather than notePath as the binding identifier.
        group.MapPost("/template/asset", UploadTemplateAsync)
            .WithName("UploadTemplateAsset")
            .RequireVault("editor");

        group.MapGet("/asset", DownloadAsync)
            .WithName("DownloadAsset")
            .RequireVault("viewer");

        return app;
    }

    /// <summary>
    /// Multipart upload. Form fields:
    ///   <c>notePath</c> (string, required) — canonical note path
    ///   <c>file</c>     (file,   required) — the asset binary
    /// </summary>
    private static async Task<IResult> UploadAsync(
        Guid vaultId,
        HttpRequest request,
        IAssetService assets,
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
            // Body too large or malformed — Kestrel turns this into
            // BadHttpRequestException. Map to 413 since the most
            // common cause is exceeding the request size limit.
            return Results.Problem(
                title: "Upload too large or malformed",
                detail: ex.Message,
                statusCode: 413);
        }

        var notePath = form["notePath"].ToString();
        if (string.IsNullOrWhiteSpace(notePath))
        {
            return Results.Problem(
                title: "notePath form field is required",
                statusCode: 400);
        }

        var file = form.Files.GetFile("file");
        if (file is null || file.Length == 0)
        {
            return Results.Problem(
                title: "file is required",
                statusCode: 400);
        }

        try
        {
            await using var stream = file.OpenReadStream();
            var stored = await assets.SaveAsync(
                vaultId,
                notePath,
                file.FileName,
                file.ContentType ?? "application/octet-stream",
                stream,
                file.Length,
                ct);

            var serveUrl =
                $"/api/vaults/{vaultId}/asset?path={Uri.EscapeDataString(stored.CanonicalAssetPath)}";

            return Results.Ok(new AssetUploadResponse(
                RelativeMarkdownPath: stored.RelativeMarkdownPath,
                ServeUrl: serveUrl,
                OriginalFileName: stored.OriginalFileName,
                StoredFileName: stored.StoredFileName,
                SizeBytes: stored.SizeBytes,
                ContentType: stored.ContentType));
        }
        catch (AssetException ex)
        {
            return Results.Problem(
                title: "Could not save asset",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    /// <summary>
    /// Multipart upload for templates. Form fields:
    ///   <c>templateName</c> (string, required) — the template's
    ///                       file-name-without-extension. The
    ///                       template must already exist on disk.
    ///   <c>file</c>         (file,   required) — the asset binary.
    ///                       Must be an image (image-only policy
    ///                       enforced server-side; see
    ///                       <see cref="TemplateAssetService"/>).
    ///
    /// Mirrors <see cref="UploadAsync"/> but routes to
    /// <see cref="ITemplateAssetService"/>. Response shape is
    /// identical (<see cref="AssetUploadResponse"/>) so the
    /// frontend can reuse the same handler logic for either case.
    /// </summary>
    private static async Task<IResult> UploadTemplateAsync(
        Guid vaultId,
        HttpRequest request,
        ITemplateAssetService templateAssets,
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

        var templateName = form["templateName"].ToString();
        if (string.IsNullOrWhiteSpace(templateName))
        {
            return Results.Problem(
                title: "templateName form field is required",
                statusCode: 400);
        }

        var file = form.Files.GetFile("file");
        if (file is null || file.Length == 0)
        {
            return Results.Problem(
                title: "file is required",
                statusCode: 400);
        }

        try
        {
            await using var stream = file.OpenReadStream();
            var stored = await templateAssets.SaveAsync(
                vaultId,
                templateName,
                file.FileName,
                file.ContentType ?? "application/octet-stream",
                stream,
                file.Length,
                ct);

            var serveUrl =
                $"/api/vaults/{vaultId}/asset?path={Uri.EscapeDataString(stored.CanonicalAssetPath)}";

            return Results.Ok(new AssetUploadResponse(
                RelativeMarkdownPath: stored.RelativeMarkdownPath,
                ServeUrl: serveUrl,
                OriginalFileName: stored.OriginalFileName,
                StoredFileName: stored.StoredFileName,
                SizeBytes: stored.SizeBytes,
                ContentType: stored.ContentType));
        }
        catch (AssetException ex)
        {
            return Results.Problem(
                title: "Could not save template asset",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }

    /// <summary>
    /// Stream the asset bytes back to the browser with the right
    /// Content-Type. Cache headers tell the browser it can keep
    /// the bytes around for a while; assets are content-addressed
    /// in practice (filename suffixes mean a given path is stable).
    /// </summary>
    private static async Task<IResult> DownloadAsync(
        Guid vaultId,
        string path,
        IAssetService assets,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return Results.Problem(
                title: "?path= is required",
                statusCode: 400);
        }

        var asset = await assets.GetAsync(vaultId, path, ct);
        if (asset is null)
        {
            return Results.NotFound();
        }

        // Stream the file. Results.File handles range requests, ETag,
        // Last-Modified for free — important for video <video> tags
        // which may issue range requests for seeking.
        return Results.File(
            asset.AbsolutePath,
            contentType: asset.ContentType,
            // Don't force download — let the browser decide based on
            // Content-Type. Images render inline, PDFs preview, etc.
            fileDownloadName: null,
            enableRangeProcessing: true);
    }
}
