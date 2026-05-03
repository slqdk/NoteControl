using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Audit;
using NoteControl.Server.Auth;
using NoteControl.Server.Auth.Endpoints;
using NoteControl.Server.Auth.Services;
using NoteControl.Server.Data;
using NoteControl.Server.Data.Entities;
using NoteControl.Shared.Auth;

namespace NoteControl.Server.Users;

/// <summary>
/// /api/users — admin-only user management. The tray utility's "Users"
/// window will end up calling these too (currently via HTTP; the named-pipe
/// admin channel comes later).
/// </summary>
public static class UserEndpoints
{
    public static IEndpointRouteBuilder MapUserEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/users").WithTags("Users").RequireAdmin();

        group.MapGet("/", ListAsync);
        group.MapGet("/{id:guid}", GetAsync);
        group.MapPost("/", CreateAsync);
        group.MapPut("/{id:guid}", UpdateAsync);
        group.MapDelete("/{id:guid}", DeleteAsync);
        group.MapPost("/{id:guid}/password", ChangePasswordAsync);

        return app;
    }

    private static async Task<IResult> ListAsync(ServerDbContext db, CancellationToken ct)
    {
        var users = await db.Users
            .OrderBy(u => u.Username)
            .Select(u => new UserDto(u.Id, u.Username, u.Email, u.Role, u.Status, u.CreatedAt, u.LastLoginAt))
            .ToListAsync(ct);
        return Results.Ok(users);
    }

    private static async Task<IResult> GetAsync(Guid id, ServerDbContext db, CancellationToken ct)
    {
        var u = await db.Users.FirstOrDefaultAsync(x => x.Id == id, ct);
        return u is null ? Results.NotFound() : Results.Ok(AuthEndpoints.ToDto(u));
    }

    private static async Task<IResult> CreateAsync(
        CreateUserRequest request,
        HttpContext http,
        ServerDbContext db,
        IPasswordHasher hasher,
        IPasswordPolicy policy,
        IAuditLog audit,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Username) || request.Username.Length > 64)
        {
            return Results.Problem(statusCode: 400, title: "Username must be 1–64 characters.");
        }
        if (string.IsNullOrWhiteSpace(request.Email))
        {
            return Results.Problem(statusCode: 400, title: "Email is required.");
        }
        if (request.Role is not ("admin" or "user"))
        {
            return Results.Problem(statusCode: 400, title: "Role must be 'admin' or 'user'.");
        }

        var policyCheck = await policy.ValidateAsync(request.Password, ct);
        if (!policyCheck.IsValid)
        {
            return Results.Problem(statusCode: 400, title: policyCheck.Reason ?? "Invalid password.");
        }

        var clash = await db.Users.AnyAsync(
            u => u.Username == request.Username || u.Email == request.Email, ct);
        if (clash)
        {
            return Results.Problem(statusCode: 409, title: "Username or email already in use.");
        }

        var user = new User
        {
            Id = Guid.NewGuid(),
            Username = request.Username,
            Email = request.Email,
            PasswordHash = hasher.Hash(request.Password),
            Role = request.Role,
            Status = "active",
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.Users.Add(user);
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync(
            AuditEventTypes.UserCreated,
            userId: http.GetUser()?.Id,
            ipAddress: http.GetClientIp(),
            details: new { createdUserId = user.Id, username = user.Username, role = user.Role },
            ct);

        return Results.Created($"/api/users/{user.Id}", AuthEndpoints.ToDto(user));
    }

    private static async Task<IResult> UpdateAsync(
        Guid id,
        UpdateUserRequest request,
        HttpContext http,
        ServerDbContext db,
        ISessionService sessions,
        IAuditLog audit,
        CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null)
        {
            return Results.NotFound();
        }

        var changes = new Dictionary<string, object?>();

        if (request.Email is not null && request.Email != user.Email)
        {
            var clash = await db.Users.AnyAsync(u => u.Email == request.Email && u.Id != id, ct);
            if (clash)
            {
                return Results.Problem(statusCode: 409, title: "Email already in use.");
            }
            changes["email"] = new { from = user.Email, to = request.Email };
            user.Email = request.Email;
        }

        if (request.Role is not null && request.Role != user.Role)
        {
            if (request.Role is not ("admin" or "user"))
            {
                return Results.Problem(statusCode: 400, title: "Role must be 'admin' or 'user'.");
            }
            changes["role"] = new { from = user.Role, to = request.Role };
            user.Role = request.Role;
        }

        if (request.Status is not null && request.Status != user.Status)
        {
            if (request.Status is not ("active" or "locked" or "disabled"))
            {
                return Results.Problem(statusCode: 400, title: "Status must be 'active', 'locked', or 'disabled'.");
            }
            changes["status"] = new { from = user.Status, to = request.Status };
            user.Status = request.Status;

            // Disabling or locking should kick existing sessions immediately.
            if (request.Status != "active")
            {
                await sessions.RevokeAllForUserAsync(user.Id, ct);
            }
        }

        if (changes.Count == 0)
        {
            return Results.Ok(AuthEndpoints.ToDto(user));
        }

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync(
            AuditEventTypes.UserUpdated,
            userId: http.GetUser()?.Id,
            ipAddress: http.GetClientIp(),
            details: new { targetUserId = user.Id, changes },
            ct);

        return Results.Ok(AuthEndpoints.ToDto(user));
    }

    private static async Task<IResult> DeleteAsync(
        Guid id,
        HttpContext http,
        ServerDbContext db,
        ISessionService sessions,
        IAuditLog audit,
        CancellationToken ct)
    {
        var actor = http.RequireUser();
        if (actor.Id == id)
        {
            return Results.Problem(statusCode: 400, title: "You cannot delete your own account.");
        }

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null)
        {
            return Results.NotFound();
        }

        // Don't permit deleting the last admin — leaves the system unmanageable.
        if (string.Equals(user.Role, "admin", StringComparison.OrdinalIgnoreCase))
        {
            var otherAdmins = await db.Users.CountAsync(
                u => u.Role == "admin" && u.Id != id && u.Status == "active", ct);
            if (otherAdmins == 0)
            {
                return Results.Problem(statusCode: 400, title: "Cannot delete the last active admin.");
            }
        }

        await sessions.RevokeAllForUserAsync(user.Id, ct);
        db.Users.Remove(user);
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync(
            AuditEventTypes.UserDeleted,
            userId: actor.Id,
            ipAddress: http.GetClientIp(),
            details: new { deletedUserId = id, username = user.Username },
            ct);

        return Results.NoContent();
    }

    private static async Task<IResult> ChangePasswordAsync(
        Guid id,
        ChangePasswordRequest request,
        HttpContext http,
        ServerDbContext db,
        IPasswordHasher hasher,
        IPasswordPolicy policy,
        ISessionService sessions,
        IAuditLog audit,
        CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null)
        {
            return Results.NotFound();
        }

        // This endpoint is admin-only at the route level — the RequireAdmin
        // filter has already verified the caller is an authenticated admin.
        // That session is sufficient proof of identity; we don't re-prompt
        // for the current password even when an admin is resetting their
        // own.
        //
        // A separate "change my own password" endpoint for non-admin users
        // will require the current password, because for that flow the
        // session is the only proof of identity at hand. That endpoint
        // doesn't exist yet — coming when we add the user-profile UI.

        var actor = http.RequireUser();

        var policyCheck = await policy.ValidateAsync(request.NewPassword, ct);
        if (!policyCheck.IsValid)
        {
            return Results.Problem(statusCode: 400, title: policyCheck.Reason ?? "Invalid password.");
        }

        user.PasswordHash = hasher.Hash(request.NewPassword);
        await db.SaveChangesAsync(ct);

        // Spec: invalidate all sessions on password change.
        // Note: this also kills the actor's *own* session if they reset
        // their own password. The tray's UsersWindow will start getting
        // 401s on its next call; the user has to log back in.
        await sessions.RevokeAllForUserAsync(user.Id, ct);

        await audit.WriteAsync(
            AuditEventTypes.PasswordChanged,
            userId: actor.Id,
            ipAddress: http.GetClientIp(),
            details: new { targetUserId = user.Id },
            ct);

        return Results.NoContent();
    }
}
