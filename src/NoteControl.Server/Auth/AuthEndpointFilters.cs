using Microsoft.Extensions.Options;
using NoteControl.Server.Options;

namespace NoteControl.Server.Auth;

/// <summary>
/// Endpoint filter that returns 401 if no authenticated user is on the
/// HttpContext.
/// </summary>
public sealed class RequireAuthFilter : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        if (ctx.HttpContext.GetUser() is null)
        {
            return Results.Unauthorized();
        }
        return await next(ctx);
    }
}

/// <summary>
/// Like RequireAuthFilter but additionally requires the admin role. 403 if
/// the user is authenticated but not an admin; 401 if not authenticated.
/// </summary>
public sealed class RequireAdminFilter : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var user = ctx.HttpContext.GetUser();
        if (user is null)
        {
            return Results.Unauthorized();
        }
        if (!ctx.HttpContext.IsAdmin())
        {
            return Results.Forbid();
        }
        return await next(ctx);
    }
}

/// <summary>
/// CSRF check using the double-submit cookie pattern: the value of the CSRF
/// cookie must equal the value supplied in the configured header. Applied
/// only to state-changing methods (POST/PUT/PATCH/DELETE) — safe methods
/// don't need CSRF protection because they should never have side effects.
/// </summary>
public sealed class CsrfFilter : IEndpointFilter
{
    // Monitor instead of Value: CsrfFilter is registered as a
    // singleton, so options.Value would freeze cookie/header names
    // at app startup. Reading .CurrentValue per invocation makes
    // edits to CsrfCookieName / CsrfHeaderName via the admin
    // Settings window take effect immediately. Snapshot once per
    // call so the cookie and header reads see a consistent view.
    private readonly IOptionsMonitor<AuthOptions> _options;

    public CsrfFilter(IOptionsMonitor<AuthOptions> options) { _options = options; }

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var method = ctx.HttpContext.Request.Method;
        if (HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method))
        {
            return await next(ctx);
        }

        var opts = _options.CurrentValue;
        var cookie = ctx.HttpContext.Request.Cookies[opts.CsrfCookieName];
        var header = ctx.HttpContext.Request.Headers[opts.CsrfHeaderName].ToString();

        if (string.IsNullOrEmpty(cookie)
            || string.IsNullOrEmpty(header)
            || !CryptographicEqual(cookie, header))
        {
            return Results.Problem(
                statusCode: StatusCodes.Status403Forbidden,
                title: "CSRF token missing or invalid.");
        }

        return await next(ctx);
    }

    private static bool CryptographicEqual(string a, string b)
    {
        if (a.Length != b.Length)
        {
            return false;
        }
        var diff = 0;
        for (var i = 0; i < a.Length; i++)
        {
            diff |= a[i] ^ b[i];
        }
        return diff == 0;
    }
}

public static class AuthEndpointConventions
{
    /// <summary>
    /// Require an authenticated user. Combines auth and CSRF — applying
    /// this is the default for everything except a few designated public
    /// endpoints.
    ///
    /// Uses the delegate overload of AddEndpointFilter so this works on
    /// any IEndpointConventionBuilder (RouteHandlerBuilder, RouteGroupBuilder,
    /// etc). The generic AddEndpointFilter&lt;T&gt;() overload is only declared
    /// on RouteHandlerBuilder / RouteGroupBuilder, not on the base interface,
    /// which is why we resolve the filter from request services per call
    /// instead.
    /// </summary>
    public static TBuilder RequireAuth<TBuilder>(this TBuilder builder) where TBuilder : IEndpointConventionBuilder
    {
        builder.AddEndpointFilter(async (ctx, next) =>
        {
            var filter = ctx.HttpContext.RequestServices.GetRequiredService<RequireAuthFilter>();
            return await filter.InvokeAsync(ctx, next);
        });
        builder.AddEndpointFilter(async (ctx, next) =>
        {
            var filter = ctx.HttpContext.RequestServices.GetRequiredService<CsrfFilter>();
            return await filter.InvokeAsync(ctx, next);
        });
        return builder;
    }

    /// <summary>
    /// Require an authenticated admin. Implies RequireAuth + role check.
    /// </summary>
    public static TBuilder RequireAdmin<TBuilder>(this TBuilder builder) where TBuilder : IEndpointConventionBuilder
    {
        builder.AddEndpointFilter(async (ctx, next) =>
        {
            var filter = ctx.HttpContext.RequestServices.GetRequiredService<RequireAdminFilter>();
            return await filter.InvokeAsync(ctx, next);
        });
        builder.AddEndpointFilter(async (ctx, next) =>
        {
            var filter = ctx.HttpContext.RequestServices.GetRequiredService<CsrfFilter>();
            return await filter.InvokeAsync(ctx, next);
        });
        return builder;
    }
}
