using NoteControl.Server.Data.Entities;

namespace NoteControl.Server.Auth.Services;

/// <summary>
/// Server-side session management. Sessions are stored as rows in the server
/// database; the cookie sent to the client carries an opaque random token
/// and we only persist its hash, so the database alone cannot be used to
/// impersonate a user.
/// </summary>
public interface ISessionService
{
    /// <summary>
    /// Create a new session for the given user and return the raw token
    /// that should be set as the session cookie value. The raw token is
    /// returned only here — it is not recoverable later.
    /// </summary>
    Task<NewSession> CreateAsync(User user, string? ipAddress, string? userAgent, CancellationToken ct = default);

    /// <summary>
    /// Look up a session by the raw cookie token, validating idle and
    /// absolute timeouts and revocation. On success, slides the idle
    /// expiration forward and returns the session and its user. On failure,
    /// returns null without distinguishing why.
    /// </summary>
    Task<AuthenticatedSession?> ValidateAsync(string rawToken, CancellationToken ct = default);

    /// <summary>
    /// Revoke a single session by ID. Idempotent.
    /// </summary>
    Task RevokeAsync(Guid sessionId, CancellationToken ct = default);

    /// <summary>
    /// Revoke every session belonging to a user. Used when changing a
    /// password or when an admin disables an account.
    /// </summary>
    Task RevokeAllForUserAsync(Guid userId, CancellationToken ct = default);
}

/// <summary>
/// Returned from CreateAsync. RawToken is what the client receives as the
/// cookie value; CsrfToken is bound to this session and must be echoed on
/// state-changing requests via the configured header.
/// </summary>
public sealed record NewSession(Session Session, string RawToken, string CsrfToken);

/// <summary>
/// Returned from ValidateAsync when the session is good. The CsrfToken here
/// is recomputed deterministically from the session token so the client's
/// existing CSRF cookie continues to validate on each request.
/// </summary>
public sealed record AuthenticatedSession(Session Session, User User, string CsrfToken);
