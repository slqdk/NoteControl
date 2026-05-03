using NoteControl.Server.Options;

namespace NoteControl.Server.Auth;

/// <summary>
/// Centralised cookie attributes for session and CSRF cookies. Keeping them
/// in one place ensures the two cookies share lifecycle attributes (Path,
/// Secure, etc.) and stays in sync with appsettings.
/// </summary>
internal static class AuthCookies
{
    public static void AppendSession(HttpContext context, AuthOptions options, string rawToken, DateTimeOffset expiresAt)
    {
        context.Response.Cookies.Append(options.SessionCookieName, rawToken, new CookieOptions
        {
            HttpOnly = true,
            Secure = options.RequireSecureCookies,
            SameSite = SameSiteMode.Strict,
            Path = "/",
            Expires = expiresAt,
            IsEssential = true,
        });
    }

    public static void AppendCsrf(HttpContext context, AuthOptions options, string csrfToken)
    {
        // Deliberately NOT HttpOnly — the JS client needs to read this and
        // echo it in the configured request header (double-submit pattern).
        context.Response.Cookies.Append(options.CsrfCookieName, csrfToken, new CookieOptions
        {
            HttpOnly = false,
            Secure = options.RequireSecureCookies,
            SameSite = SameSiteMode.Strict,
            Path = "/",
            IsEssential = true,
        });
    }

    public static void ClearSession(HttpContext context, AuthOptions options)
    {
        context.Response.Cookies.Delete(options.SessionCookieName, new CookieOptions
        {
            Path = "/",
            Secure = options.RequireSecureCookies,
            SameSite = SameSiteMode.Strict,
        });
    }

    public static void ClearCsrf(HttpContext context, AuthOptions options)
    {
        context.Response.Cookies.Delete(options.CsrfCookieName, new CookieOptions
        {
            Path = "/",
            Secure = options.RequireSecureCookies,
            SameSite = SameSiteMode.Strict,
        });
    }
}
