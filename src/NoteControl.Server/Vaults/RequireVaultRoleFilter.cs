using NoteControl.Server.Auth;
using NoteControl.Server.Vaults.Services;

namespace NoteControl.Server.Vaults;

/// <summary>
/// Endpoint filter that loads the {vaultId} route value, looks up the
/// caller's role for that vault, and rejects with 403 if the role is below
/// the configured minimum. The looked-up role is stashed on
/// HttpContext.Items so the endpoint can read it without re-querying.
///
/// Hierarchy: owner > editor > viewer.
///
/// Usage:
///     group.MapGet("/{vaultId:guid}/notes", ...).RequireVault(VaultService.RoleViewer);
/// </summary>
public sealed class RequireVaultRoleFilter : IEndpointFilter
{
    public const string ContextKey = "nc.vault.role";

    private readonly string _minRole;
    private readonly IVaultService _vaults;

    public RequireVaultRoleFilter(string minRole, IVaultService vaults)
    {
        _minRole = minRole;
        _vaults = vaults;
    }

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var http = ctx.HttpContext;
        var user = http.GetUser();
        if (user is null)
        {
            // Belt and braces — RequireAuth should have already caught this.
            return Results.Unauthorized();
        }

        if (!http.Request.RouteValues.TryGetValue("vaultId", out var raw)
            || !Guid.TryParse(raw?.ToString(), out var vaultId))
        {
            return Results.Problem(statusCode: 400, title: "Vault id missing or malformed.");
        }

        var role = await _vaults.GetEffectiveRoleAsync(vaultId, user.Id, http.RequestAborted);
        if (role is null)
        {
            // No row in permissions table — treat indistinguishably from
            // "vault doesn't exist" to avoid leaking which vault ids are
            // valid.
            return Results.NotFound();
        }

        if (RoleRank(role) < RoleRank(_minRole))
        {
            return Results.Forbid();
        }

        http.Items[ContextKey] = role;
        return await next(ctx);
    }

    private static int RoleRank(string role) => role.ToLowerInvariant() switch
    {
        VaultService.RoleOwner  => 3,
        VaultService.RoleEditor => 2,
        VaultService.RoleViewer => 1,
        _ => 0,
    };
}

public static class VaultEndpointConventions
{
    /// <summary>
    /// Require an authenticated user with at least the given role on the
    /// {vaultId} route parameter. Combines RequireAuth + CSRF + the
    /// vault-role check.
    /// </summary>
    public static TBuilder RequireVault<TBuilder>(this TBuilder builder, string minRole)
        where TBuilder : IEndpointConventionBuilder
    {
        // Auth + CSRF first — same delegate-overload pattern as RequireAuth().
        builder.RequireAuth();

        // Then the vault-role check. Resolved per request from DI so the
        // scoped IVaultService is fresh for each call.
        builder.AddEndpointFilter(async (ctx, next) =>
        {
            var vaults = ctx.HttpContext.RequestServices.GetRequiredService<IVaultService>();
            var filter = new RequireVaultRoleFilter(minRole, vaults);
            return await filter.InvokeAsync(ctx, next);
        });
        return builder;
    }
}
