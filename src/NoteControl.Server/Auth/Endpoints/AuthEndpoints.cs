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

    private static IResult Me(HttpContext http, IOptionsMonitor<AuthOptions> authOptions)
    {
        var user = http.RequireUser();
        var csrf = http.Request.Cookies[authOptions.CurrentValue.CsrfCookieName] ?? string.Empty;
        return Results.Ok(new MeResponse(ToDto(user), csrf));
    }

    internal static UserDto ToDto(Data.Entities.User u)
        => new(u.Id, u.Username, u.Email, u.Role, u.Status, u.CreatedAt, u.LastLoginAt);
}
