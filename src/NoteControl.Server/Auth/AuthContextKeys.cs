using NoteControl.Server.Data.Entities;

namespace NoteControl.Server.Auth;

/// <summary>
/// Keys used to stash the authenticated user / session on HttpContext.Items.
/// Centralised so the middleware that sets them and the endpoints that read
/// them can't drift apart.
/// </summary>
public static class AuthContextKeys
{
    public const string User = "nc.user";
    public const string Session = "nc.session";
}

public static class HttpContextAuthExtensions
{
    /// <summary>
    /// Returns the authenticated user, or null if the request is anonymous
    /// or the auth middleware did not run.
    /// </summary>
    public static User? GetUser(this HttpContext ctx)
        => ctx.Items.TryGetValue(AuthContextKeys.User, out var v) ? v as User : null;

    /// <summary>
    /// Returns the authenticated user or throws InvalidOperationException.
    /// Use only inside endpoints registered behind the auth middleware,
    /// where reaching this code without a user is a server bug.
    /// </summary>
    public static User RequireUser(this HttpContext ctx)
        => ctx.GetUser() ?? throw new InvalidOperationException(
            "RequireUser called on an unauthenticated request. Did you forget RequireAuthorization on the endpoint?");

    public static Session? GetSession(this HttpContext ctx)
        => ctx.Items.TryGetValue(AuthContextKeys.Session, out var v) ? v as Session : null;

    /// <summary>
    /// True if the authenticated user has the admin role.
    /// </summary>
    public static bool IsAdmin(this HttpContext ctx)
    {
        var user = ctx.GetUser();
        return user is not null && string.Equals(user.Role, "admin", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Best-effort client IP, accounting for the reverse proxy. Caddy sets
    /// X-Forwarded-For; Kestrel rewrites Connection.RemoteIpAddress when
    /// ForwardedHeaders middleware is configured. We prefer the latter
    /// because it's already validated against KnownProxies.
    /// </summary>
    public static string? GetClientIp(this HttpContext ctx)
        => ctx.Connection.RemoteIpAddress?.ToString();
}
