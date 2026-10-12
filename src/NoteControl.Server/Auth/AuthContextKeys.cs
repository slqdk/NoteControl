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
    /// <summary>The CSRF token bound to the resolved session.</summary>
    public const string CsrfToken = "nc.csrf";
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

    /// <summary>The CSRF token of the resolved session, or null when anonymous.</summary>
    public static string? GetSessionCsrfToken(this HttpContext ctx)
        => ctx.Items.TryGetValue(AuthContextKeys.CsrfToken, out var v) ? v as string : null;

    /// <summary>
    /// True if the authenticated user has the admin role.
    /// </summary>
    public static bool IsAdmin(this HttpContext ctx)
    {
        var user = ctx.GetUser();
        return user is not null && string.Equals(user.Role, "admin", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Client IP, accounting for the reverse proxy. Caddy sets
    /// X-Forwarded-For; the ForwardedHeaders middleware (first in the
    /// pipeline, Program.cs) rewrites Connection.RemoteIpAddress from it
    /// only when the connection itself comes from loopback — i.e. from
    /// Caddy on the same machine. A direct LAN/internet client can't
    /// spoof its address with the header.
    /// </summary>
    public static string? GetClientIp(this HttpContext ctx)
        => ctx.Connection.RemoteIpAddress?.ToString();
}
