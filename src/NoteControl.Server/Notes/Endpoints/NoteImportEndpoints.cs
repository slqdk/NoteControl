using NoteControl.Server.Notes.Import;
using NoteControl.Server.Notes.Services;
using NoteControl.Server.Vaults;
using NoteControl.Server.Vaults.Services;

namespace NoteControl.Server.Notes.Endpoints;

/// <summary>
/// /api/vaults/{vaultId}/import — multipart upload that imports
/// either a single .md file or a .zip of .md files (with optional
/// asset folders).
/// <para>
/// Form fields:
///   <c>targetFolder</c> (string, optional) — vault-relative folder
///     to import under. Empty/missing = vault root.
///   <c>file</c>         (file, required)   — the .md or .zip to import.
/// </para>
/// <para>
/// Always returns 200 with a per-entry result list unless the request
/// itself is malformed (missing file, unsupported extension, bad
/// target). Per-file failures during a multi-file import surface as
/// "failed" entries in the result rather than aborting the whole
/// batch — partial success is the realistic outcome when importing a
/// folder of dozens of notes.
/// </para>
/// </summary>
public static class NoteImportEndpoints
{
    public static IEndpointRouteBuilder MapNoteImportEndpoints(this IEndpointRouteBuilder app)
    {
        // Editor role required: this writes to the vault. CSRF is
        // enforced globally by CsrfFilter for state-changing methods.
        app.MapPost("/api/vaults/{vaultId:guid}/import", ImportAsync)
            .WithName("ImportNotes")
            .RequireVault(VaultService.RoleEditor);

        return app;
    }

    private static async Task<IResult> ImportAsync(
        Guid vaultId,
        HttpRequest request,
        INoteImportService import,
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
        catch (BadHttpRequestException ex)
        {
            // Body too large or malformed — Kestrel turns this into
            // BadHttpRequestException. Map to 413 since the most
            // common cause is exceeding the request size limit.
            return Results.Problem(
                title: "Upload too large or malformed",
                detail: ex.Message,
                statusCode: 413);
        }

        var targetFolder = form["targetFolder"].ToString() ?? string.Empty;

        var file = form.Files.GetFile("file");
        if (file is null || file.Length == 0)
        {
            return Results.Problem(
                title: "file is required",
                statusCode: 400);
        }

        var fileName = file.FileName ?? string.Empty;
        var lowered = fileName.ToLowerInvariant();
        if (!lowered.EndsWith(".md") && !lowered.EndsWith(".zip"))
        {
            return Results.Problem(
                title: "Only .md and .zip files are supported",
                statusCode: 400);
        }

        // Buffer the file in memory. For our expected upload sizes
        // (a personal note vault as a zip — tens of MB at the
        // outer edge) this is fine. If we ever import multi-GB
        // archives we'd want to spool to disk first.
        byte[] content;
        await using (var stream = file.OpenReadStream())
        {
            using var ms = new MemoryStream();
            await stream.CopyToAsync(ms, ct);
            content = ms.ToArray();
        }

        try
        {
            var result = await import.ImportAsync(
                vaultId,
                new ImportRequest(fileName, content, targetFolder),
                ct);

            return Results.Ok(result);
        }
        catch (NoteException ex)
        {
            return Results.Problem(statusCode: ex.StatusCode, title: ex.Message);
        }
    }
}
