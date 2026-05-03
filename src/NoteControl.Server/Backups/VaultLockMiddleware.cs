using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;

namespace NoteControl.Server.Backups;

/// <summary>
/// Middleware that intercepts write requests against /api/vaults/{vaultId}/...
/// routes and rejects them with 503 + Retry-After when the vault is
/// locked (today: only by an in-progress restore). Read methods (GET,
/// HEAD, OPTIONS) pass through.
/// <para>
/// Why middleware instead of an endpoint filter or per-service lock
/// check? Three reasons:
/// </para>
/// <list type="number">
///   <item>One central place — every existing AND future write
///     endpoint on a vault route is automatically gated.</item>
///   <item>No invasive changes to NoteService / FolderService /
///     AssetService. Step 14 had a stale-snapshot recovery
///     incident on NoteService.cs; minimising further edits to
///     it reduces the chance of similar regressions.</item>
///   <item>Catches asset uploads and folder operations the
///     same way it catches note saves, so a restore truly
///     freezes ALL writes to a vault.</item>
/// </list>
/// </summary>
public sealed class VaultLockMiddleware
{
    // Path-based vault-id extraction. Middleware runs BEFORE
    // routing has populated HttpContext.Request.RouteValues, so
    // we can't use that — we parse the path. Pattern matches
    // /api/vaults/{guid}/anything.
    private static readonly Regex VaultRouteRegex = new(
        @"^/api/vaults/(?<id>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(/|$)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private readonly RequestDelegate _next;

    public VaultLockMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context, IVaultLockService locks)
    {
        // Only check write methods. GET/HEAD/OPTIONS are read-only
        // for our purposes; they're allowed during a restore.
        var method = context.Request.Method;
        if (HttpMethods.IsGet(method) || HttpMethods.IsHead(method) ||
            HttpMethods.IsOptions(method))
        {
            await _next(context);
            return;
        }

        // Only check vault routes.
        var path = context.Request.Path.Value;
        if (string.IsNullOrEmpty(path))
        {
            await _next(context);
            return;
        }
        var match = VaultRouteRegex.Match(path);
        if (!match.Success)
        {
            await _next(context);
            return;
        }

        if (Guid.TryParse(match.Groups["id"].Value, out var vaultId)
            && locks.IsLocked(vaultId, out var reason))
        {
            // 503 Service Unavailable + Retry-After is the standard
            // shape for "ask again soon, the resource isn't ready
            // right now." Editors that handle generic save errors
            // surface the reason from the body.
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            context.Response.Headers["Retry-After"] = "5";
            context.Response.ContentType = "application/problem+json";
            await context.Response.WriteAsJsonAsync(new
            {
                title = "Vault is temporarily locked.",
                detail = reason ?? "An administrative operation is in progress.",
                status = 503,
            });
            return;
        }

        await _next(context);
    }
}
