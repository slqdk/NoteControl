using System.Globalization;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Audit;
using NoteControl.Server.Auth;
using NoteControl.Server.Data;
using NoteControl.Server.Vaults;
using NoteControl.Server.Vaults.Services;

namespace NoteControl.Server.Export;

/// <summary>
/// Linux-4 zip downloads.
///
///   GET /api/admin/export            admin        — whole DataRoot, importable
///                                                    with deploy/linux/import.sh
///   GET /api/vaults/{id}/export      vault owner  — one vault folder
///
/// Both stream the zip as it is built (no temp copy of the data), so
/// the browser sees the download start at once and a multi-GB DataRoot
/// doesn't need the same space again on disk. GET + cookie auth, so a
/// plain &lt;a href&gt; download works; no CSRF token needed (nothing
/// is changed by the request).
/// </summary>
public static class ExportEndpoints
{
    public static IEndpointRouteBuilder MapExportEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/admin/export", FullExportAsync)
            .WithTags("Admin")
            .RequireAdmin();

        app.MapGet("/api/vaults/{vaultId:guid}/export", VaultExportAsync)
            .WithTags("Vaults")
            .RequireVault(VaultService.RoleOwner);

        return app;
    }

    private static async Task FullExportAsync(
        HttpContext http,
        IExportService export,
        IAuditLog audit,
        ILoggerFactory logs)
    {
        var user = http.RequireUser();
        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
        var host = SafeFileName(Environment.MachineName);
        PrepareZipResponse(http, $"NoteControl-export-{host}-{stamp}.zip");

        ExportStats? stats = null;
        string? error = null;
        try
        {
            stats = export.WriteFullExport(http.Response.Body, http.RequestAborted);
        }
        catch (OperationCanceledException)
        {
            error = "cancelled by client";
        }
        catch (Exception ex)
        {
            error = ex.Message;
            logs.CreateLogger("Export").LogError(ex, "Full export failed.");
            // Headers are already sent; aborting is the only way to
            // make the browser show the download as failed instead of
            // saving a truncated zip.
            http.Abort();
        }

        await audit.WriteAsync(
            AuditEventTypes.DataExported,
            user.Id,
            http.GetClientIp(),
            new
            {
                scope = "full",
                success = error is null,
                files = stats?.FileCount,
                bytes = stats?.TotalBytes,
                skipped = stats?.SkippedCount,
                error,
            },
            CancellationToken.None);
    }

    private static async Task VaultExportAsync(
        Guid vaultId,
        HttpContext http,
        ServerDbContext db,
        IVaultPathResolver paths,
        IExportService export,
        IAuditLog audit,
        ILoggerFactory logs)
    {
        var user = http.RequireUser();
        var vault = await db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Path, v.Name })
            .FirstOrDefaultAsync(http.RequestAborted);
        if (vault is null)
        {
            http.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
        PrepareZipResponse(http, $"{SafeFileName(vault.Name)}-{stamp}.zip");

        ExportStats? stats = null;
        string? error = null;
        try
        {
            stats = export.WriteVaultExport(paths.Resolve(vault.Path), http.Response.Body, http.RequestAborted);
        }
        catch (OperationCanceledException)
        {
            error = "cancelled by client";
        }
        catch (Exception ex)
        {
            error = ex.Message;
            logs.CreateLogger("Export").LogError(ex, "Vault export failed for {VaultId}.", vaultId);
            http.Abort();
        }

        await audit.WriteAsync(
            AuditEventTypes.VaultExported,
            user.Id,
            http.GetClientIp(),
            new
            {
                vaultId,
                path = vault.Path,
                success = error is null,
                files = stats?.FileCount,
                bytes = stats?.TotalBytes,
                error,
            },
            CancellationToken.None);
    }

    private static void PrepareZipResponse(HttpContext http, string fileName)
    {
        // ZipArchive only has a synchronous API; allow sync writes to
        // the response body for this one request.
        var bodyControl = http.Features.Get<IHttpBodyControlFeature>();
        if (bodyControl is not null) bodyControl.AllowSynchronousIO = true;

        http.Response.StatusCode = StatusCodes.Status200OK;
        http.Response.ContentType = "application/zip";
        // RFC 6266: ASCII fallback + UTF-8 filename* for æøå.
        var ascii = new string(fileName.Select(c => c < 128 && c != '"' ? c : '_').ToArray());
        http.Response.Headers.ContentDisposition =
            $"attachment; filename=\"{ascii}\"; filename*=UTF-8''{Uri.EscapeDataString(fileName)}";
        http.Response.Headers.CacheControl = "no-store";
    }

    private static string SafeFileName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars().Concat(new[] { '\\', '/', ':', '*', '?', '"', '<', '>', '|' }).ToHashSet();
        var cleaned = new string(name.Select(c => invalid.Contains(c) || char.IsControl(c) ? '_' : c).ToArray()).Trim();
        return cleaned.Length == 0 ? "vault" : cleaned;
    }
}
