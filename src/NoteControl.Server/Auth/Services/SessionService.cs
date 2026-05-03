using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using NoteControl.Server.Data;
using NoteControl.Server.Data.Entities;
using NoteControl.Server.Options;

namespace NoteControl.Server.Auth.Services;

/// <summary>
/// Default ISessionService backed by the server database.
/// </summary>
public sealed class SessionService : ISessionService
{
    // Token sizes in bytes. 32 bytes = 256 bits of entropy in the cookie,
    // which is well above any plausible brute-force threshold.
    private const int TokenBytes = 32;

    private readonly ServerDbContext _db;
    // Stored as a monitor so changes to AuthOptions made via the
    // admin Settings window land here without a server restart.
    // Each call site reads .CurrentValue so the latest snapshot is
    // used — IOptionsMonitor caches that internally so the read is
    // cheap. Pre-migration we captured options.Value once at
    // construction; AbsoluteTimeoutMinutes / IdleTimeoutMinutes
    // changes were therefore stuck until the next process restart.
    private readonly IOptionsMonitor<AuthOptions> _options;
    private readonly TimeProvider _clock;
    private readonly byte[] _csrfKey;

    public SessionService(
        ServerDbContext db,
        IOptionsMonitor<AuthOptions> options,
        ICsrfKeyProvider csrfKeyProvider,
        TimeProvider clock)
    {
        _db = db;
        _options = options;
        _clock = clock;
        _csrfKey = csrfKeyProvider.GetKey();
    }

    public async Task<NewSession> CreateAsync(User user, string? ipAddress, string? userAgent, CancellationToken ct = default)
    {
        var rawToken = GenerateToken();
        var now = _clock.GetUtcNow();

        var session = new Session
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            TokenHash = HashToken(rawToken),
            CreatedAt = now,
            LastActivityAt = now,
            ExpiresAt = now.AddMinutes(_options.CurrentValue.AbsoluteTimeoutMinutes),
            IpAddress = ipAddress,
            UserAgent = Truncate(userAgent, 512),
            IsRevoked = false,
        };

        _db.Sessions.Add(session);
        await _db.SaveChangesAsync(ct);

        return new NewSession(session, rawToken, ComputeCsrfToken(rawToken));
    }

    public async Task<AuthenticatedSession?> ValidateAsync(string rawToken, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(rawToken))
        {
            return null;
        }

        var tokenHash = HashToken(rawToken);
        var session = await _db.Sessions.FirstOrDefaultAsync(s => s.TokenHash == tokenHash, ct);
        if (session is null || session.IsRevoked)
        {
            return null;
        }

        var now = _clock.GetUtcNow();
        if (now >= session.ExpiresAt)
        {
            return null;
        }

        var idleDeadline = session.LastActivityAt.AddMinutes(_options.CurrentValue.IdleTimeoutMinutes);
        if (now >= idleDeadline)
        {
            return null;
        }

        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == session.UserId, ct);
        if (user is null || !string.Equals(user.Status, "active", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        // Slide idle timeout forward, but throttle writes to once per minute
        // so high-frequency requests don't hammer the database.
        if ((now - session.LastActivityAt) > TimeSpan.FromMinutes(1))
        {
            session.LastActivityAt = now;
            await _db.SaveChangesAsync(ct);
        }

        return new AuthenticatedSession(session, user, ComputeCsrfToken(rawToken));
    }

    public async Task RevokeAsync(Guid sessionId, CancellationToken ct = default)
    {
        var session = await _db.Sessions.FirstOrDefaultAsync(s => s.Id == sessionId, ct);
        if (session is null || session.IsRevoked)
        {
            return;
        }

        session.IsRevoked = true;
        await _db.SaveChangesAsync(ct);
    }

    public async Task RevokeAllForUserAsync(Guid userId, CancellationToken ct = default)
    {
        var sessions = await _db.Sessions
            .Where(s => s.UserId == userId && !s.IsRevoked)
            .ToListAsync(ct);

        foreach (var s in sessions)
        {
            s.IsRevoked = true;
        }

        await _db.SaveChangesAsync(ct);
    }

    private static string GenerateToken()
    {
        Span<byte> bytes = stackalloc byte[TokenBytes];
        RandomNumberGenerator.Fill(bytes);
        // URL-safe base64 without padding so it survives every cookie / URL
        // serialization layer without escaping.
        return Base64UrlEncode(bytes);
    }

    private static string HashToken(string rawToken)
    {
        // The raw token is already 256 bits of cryptographically random data,
        // so a single SHA-256 pass is enough — no need for a slow KDF.
        var bytes = Encoding.UTF8.GetBytes(rawToken);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash);
    }

    private string ComputeCsrfToken(string rawToken)
    {
        // HMAC-SHA256(server-secret, session-token). Stable across requests
        // for the same session, so the client's CSRF cookie keeps matching.
        var hash = HMACSHA256.HashData(_csrfKey, Encoding.UTF8.GetBytes(rawToken));
        return Base64UrlEncode(hash);
    }

    private static string Base64UrlEncode(ReadOnlySpan<byte> bytes)
    {
        return Convert.ToBase64String(bytes)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    private static string? Truncate(string? value, int max)
    {
        if (value is null)
        {
            return null;
        }
        return value.Length <= max ? value : value[..max];
    }
}
