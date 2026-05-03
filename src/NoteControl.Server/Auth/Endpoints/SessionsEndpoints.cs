using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Audit;
using NoteControl.Server.Auth.Services;
using NoteControl.Server.Data;
using NoteControl.Shared.Auth;

namespace NoteControl.Server.Auth.Endpoints;

/// <summary>
/// /api/users/{userId}/sessions and /api/sessions/{sessionId}.
///
/// List and delete are admin-only, with one carve-out: a non-admin user is
/// allowed to list and revoke their own sessions. Admins can do this for
/// anyone.
/// </summary>
public static class SessionsEndpoints
{
    public static IEndpointRouteBuilder MapSessionsEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/users/{userId:guid}/sessions", ListForUserAsync).RequireAuth();
        app.MapDelete("/api/sessions/{sessionId:guid}", RevokeAsync).RequireAuth();
        return app;
    }

    private static async Task<IResult> ListForUserAsync(
        Guid userId,
        HttpContext http,
        ServerDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        var caller = http.RequireUser();
        // Self or admin.
        if (caller.Id != userId
            && !string.Equals(caller.Role, "admin", StringComparison.OrdinalIgnoreCase))
        {
            return Results.Forbid();
        }

        // If an admin is asking about another user, that user must exist;
        // otherwise return 404 instead of an empty 200 (which would leak
        // ambiguity between "user has no sessions" and "user doesn't exist").
        // For self-lookups we know the user exists — they just authenticated.
        if (caller.Id != userId
            && !await db.Users.AnyAsync(u => u.Id == userId, ct))
        {
            return Results.NotFound();
        }

        // Find the caller's current session id so we can flag it in the
        // result. Stored on HttpContext.Items by SessionResolverMiddleware
        // under the "nc.session" key (matches AuthContextKeys.Session).
        var currentSessionId = http.Items["nc.session"] is NoteControl.Server.Data.Entities.Session current
            ? current.Id
            : (Guid?)null;

        // EF Core's SQLite provider chokes on `s.ExpiresAt > DateTimeOffset.UtcNow`
        // because DateTimeOffset is stored as TEXT and the > operator can't be
        // translated for that storage type in some EF/SQLite combinations. The
        // table is small (one user, a handful of sessions); pull rows then
        // filter in memory. This avoids the LINQ translation failure entirely.
        var rows = await db.Sessions
            .Where(s => s.UserId == userId && !s.IsRevoked)
            .Select(s => new
            {
                s.Id,
                s.UserId,
                s.CreatedAt,
                s.LastActivityAt,
                s.ExpiresAt,
                s.IpAddress,
                s.UserAgent,
            })
            .ToListAsync(ct);

        var now = clock.GetUtcNow();
        var active = rows
            .Where(s => s.ExpiresAt > now)
            .OrderByDescending(s => s.LastActivityAt)
            .Select(s => new SessionDto(
                s.Id, s.UserId, s.CreatedAt, s.LastActivityAt, s.ExpiresAt,
                s.IpAddress, s.UserAgent,
                IsCurrent: currentSessionId is { } cur && s.Id == cur))
            .ToList();

        return Results.Ok(active);
    }

    private static async Task<IResult> RevokeAsync(
        Guid sessionId,
        HttpContext http,
        ServerDbContext db,
        IAuditLog audit,
        CancellationToken ct)
    {
        var caller = http.RequireUser();
        var session = await db.Sessions.FirstOrDefaultAsync(s => s.Id == sessionId, ct);
        if (session is null) return Results.NotFound();

        // Self or admin.
        if (session.UserId != caller.Id
            && !string.Equals(caller.Role, "admin", StringComparison.OrdinalIgnoreCase))
        {
            return Results.Forbid();
        }

        if (!session.IsRevoked)
        {
            session.IsRevoked = true;
            await db.SaveChangesAsync(ct);
            await audit.WriteAsync(
                AuditEventTypes.SessionRevoked,
                caller.Id,
                http.GetClientIp(),
                new { sessionId, targetUserId = session.UserId },
                ct);
        }
        return Results.NoContent();
    }
}
