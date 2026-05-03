using Microsoft.Extensions.Options;
using NoteControl.Server.Auth.Services;
using NoteControl.Server.Options;

namespace NoteControl.Server.Auth;

/// <summary>
/// Reads the session cookie on every incoming request, validates it via
/// ISessionService, and stashes the authenticated user/session on
/// HttpContext.Items. Does not reject requests itself — endpoints decide
/// whether anonymous access is acceptable via RequireAuth/RequireAdmin
/// endpoint filters.
/// </summary>
public sealed class SessionResolverMiddleware
{
    private readonly RequestDelegate _next;
    // Monitor instead of Value: middleware is constructed once for
    // the app's lifetime, so the captured snapshot never refreshes.
    // Each InvokeAsync reads .CurrentValue so cookie names and
    // session timeouts edited in the admin Settings window apply
    // without a server restart.
    private readonly IOptionsMonitor<AuthOptions> _options;

    public SessionResolverMiddleware(RequestDelegate next, IOptionsMonitor<AuthOptions> options)
    {
        _next = next;
        _options = options;
    }

    public async Task InvokeAsync(HttpContext context, ISessionService sessions)
    {
        // Snapshot once per request so all four reads (cookie name
        // twice, csrf cookie name twice) see a consistent view —
        // critical because mid-request reload could otherwise have
        // us reading the new SessionCookieName but writing to the
        // old CsrfCookieName.
        var opts = _options.CurrentValue;

        var token = context.Request.Cookies[opts.SessionCookieName];
        if (!string.IsNullOrEmpty(token))
        {
            var auth = await sessions.ValidateAsync(token, context.RequestAborted);
            if (auth is not null)
            {
                context.Items[AuthContextKeys.User] = auth.User;
                context.Items[AuthContextKeys.Session] = auth.Session;

                // Refresh the (non-httpOnly) CSRF cookie on each authenticated
                // request so it stays in sync with the live session.
                if (context.Request.Cookies[opts.CsrfCookieName] != auth.CsrfToken)
                {
                    AuthCookies.AppendCsrf(context, opts, auth.CsrfToken);
                }
            }
            else
            {
                // Stale cookie — clear it so the browser stops sending it.
                AuthCookies.ClearSession(context, opts);
                AuthCookies.ClearCsrf(context, opts);
            }
        }

        await _next(context);
    }
}
