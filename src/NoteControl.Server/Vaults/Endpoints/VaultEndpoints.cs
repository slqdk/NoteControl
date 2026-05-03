using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Audit;
using NoteControl.Server.Auth;
using NoteControl.Server.Data;
using NoteControl.Server.Search.Services;
using NoteControl.Server.Vaults.Services;
using NoteControl.Shared.Vaults;

namespace NoteControl.Server.Vaults.Endpoints;

/// <summary>
/// /api/vaults — vault CRUD and membership.
///
/// List / get are permitted for any authenticated user (filtered to vaults
/// they can see). Admins additionally may pass ?all=true to see every vault
/// on the server (the row's MyRole is "none" for vaults they have no
/// permission on).
///
/// Create is permitted for any authenticated user (must target their own
/// user folder, or "shared/"). Admins additionally may pass
/// <see cref="CreateVaultRequest.OwnerUserId"/> to create a vault on
/// behalf of any active user — the chosen user becomes owner and gets the
/// owner permission row; the admin does NOT get automatic access.
///
/// Delete, share, unshare, and view membership default to owner-only (or
/// "any caller with a permission" for view-membership). Admins bypass
/// these checks — the server treats admin role as god-mode for vault
/// management. The audit log records `asAdmin: true` on the entries
/// produced under that path so post-hoc reviews can find them.
/// </summary>
public static class VaultEndpoints
{
    public static IEndpointRouteBuilder MapVaultEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/vaults").WithTags("Vaults").RequireAuth();

        group.MapGet("/", ListAsync);
        group.MapGet("/{vaultId:guid}", GetAsync);
        group.MapPost("/", CreateAsync);
        group.MapPost("/register", RegisterAsync);
        group.MapDelete("/{vaultId:guid}", DeleteAsync);

        group.MapGet("/{vaultId:guid}/permissions", ListMembersAsync);
        group.MapPost("/{vaultId:guid}/permissions", ShareAsync);
        group.MapDelete("/{vaultId:guid}/permissions/{userId:guid}", UnshareAsync);

        return app;
    }

    private static async Task<IResult> ListAsync(
        HttpContext http,
        IVaultService vaults,
        CancellationToken ct)
    {
        var user = http.RequireUser();

        // Admin "show all vaults" mode. The query param is opt-in
        // (default: filtered to caller's permissions). Non-admin
        // callers passing all=true silently get the default
        // filtered view -- no 403, since the resulting list is a
        // subset of what they'd get otherwise. This keeps the
        // query string forgiving (e.g. a future shared bookmarked
        // URL won't break for a non-admin).
        var showAll = string.Equals(http.Request.Query["all"], "true", StringComparison.OrdinalIgnoreCase);
        if (showAll && http.IsAdmin())
        {
            var allRows = await vaults.ListAllAsync(user.Id, ct);
            return Results.Ok(allRows);
        }

        var list = await vaults.ListForUserAsync(user.Id, ct);
        return Results.Ok(list);
    }

    private static async Task<IResult> GetAsync(
        Guid vaultId,
        HttpContext http,
        IVaultService vaults,
        CancellationToken ct)
    {
        var user = http.RequireUser();
        var dto = await vaults.GetForUserAsync(vaultId, user.Id, ct);
        return dto is null ? Results.NotFound() : Results.Ok(dto);
    }

    private static async Task<IResult> CreateAsync(
        CreateVaultRequest request,
        HttpContext http,
        ServerDbContext db,
        IVaultService vaults,
        IAuditLog audit,
        CancellationToken ct)
    {
        var user = http.RequireUser();

        // Resolve who will own the new vault. Default = the caller
        // (the historical behaviour). If the request specifies a
        // different OwnerUserId, this is an admin "create on behalf
        // of" flow — gate on the admin role and look up the target's
        // username for path validation.
        Guid targetOwnerId = request.OwnerUserId ?? user.Id;
        string targetOwnerUsername;

        if (targetOwnerId == user.Id)
        {
            targetOwnerUsername = user.Username;
        }
        else
        {
            // Different-from-caller: admin only.
            if (!http.IsAdmin())
            {
                return Results.Problem(
                    statusCode: 403,
                    title: "Only an administrator can create a vault on behalf of another user.");
            }

            // Look up the target's username so the path validator
            // can match it against the path's users/<username>/
            // segment. We pull only what we need; status check
            // included so we don't assign ownership to a disabled
            // account.
            var target = await db.Users
                .Where(u => u.Id == targetOwnerId)
                .Select(u => new { u.Username, u.Status })
                .FirstOrDefaultAsync(ct);

            if (target is null)
            {
                return Results.Problem(statusCode: 404, title: "Selected owner user not found.");
            }
            if (!string.Equals(target.Status, "active", StringComparison.OrdinalIgnoreCase))
            {
                return Results.Problem(
                    statusCode: 400,
                    title: "Selected owner user is not active.");
            }
            targetOwnerUsername = target.Username;
        }

        try
        {
            var dto = await vaults.CreateAsync(user.Id, targetOwnerId, targetOwnerUsername, request, ct);
            await audit.WriteAsync(
                AuditEventTypes.VaultCreated,
                user.Id,
                http.GetClientIp(),
                new
                {
                    vaultId = dto.Id,
                    path = dto.Path,
                    scope = dto.Scope,
                    // Surface the on-behalf-of detail in audit so the
                    // log answers "who actually created this for whom?".
                    ownerUserId = targetOwnerId,
                    onBehalfOf = targetOwnerId != user.Id ? targetOwnerUsername : null,
                },
                ct);
            return Results.Created($"/api/vaults/{dto.Id}", dto);
        }
        catch (VaultException ex)
        {
            return Results.Problem(statusCode: ex.StatusCode, title: ex.Message);
        }
    }

    private static async Task<IResult> RegisterAsync(
        RegisterVaultRequest request,
        HttpContext http,
        ServerDbContext db,
        IVaultService vaults,
        IIndexService index,
        IAuditLog audit,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var user = http.RequireUser();

        // Resolve target owner the same way Create does. Admin gate
        // when the chosen owner differs from the caller.
        Guid targetOwnerId = request.OwnerUserId ?? user.Id;
        string targetOwnerUsername;

        if (targetOwnerId == user.Id)
        {
            targetOwnerUsername = user.Username;
        }
        else
        {
            if (!http.IsAdmin())
            {
                return Results.Problem(
                    statusCode: 403,
                    title: "Only an administrator can register a vault on behalf of another user.");
            }

            var target = await db.Users
                .Where(u => u.Id == targetOwnerId)
                .Select(u => new { u.Username, u.Status })
                .FirstOrDefaultAsync(ct);

            if (target is null)
            {
                return Results.Problem(statusCode: 404, title: "Selected owner user not found.");
            }
            if (!string.Equals(target.Status, "active", StringComparison.OrdinalIgnoreCase))
            {
                return Results.Problem(statusCode: 400, title: "Selected owner user is not active.");
            }
            targetOwnerUsername = target.Username;
        }

        VaultDto dto;
        try
        {
            dto = await vaults.RegisterAsync(user.Id, targetOwnerId, targetOwnerUsername, request, ct);
        }
        catch (VaultException ex)
        {
            return Results.Problem(statusCode: ex.StatusCode, title: ex.Message);
        }

        await audit.WriteAsync(
            AuditEventTypes.VaultRegistered,
            user.Id,
            http.GetClientIp(),
            new
            {
                vaultId = dto.Id,
                path = dto.Path,
                scope = dto.Scope,
                ownerUserId = targetOwnerId,
                onBehalfOf = targetOwnerId != user.Id ? targetOwnerUsername : null,
            },
            ct);

        // Kick the search index rebuild as a background task so the
        // response is fast. The user's UI shows the new vault row
        // immediately; search lights up a few seconds later. Errors
        // here are logged but don't fail the registration -- the
        // admin can manually re-trigger the rebuild via the search
        // index endpoint if it ever fails.
        //
        // Same pattern as RestoreService.cs uses post-restore.
        var log = loggerFactory.CreateLogger("VaultRegister");
        var vaultId = dto.Id;
        _ = Task.Run(async () =>
        {
            try
            {
                var count = await index.RebuildAsync(vaultId);
                log.LogInformation("Post-register index rebuild for {VaultId} indexed {Count} notes.", vaultId, count);
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "Post-register index rebuild failed for {VaultId}.", vaultId);
            }
        });

        return Results.Created($"/api/vaults/{dto.Id}", dto);
    }

    private static async Task<IResult> DeleteAsync(
        Guid vaultId,
        HttpContext http,
        IVaultService vaults,
        IAuditLog audit,
        CancellationToken ct)
    {
        var user = http.RequireUser();
        var isAdmin = http.IsAdmin();
        try
        {
            await vaults.DeleteAsync(vaultId, user.Id, isAdmin, ct);
            await audit.WriteAsync(
                AuditEventTypes.VaultDeleted,
                user.Id,
                http.GetClientIp(),
                new
                {
                    vaultId,
                    // Records whether the caller was acting as admin when
                    // this happened. True even when admin acts on their
                    // own vault (acceptable noise -- audit reviews can
                    // filter further). Null when the caller is non-admin
                    // so the field is omitted from the JSON entirely.
                    asAdmin = isAdmin ? (bool?)true : null,
                },
                ct);
            return Results.NoContent();
        }
        catch (VaultException ex)
        {
            return Results.Problem(statusCode: ex.StatusCode, title: ex.Message);
        }
    }

    private static async Task<IResult> ListMembersAsync(
        Guid vaultId,
        HttpContext http,
        IVaultService vaults,
        ServerDbContext db,
        CancellationToken ct)
    {
        var user = http.RequireUser();
        // To see the membership list, the caller must themselves have a
        // permission on the vault -- OR be an admin (god-mode). We don't
        // reveal who has access to a vault to a non-admin who can't see
        // the vault itself.
        var role = await vaults.GetEffectiveRoleAsync(vaultId, user.Id, ct);
        if (role is null && !http.IsAdmin())
        {
            return Results.NotFound();
        }
        var members = await vaults.ListMembersAsync(vaultId, ct);
        return Results.Ok(members);
    }

    private static async Task<IResult> ShareAsync(
        Guid vaultId,
        ShareVaultRequest request,
        HttpContext http,
        IVaultService vaults,
        IAuditLog audit,
        CancellationToken ct)
    {
        var user = http.RequireUser();
        var isAdmin = http.IsAdmin();
        try
        {
            var member = await vaults.ShareAsync(vaultId, user.Id, isAdmin, request, ct);
            await audit.WriteAsync(
                AuditEventTypes.VaultShared,
                user.Id,
                http.GetClientIp(),
                new
                {
                    vaultId,
                    targetUserId = member.UserId,
                    role = member.Role,
                    asAdmin = isAdmin ? (bool?)true : null,
                },
                ct);
            return Results.Ok(member);
        }
        catch (VaultException ex)
        {
            return Results.Problem(statusCode: ex.StatusCode, title: ex.Message);
        }
    }

    private static async Task<IResult> UnshareAsync(
        Guid vaultId,
        Guid userId,
        HttpContext http,
        IVaultService vaults,
        IAuditLog audit,
        CancellationToken ct)
    {
        var caller = http.RequireUser();
        var isAdmin = http.IsAdmin();
        try
        {
            await vaults.UnshareAsync(vaultId, userId, caller.Id, isAdmin, ct);
            await audit.WriteAsync(
                AuditEventTypes.VaultUnshared,
                caller.Id,
                http.GetClientIp(),
                new
                {
                    vaultId,
                    targetUserId = userId,
                    asAdmin = isAdmin ? (bool?)true : null,
                },
                ct);
            return Results.NoContent();
        }
        catch (VaultException ex)
        {
            return Results.Problem(statusCode: ex.StatusCode, title: ex.Message);
        }
    }
}
