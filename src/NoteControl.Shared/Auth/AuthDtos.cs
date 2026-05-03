namespace NoteControl.Shared.Auth;

/// <summary>
/// POST /api/auth/login request body.
/// </summary>
public sealed record LoginRequest(string Username, string Password);

/// <summary>
/// POST /api/auth/local-token request body. The token is read by
/// the tray app from <c>{DataRoot}/.server/tray.token</c> at
/// startup. Only loopback callers are accepted server-side; the
/// token rotates on each server restart.
/// </summary>
public sealed record LocalTokenLoginRequest(string Token);

/// <summary>
/// POST /api/auth/login response body. The session cookie is set by the
/// server as a Set-Cookie header; the response body itself only carries the
/// CSRF token (which the client must echo on subsequent state-changing
/// requests) and the authenticated user.
/// </summary>
public sealed record LoginResponse(string CsrfToken, UserDto User);

/// <summary>
/// GET /api/auth/me response body, returned for the currently authenticated
/// user. Used by the frontend to decide whether to redirect to login.
/// </summary>
public sealed record MeResponse(UserDto User, string CsrfToken);

/// <summary>
/// Public projection of a user. Never includes the password hash, TOTP
/// secret, or any other credential material.
/// </summary>
public sealed record UserDto(
    Guid Id,
    string Username,
    string Email,
    string Role,
    string Status,
    DateTimeOffset CreatedAt,
    DateTimeOffset? LastLoginAt);

/// <summary>
/// POST /api/users (admin) — create a new user.
/// </summary>
public sealed record CreateUserRequest(
    string Username,
    string Email,
    string Password,
    string Role);

/// <summary>
/// PUT /api/users/{id} (admin or self) — update user fields. All fields
/// optional; only those supplied are changed.
/// </summary>
public sealed record UpdateUserRequest(
    string? Email,
    string? Role,
    string? Status);

/// <summary>
/// POST /api/users/{id}/password — change password. CurrentPassword is
/// required when the caller is changing their own password; admins changing
/// another user's password may omit it.
/// </summary>
public sealed record ChangePasswordRequest(string? CurrentPassword, string NewPassword);
