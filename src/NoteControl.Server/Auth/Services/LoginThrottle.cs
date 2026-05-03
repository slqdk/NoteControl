using System.Collections.Concurrent;
using Microsoft.Extensions.Options;
using NoteControl.Server.Options;

namespace NoteControl.Server.Auth.Services;

/// <summary>
/// In-memory login throttling. Tracks failures per IP (short window) and per
/// account (longer window) and decides whether a login attempt should be
/// allowed through to the password check.
///
/// In-memory is intentional for v1: NoteControl is single-server. If we
/// ever go multi-instance, this becomes a Redis-backed implementation
/// behind the same interface.
/// </summary>
public interface ILoginThrottle
{
    /// <summary>
    /// Decide whether a login attempt from the given IP for the given
    /// username should proceed. The username may be the actual one supplied
    /// even if it doesn't exist — that's intentional, as it prevents an
    /// attacker from using lockout state to enumerate valid accounts.
    /// </summary>
    ThrottleDecision CheckAllowed(string? ipAddress, string username);

    /// <summary>Record a failed attempt against both buckets.</summary>
    void RecordFailure(string? ipAddress, string username);

    /// <summary>Clear failure state for an account on successful login.</summary>
    void RecordSuccess(string? ipAddress, string username);
}

public enum ThrottleOutcome
{
    Allowed,
    IpRateLimited,
    AccountLockedOut,
}

public sealed record ThrottleDecision(ThrottleOutcome Outcome, TimeSpan? RetryAfter);

public sealed class LoginThrottle : ILoginThrottle
{
    private readonly TimeProvider _clock;
    // Stored as a monitor because LoginThrottle is registered as
    // a singleton — capturing options.Value at construction would
    // freeze the throttle thresholds at boot, ignoring any later
    // edits in the admin Settings window. Each CheckAllowed reads
    // .CurrentValue so the latest snapshot is used. Note: changing
    // thresholds doesn't retroactively re-evaluate existing
    // bucket state (a locked account stays locked even if the
    // threshold is raised) — that's the correct behaviour, and
    // matches what users expect from a rolling-window limiter.
    private readonly IOptionsMonitor<AuthOptions> _options;

    private readonly ConcurrentDictionary<string, Bucket> _byIp = new();
    private readonly ConcurrentDictionary<string, Bucket> _byAccount = new(StringComparer.OrdinalIgnoreCase);

    public LoginThrottle(IOptionsMonitor<AuthOptions> options, TimeProvider clock)
    {
        _options = options;
        _clock = clock;
    }

    public ThrottleDecision CheckAllowed(string? ipAddress, string username)
    {
        var now = _clock.GetUtcNow();
        // Snapshot once per call so all three threshold reads see
        // a consistent view, even if config reloads mid-method.
        var opts = _options.CurrentValue;

        // IP bucket: short rolling 1-minute window.
        if (!string.IsNullOrEmpty(ipAddress))
        {
            var ipBucket = _byIp.GetOrAdd(ipAddress, _ => new Bucket());
            ipBucket.Trim(now - TimeSpan.FromMinutes(1));
            if (ipBucket.Count >= opts.LoginAttemptsPerIpPerMinute)
            {
                var retryAfter = ipBucket.OldestRetryAfter(now, TimeSpan.FromMinutes(1));
                return new ThrottleDecision(ThrottleOutcome.IpRateLimited, retryAfter);
            }
        }

        // Account bucket: longer window with a configurable lockout duration.
        var window = TimeSpan.FromHours(1);
        var accountBucket = _byAccount.GetOrAdd(username, _ => new Bucket());
        accountBucket.Trim(now - window);
        if (accountBucket.Count >= opts.LoginAttemptsPerAccountPerHour)
        {
            // While locked, every attempt extends the lockout window.
            return new ThrottleDecision(
                ThrottleOutcome.AccountLockedOut,
                TimeSpan.FromMinutes(opts.AccountLockoutMinutes));
        }

        return new ThrottleDecision(ThrottleOutcome.Allowed, null);
    }

    public void RecordFailure(string? ipAddress, string username)
    {
        var now = _clock.GetUtcNow();
        if (!string.IsNullOrEmpty(ipAddress))
        {
            _byIp.GetOrAdd(ipAddress, _ => new Bucket()).Add(now);
        }
        _byAccount.GetOrAdd(username, _ => new Bucket()).Add(now);
    }

    public void RecordSuccess(string? ipAddress, string username)
    {
        // Successful login clears the account bucket so legitimate users
        // who fat-fingered a few times don't stay on a hair trigger.
        _byAccount.TryRemove(username, out _);
        // IP bucket is left alone — a shared NAT could be sending many
        // attempts and we don't want a single success to forgive a flood.
    }

    /// <summary>
    /// A small thread-safe ring of timestamps. Safer and simpler than a
    /// rolling counter for these volumes — login attempts per minute are
    /// tiny.
    /// </summary>
    private sealed class Bucket
    {
        private readonly object _gate = new();
        private readonly LinkedList<DateTimeOffset> _hits = new();

        public int Count
        {
            get { lock (_gate) { return _hits.Count; } }
        }

        public void Add(DateTimeOffset when)
        {
            lock (_gate)
            {
                _hits.AddLast(when);
            }
        }

        public void Trim(DateTimeOffset cutoff)
        {
            lock (_gate)
            {
                while (_hits.First is { } first && first.Value < cutoff)
                {
                    _hits.RemoveFirst();
                }
            }
        }

        public TimeSpan OldestRetryAfter(DateTimeOffset now, TimeSpan window)
        {
            lock (_gate)
            {
                var oldest = _hits.First?.Value;
                if (oldest is null)
                {
                    return TimeSpan.Zero;
                }
                var clear = oldest.Value + window;
                var delta = clear - now;
                return delta > TimeSpan.Zero ? delta : TimeSpan.Zero;
            }
        }
    }
}
