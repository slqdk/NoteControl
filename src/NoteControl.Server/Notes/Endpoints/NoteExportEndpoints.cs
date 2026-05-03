using NoteControl.Server.Notes.Export;
using NoteControl.Server.Notes.Services;
using NoteControl.Server.Vaults;
using NoteControl.Server.Vaults.Services;

namespace NoteControl.Server.Notes.Endpoints;

/// <summary>
/// /api/vaults/{vaultId}/note/export — exports one note as a binary
/// file the browser downloads via Save dialog. Currently only docx
/// is implemented; the pdf branch returns 501 as a placeholder so
/// the frontend can detect it and disable the corresponding button.
/// </summary>
public static class NoteExportEndpoints
{
    public static IEndpointRouteBuilder MapNoteExportEndpoints(this IEndpointRouteBuilder app)
    {
        // Viewer role is sufficient — exporting is read-shaped. A
        // viewer with read access has every right to take content
        // out, same as copy-paste from the editor.
        app.MapGet("/api/vaults/{vaultId:guid}/note/export", ExportAsync)
            .RequireVault(VaultService.RoleViewer);

        return app;
    }

    private static async Task<IResult> ExportAsync(
        Guid vaultId,
        string path,
        string? format,
        INoteExportService export,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return Results.Problem(statusCode: 400, title: "?path= is required.");
        }

        var fmt = (format ?? "docx").Trim().ToLowerInvariant();

        if (fmt == "pdf")
        {
            // Placeholder — the panel disables this button, but
            // anyone hitting the URL directly should get a clear
            // 501 rather than a 500.
            return Results.Problem(
                statusCode: 501,
                title: "PDF export is not yet implemented.");
        }

        if (fmt != "docx")
        {
            return Results.Problem(
                statusCode: 400,
                title: $"Unsupported format '{fmt}'. Use 'docx'.");
        }

        try
        {
            var result = await export.ExportDocxAsync(vaultId, path, ct);
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
