using Microsoft.AspNetCore.Mvc;
using NoteControl.Server.Audit;
using NoteControl.Server.Auth;
using NoteControl.Server.Backups;
using NoteControl.Server.Backups.Services;
using NoteControl.Shared.Admin;

namespace NoteControl.Server.Admin.Endpoints;

/// <summary>
/// Admin-only endpoints for the Backups window.
/// <para>
/// Routes:
/// <list type="bullet">
///   <item><c>GET    /api/admin/server/backup/status</c></item>
///   <item><c>POST   /api/admin/server/backup/run</c> (long-poll)</item>
///   <item><c>GET    /api/admin/server/backup/list</c></item>
///   <item><c>DELETE /api/admin/server/backup/{id}</c></item>
///   <item><c>POST   /api/admin/server/backup/{id}/restore-vault</c></item>
/// </list>
/// </para>
/// <para>
/// Run and restore are NOT cancelled when the caller disconnects:
/// they ignore the request-aborted token. A client that gives up
/// (tray timeout, closed window, flaky Wi-Fi) used to cancel the job
/// half-way — deleting the partial backup or rolling back the
/// restore — and lose the audit record with it. Now the job always
/// runs to completion and is audited; the caller can see the outcome
/// via <c>/status</c>, <c>/list</c> and the audit log.
/// </para>
/// </summary>
public static class AdminBackupEndpoints
{
    public static IEndpointRouteBuilder MapAdminBackupEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/admin/server/backup")
            .WithTags("Admin")
            .RequireAdmin();

        group.MapGet("/status", GetStatus);
        group.MapPost("/run", RunNowAsync);
        group.MapGet("/list", List);
        group.MapDelete("/{id}", DeleteOne);
        group.MapPost("/{id}/restore-vault", RestoreVaultAsync);

        return app;
    }

    private static IResult GetStatus(IBackupService backups)
    {
        var s = backups.GetStatus();
        return Results.Ok(new BackupStatusDto(
            s.Running, s.LastRunAt, s.LastRunSuccess, s.LastRunError,
            s.LastRunDurationMs, s.CurrentTargetPath, s.BackupCount, s.TotalBytes));
    }

    private static async Task<IResult> RunNowAsync(
        HttpContext http,
        IBackupService backups,
        IAuditLog audit)
    {
        // Deliberately no request token — see the class remarks.
        var ct = CancellationToken.None;
        var r = await backups.RunNowAsync(ct);
        var dto = new BackupRunResultDto(
            r.Success, r.BackupId, r.Error, r.DurationMs, r.BytesCopied);

        // Step 19 backfill: audit run-now (the scheduler audits its
        // own run separately so we know which trigger caused which).
        var user = http.RequireUser();
        await audit.WriteAsync(
            AuditEventTypes.BackupRun,
            user.Id,
            http.GetClientIp(),
            new
            {
                trigger = "manual",
                success = r.Success,
                backupId = r.BackupId,
                bytes = r.BytesCopied,
                durationMs = r.DurationMs,
                error = r.Error,
            },
            ct);

        // 200 even on logical failure so the client can read the
        // structured error from the body. Non-200s would force a
        // generic exception path.
        return Results.Ok(dto);
    }

    private static IResult List(IBackupService backups)
    {
        var list = backups.List();
        var dtos = list.Select(b => new BackupListItemDto(
            b.Id, b.CreatedAt, b.SizeBytes, b.AbsolutePath, b.VaultFolders)).ToList();
        return Results.Ok(dtos);
    }

    private static async Task<IResult> DeleteOne(
        string id,
        HttpContext http,
        IBackupService backups,
        IAuditLog audit,
        CancellationToken ct)
    {
        try
        {
            backups.DeleteOne(id);

            var user = http.RequireUser();
            await audit.WriteAsync(
                AuditEventTypes.BackupDeleted,
                user.Id,
                http.GetClientIp(),
                new { backupId = id },
                ct);

            return Results.NoContent();
        }
        catch (FileNotFoundException ex)
        {
            return Results.Problem(statusCode: 404, title: ex.Message);
        }
        catch (Exception ex)
        {
            return Results.Problem(statusCode: 500, title: ex.Message);
        }
    }

    private static async Task<IResult> RestoreVaultAsync(
        string id,
        [FromBody] RestoreVaultRequest request,
        HttpContext http,
        IRestoreService restore,
        IAuditLog audit)
    {
        // Deliberately no request token — a restore abandoned half-way
        // is the worst outcome; see the class remarks.
        var ct = CancellationToken.None;
        if (request is null)
            return Results.Problem(statusCode: 400, title: "Request body is required.");

        var r = await restore.RestoreVaultAsync(
            id, request.VaultId, request.VaultFolderInBackup, ct);

        // Audit success or failure — restore is destructive enough
        // that BOTH outcomes should be tracked.
        var user = http.RequireUser();
        await audit.WriteAsync(
            AuditEventTypes.BackupRestored,
            user.Id,
            http.GetClientIp(),
            new
            {
                backupId = id,
                vaultId = request.VaultId,
                vaultFolderInBackup = request.VaultFolderInBackup,
                success = r.Success,
                preRestoreFolder = r.PreRestoreFolderPath,
                durationMs = r.DurationMs,
                error = r.Error,
            },
            ct);

        return Results.Ok(new RestoreResultDto(
            r.Success, r.Error, r.PreRestoreFolderPath, r.DurationMs));
    }
}
