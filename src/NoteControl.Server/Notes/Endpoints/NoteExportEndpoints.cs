using NoteControl.Server.Notes.Export;
using NoteControl.Server.Notes.Services;
using NoteControl.Server.Vaults;
using NoteControl.Server.Vaults.Services;

namespace NoteControl.Server.Notes.Endpoints;

/// <summary>
/// /api/vaults/{vaultId}/note/export — exports one note as a binary
/// file the browser downloads via Save dialog. Two formats today:
/// <list type="bullet">
///   <item><c>format=docx</c> (default) — Word document via the
///     existing rich-conversion pipeline (callouts, tables,
///     embedded images).</item>
///   <item><c>format=md</c> — zip containing the note's .md file
///     plus its <c>{basename}.assets/</c> folder if present, so a
///     subsequent import round-trips with image references intact.</item>
/// </list>
/// The <c>pdf</c> branch returns 501 as a placeholder; the frontend
/// dropped its PDF button in this ship and exposes Markdown export
/// in its place, but anyone hitting the URL directly with format=pdf
/// still gets a clear 501 rather than a 500 or generic 400.
/// </summary>
public static class NoteExportEndpoints
{
    public static IEndpointRouteBuilder MapNoteExportEndpoints(this IEndpointRouteBuilder app)
    {
        // Viewer role is sufficient for both formats — exporting is
        // read-shaped. A viewer with read access has every right to
        // take content out, same as copy-paste from the editor.
        app.MapGet("/api/vaults/{vaultId:guid}/note/export", ExportAsync)
            .RequireVault(VaultService.RoleViewer);

        return app;
    }

    private static async Task<IResult> ExportAsync(
        Guid vaultId,
        string path,
        string? format,
        INoteExportService docxExport,
        INoteMdExportService mdExport,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return Results.Problem(statusCode: 400, title: "?path= is required.");
        }

        var fmt = (format ?? "docx").Trim().ToLowerInvariant();

        // ---- markdown zip ---------------------------------------------
        if (fmt == "md")
        {
            try
            {
                var result = await mdExport.ExportMarkdownZipAsync(vaultId, path, ct);
                var fileName = SanitiseFileName(result.BaseFileName) + ".zip";

                // application/zip is the registered MIME for zips.
                // Some browsers fall back to octet-stream regardless;
                // the explicit type at least gives them a chance.
                return Results.File(
                    fileContents: result.Bytes,
                    contentType: "application/zip",
                    fileDownloadName: fileName);
            }
            catch (NoteException ex)
            {
                return Results.Problem(statusCode: ex.StatusCode, title: ex.Message);
            }
        }

        // ---- pdf placeholder ------------------------------------------
        if (fmt == "pdf")
        {
            return Results.Problem(
                statusCode: 501,
                title: "PDF export is not yet implemented.");
        }

        // ---- docx (default) -------------------------------------------
        if (fmt != "docx")
        {
            return Results.Problem(
                statusCode: 400,
                title: $"Unsupported format '{fmt}'. Use 'docx' or 'md'.");
        }

        try
        {
            var result = await docxExport.ExportDocxAsync(vaultId, path, ct);
            var fileName = SanitiseFileName(result.BaseFileName) + ".docx";

            // Results.File with fileDownloadName produces a proper
            // Content-Disposition: attachment; filename=... header.
            // ASP.NET Core 8 handles UTF-8 filename encoding via
            // the filename*= form automatically for non-ASCII
            // characters (Danish letters etc.).
            return Results.File(
                fileContents: result.Bytes,
                contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                fileDownloadName: fileName);
        }
        catch (NoteException ex)
        {
            return Results.Problem(statusCode: ex.StatusCode, title: ex.Message);
        }
    }

    /// <summary>
    /// Strip path separators, control chars, and Windows-reserved
    /// characters so the filename is safe in Save-As dialogs.
    /// </summary>
    private static string SanitiseFileName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var sb = new System.Text.StringBuilder(name.Length);
        foreach (var c in name)
        {
            if (Array.IndexOf(invalid, c) >= 0) sb.Append('_');
            else if (c < 0x20) sb.Append('_');
            else sb.Append(c);
        }
        var trimmed = sb.ToString().Trim();
        return string.IsNullOrEmpty(trimmed) ? "note" : trimmed;
    }
}
