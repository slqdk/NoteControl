using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using NoteControl.Server.Audit;
using NoteControl.Server.Auth.Local;
using NoteControl.Server.Auth.Services;
using NoteControl.Server.Data;
using NoteControl.Server.Options;
using NoteControl.Shared.Auth;

namespace NoteControl.Server.Auth.Endpoints;

/// <summary>
/// /api/auth/local-token — token-based login for the tray app.
/// Lives next to the regular /api/auth/login but kept in its own
/// file because the rules are different: it only works for
/// loopback callers, and on success it issues a session for the
/// configured bootstrap admin (or any active admin if the
/// bootstrap one is gone).
/// <para>
/// Security model:
/// 1. The token rotates on every server restart (in-memory only,
///    written to {DataRoot}/.server/tray.token).
/// 2. Only loopback IPs (127.0.0.1 / ::1) are accepted. Caddy in
///    front of Kestrel still routes requests via loopback, so this
///    works in production too.
/// 3. The cookie issued is a normal admin session — not anything
///    new on the server side. From the rest of the server's
///    perspective this looks like a successful password login.
/// </para>
/// </summary>
public static class LocalTokenLoginEndpoint
{
    public static IEndpointRouteBuilder MapLocalTokenLoginEndpoint(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/auth/local-token", LoginAsync)
            .WithTags("Auth");
        return app;
    }

    private static async Task<IResult> LoginAsync(
        LocalTokenLoginRequest request,
        HttpContext http,
        ServerDbContext db,
        ISessionService sessions,
        ILocalTrayTokenService tokenService,
        IAuditLog audit,
        IOptionsMonitor<AuthOptions> authOptions,
        CancellationToken ct)
    {
        // 1. Loopback check. We refuse before even looking at the
        //    token so a remote attacker can't probe whether tokens
        //    are valid by timing.
        var remote = http.Connection.RemoteIpAddress;
        if (remote is null || !IPAddress.IsLoopback(remote))
        {
            return Results.Problem(
                statusCode: 403,
                title: "Local-token login is restricted to loopback callers.");
        }

        // 2. Token check.
        if (request is null
            || string.IsNullOrEmpty(request.Token)
            || !tokenService.Validate(request.Token))
        {
            // Use 401 so the tray's auto-login fallback path
            // distinguishes "no token / wrong token" from "remote".
            return Results.Problem(statusCode: 401, title: "Invalid or missing local token.");
        }

        // Snapshot once so all reads (BootstrapAdmin lookup,
        // cookie writes) see the same options view.
        var opts = authOptions.CurrentValue;

        // 3. Find an admin to log in as. Prefer the configured
        //    bootstrap admin (so the user knows whose audit trail
        //    they're touching) but fall back to any active admin
        //    if that user has been renamed or deleted.
        var bootstrapUsername = opts.BootstrapAdmin?.Username;
        var admin = !string.IsNullOrWhiteSpace(bootstrapUsername)
            ? await db.Users.FirstOrDefaultAsync(
                u => u.Username == bootstrapUsername && u.Status == "active",
                ct)
            : null;

        admin ??= await db.Users.FirstOrDefaultAsync(
            u => u.Role == "admin" && u.Status == "active",
            ct);

        if (admin is null)
        {
            return Results.Problem(
                statusCode: 503,
                title: "No active admin user available for local-token login.");
        }

        // 4. Issue a session. Same shape as the regular login flow
        //    so downstream code (RequireAdmin, audit log) doesn't
        //    have to care that this came from the tray.
        var ip = remote.ToString();
        var session = await sessions.CreateAsync(
            admin,
            ipAddress: ip,
            userAgent: http.Request.Headers.UserAgent.ToString(),
            ct);

        AuthCookies.AppendSession(http, opts, session.RawToken, session.Session.ExpiresAt);
        AuthCookies.AppendCsrf(http, opts, session.CsrfToken);

        admin.LastLoginAt = DateTimeOffset.UtcNow;
        admin.LastLoginIp = ip;
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync(
            AuditEventTypes.LoginSuccess,
            admin.Id,
            ip,
            details: new { method = "local-token" },
            ct);

        return Results.Ok(new LoginResponse(session.CsrfToken, AuthEndpoints.ToDto(admin)));
    }
}
