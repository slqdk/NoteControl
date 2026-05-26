using Microsoft.AspNetCore.Mvc;
using NoteControl.Server.Admin.Services;
using NoteControl.Server.Audit;
using NoteControl.Server.Auth;
using NoteControl.Shared.Admin;

namespace NoteControl.Server.Admin.Endpoints;

/// <summary>
/// Admin-only endpoints for the Server Settings window.
/// <para>
/// Routes:
/// <list type="bullet">
///   <item><c>GET  /api/admin/server/config</c> — current effective config</item>
///   <item><c>PUT  /api/admin/server/config</c> — replace + persist</item>
/// </list>
/// </para>
/// <para>
/// All routes require admin role. Future plan: move admin endpoints
/// off HTTP entirely onto the named pipe (per spec). Today they live
/// here because the named pipe transport isn't built yet.
/// </para>
/// </summary>
public static class AdminConfigEndpoints
{
    public static IEndpointRouteBuilder MapAdminConfigEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/admin/server")
            .WithTags("Admin")
            .RequireAdmin();

        group.MapGet("/config", GetConfigAsync);
        group.MapPut("/config", UpdateConfigAsync);

        return app;
    }

    private static IResult GetConfigAsync(IConfigService config)
    {
        return Results.Ok(config.GetCurrent());
    }

    private static async Task<IResult> UpdateConfigAsync(
        [FromBody] ServerConfigDto request,
        HttpContext http,
        IConfigService config,
        IAuditLog audit,
        CancellationToken ct)
    {
        if (request is null)
        {
            return Results.Problem(statusCode: 400, title: "Request body is required.");
        }

        try
        {
            await config.UpdateAsync(request, ct);
        }
        catch (ConfigValidationException ex)
        {
            // RFC 7807-ish — surface field-level errors so the
            // Settings window can highlight specific inputs. For
            // simplicity the tray today shows the first error in
            // a MessageBox; the dictionary is here for future
            // per-field UI.
            return Results.ValidationProblem(
                ex.Errors.ToDictionary(
                    kvp => kvp.Key,
                    kvp => new[] { kvp.Value }),
                title: "Configuration is invalid.");
        }

        // Audit AFTER success. We don't log the new values verbatim
        // (they may include credentials + similar) — just the section
        // names that were touched.
        var user = http.RequireUser();
        await audit.WriteAsync(
            AuditEventTypes.ServerConfigUpdated,
            user.Id,
            http.GetClientIp(),
            new { sections = new[] { "Auth", "Backup", "Logging", "Network" } },
            ct);

        // Return the FRESH effective config so the UI reflects what
        // the server actually saved.
        return Results.Ok(config.GetCurrent());
    }
}
