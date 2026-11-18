using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using NoteControl.Server.Audit;
using NoteControl.Server.Auth.Services;
using NoteControl.Server.Data;
using NoteControl.Server.Options;
using NoteControl.Shared.Auth;

namespace NoteControl.Server.Auth.Endpoints;

/// <summary>
/// /api/auth/* endpoints. Login is anonymous; logout and me require an
/// existing session.
/// </summary>
public static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/auth").WithTags("Auth");

        group.MapPost("/login", LoginAsync);
        group.MapPost("/logout", LogoutAsync).RequireAuth();
        group.MapGet("/me", Me).RequireAuth();
        // Self-service password change for any signed-in user (the
        // admin reset lives at POST /api/users/{id}/password).
        group.MapPost("/password", ChangeOwnPasswordAsync).RequireAuth();

        return app;
    }

    private static async Task<IResult> LoginAsync(
        LoginRequest request,
        HttpContext http,
        ServerDbContext db,
        IPasswordHasher hasher,
        ISessionService sessions,
        ILoginThrottle throttle,
        IAuditLog audit,
        IOptionsMonitor<AuthOptions> authOptions,
        CancellationToken ct)
    {
        var ip = http.GetClientIp();

        if (string.IsNullOrWhiteSpace(request.Username) || string.IsNullOrEmpty(request.Password))
        {
            return Results.Problem(statusCode: 400, title: "Username and password are required.");
        }

        // Throttle BEFORE hitting the database so the cheap path stays cheap.
        var decision = throttle.CheckAllowed(ip, request.Username);
        if (decision.Outcome != ThrottleOutcome.Allowed)
        {
            await audit.WriteAsync(
                AuditEventTypes.LoginLockedOut,
                userId: null,
                ipAddress: ip,
                details: new { username = request.Username, reason = decision.Outcome.ToString() },
                ct);

            var retrySeconds = decision.RetryAfter is { } ra ? (int?)Math.Ceiling(ra.TotalSeconds) : null;
            if (retrySeconds is { } seconds)
            {
                http.Response.Headers["Retry-After"] = seconds.ToString();
            }
            // 423 for a locked account, 429 for the per-IP limit — the
            // codes auth.md / api.md specify (both used to be 429).
            if (decision.Outcome == ThrottleOutcome.AccountLockedOut)
            {
                var minutes = retrySeconds is { } s ? Math.Max(1, (int)Math.Ceiling(s / 60.0)) : (int?)null;
                return Results.Problem(
                    statusCode: StatusCodes.Status423Locked,
                    title: minutes is null
                        ? "This account is temporarily locked after too many failed sign-ins."
                        : $"This account is temporarily locked after too many failed sign-ins. Try again in {minutes} minute(s).");
            }
            return Results.Problem(statusCode: 429, title: "Too many login attempts. Try again later.");
        }

        var user = await db.Users.FirstOrDefaultAsync(
            u => u.Username == request.Username, ct);

        // We do an argon2 verify even for non-existent users to keep the
        // response time roughly constant — otherwise an attacker can probe
        // for valid usernames by timing.
        var dummyHash = "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        var passwordOk = user is null
            ? hasher.Verify(request.Password, dummyHash)
            : hasher.Verify(request.Password, user.PasswordHash);

        if (user is null || !passwordOk
            || !string.Equals(user.Status, "active", StringComparison.OrdinalIgnoreCase))
        {
            throttle.RecordFailure(ip, request.Username);
            await audit.WriteAsync(
                AuditEventTypes.LoginFailure,
                userId: user?.Id,
                ipAddress: ip,
                details: new { username = request.Username, status = user?.Status },
                ct);
            return Results.Problem(statusCode: 401, title: "Invalid username or password.");
        }

        // Opportunistic re-hash if hash parameters have been raised since
        // this password was set.
        if (hasher.NeedsRehash(user.PasswordHash))
        {
            user.PasswordHash = hasher.Hash(request.Password);
        }

        user.LastLoginAt = DateTimeOffset.UtcNow;
        user.LastLoginIp = ip;
        await db.SaveChangesAsync(ct);

        var session = await sessions.CreateAsync(
            user,
            ipAddress: ip,
            userAgent: http.Request.Headers.UserAgent.ToString(),
            ct);

        // Snapshot once so AppendSession/AppendCsrf use the same
        // options view even if a config reload fires between them.
        var opts = authOptions.CurrentValue;
        AuthCookies.AppendSession(http, opts, session.RawToken, session.Session.ExpiresAt);
        AuthCookies.AppendCsrf(http, opts, session.CsrfToken);

        throttle.RecordSuccess(ip, request.Username);
        await audit.WriteAsync(
            AuditEventTypes.LoginSuccess,
            user.Id,
            ip,
            details: null,
            ct);

        return Results.Ok(new LoginResponse(session.CsrfToken, ToDto(user)));
    }

    private static async Task<IResult> LogoutAsync(
        HttpContext http,
        ISessionService sessions,
        IAuditLog audit,
        IOptionsMonitor<AuthOptions> authOptions,
        CancellationToken ct)
    {
        var session = http.GetSession();
        var user = http.GetUser();

        if (session is not null)
        {
            await sessions.RevokeAsync(session.Id, ct);
        }

        var opts = authOptions.CurrentValue;
        AuthCookies.ClearSession(http, opts);
        AuthCookies.ClearCsrf(http, opts);

        await audit.WriteAsync(AuditEventTypes.Logout, user?.Id, http.GetClientIp(), null, ct);
        return Results.Ok();
    }

    private static IResult Me(HttpContext http)
    {
        var user = http.RequireUser();
        // The session's own token — NOT the request's CSRF cookie. That
        // cookie has no expiry, so after a browser restart the request
        // carries only nc_sid and echoing the (missing) cookie handed
        // the SPA an empty token: every save then failed with 403. The
        // session resolver re-sets the cookie on this same response.
        var csrf = http.GetSessionCsrfToken() ?? string.Empty;
        return Results.Ok(new MeResponse(ToDto(user), csrf));
    }

    /// <summary>
    /// POST /api/auth/password — change the caller's own password.
    /// Body: <see cref="ChangePasswordRequest"/> with CurrentPassword
    /// REQUIRED: the session alone isn't proof of identity here (a
    /// browser left signed in must not be enough to lock the owner
    /// out). Other sessions of the user are revoked; the current one
    /// stays valid so the user isn't bounced to the login screen.
    /// </summary>
    private static async Task<IResult> ChangeOwnPasswordAsync(
        ChangePasswordRequest request,
        HttpContext http,
        ServerDbContext db,
        IPasswordHasher hasher,
        IPasswordPolicy policy,
        IAuditLog audit,
        CancellationToken ct)
    {
        var caller = http.RequireUser();
        var session = http.GetSession();

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == caller.Id, ct);
        if (user is null)
        {
            return Results.Unauthorized();
        }

        if (string.IsNullOrEmpty(request.CurrentPassword)
            || !hasher.Verify(request.CurrentPassword, user.PasswordHash))
        {
            await audit.WriteAsync(
                AuditEventTypes.PasswordChanged,
                userId: user.Id,
                ipAddress: http.GetClientIp(),
                details: new { self = true, success = false, reason = "wrong current password" },
                ct);
            return Results.Problem(statusCode: 400, title: "Current password is incorrect.");
        }

        if (string.Equals(request.CurrentPassword, request.NewPassword, StringComparison.Ordinal))
        {
            return Results.Problem(statusCode: 400, title: "The new password must differ from the current one.");
        }

        var policyCheck = await policy.ValidateAsync(request.NewPassword ?? string.Empty, ct);
        if (!policyCheck.IsValid)
        {
            return Results.Problem(statusCode: 400, title: policyCheck.Reason ?? "Invalid password.");
        }

        user.PasswordHash = hasher.Hash(request.NewPassword!);

        var currentSessionId = session?.Id;
        var others = await db.Sessions
            .Where(s => s.UserId == user.Id && !s.IsRevoked && s.Id != currentSessionId)
            .ToListAsync(ct);
        foreach (var s in others)
        {
            s.IsRevoked = true;
        }

        await db.SaveChangesAsync(ct);

        await audit.WriteAsync(
            AuditEventTypes.PasswordChanged,
            userId: user.Id,
            ipAddress: http.GetClientIp(),
            details: new { targetUserId = user.Id, self = true, otherSessionsRevoked = others.Count },
            ct);

        return Results.NoContent();
    }

    internal static UserDto ToDto(Data.Entities.User u)
        => new(u.Id, u.Username, u.Email, u.Role, u.Status, u.CreatedAt, u.LastLoginAt);
}
