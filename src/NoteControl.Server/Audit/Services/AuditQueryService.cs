using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Data;
using NoteControl.Shared.Admin;

namespace NoteControl.Server.Audit.Services;

/// <summary>
/// Read side of the audit log. The write side
/// (<see cref="IAuditLog"/>) appends events; this service queries
/// them with the filters the Logs window's Audit tab exposes.
/// </summary>
public interface IAuditQueryService
{
    /// <summary>
    /// Most-recent-first list of audit events matching the supplied
    /// filters. All filters optional; result clamped to
    /// <paramref name="limit"/> (max 200, default 200).
    /// </summary>
    Task<IReadOnlyList<AuditEntryDto>> QueryAsync(
        DateTimeOffset? since,
        DateTimeOffset? until,
        Guid? userId,
        string? eventType,
        int limit,
        CancellationToken ct = default);

    /// <summary>
    /// Distinct event types currently in the table. Used to populate
    /// the Logs window's "Event type" filter dropdown — much easier
    /// than hardcoding a list of constants on the client.
    /// </summary>
    Task<IReadOnlyList<string>> ListEventTypesAsync(CancellationToken ct = default);
}

public sealed class AuditQueryService : IAuditQueryService
{
    private const int MaxLimit = 200;

    private readonly ServerDbContext _db;

    public AuditQueryService(ServerDbContext db)
    {
        _db = db;
    }

    public async Task<IReadOnlyList<AuditEntryDto>> QueryAsync(
        DateTimeOffset? since,
        DateTimeOffset? until,
        Guid? userId,
        string? eventType,
        int limit,
        CancellationToken ct = default)
    {
        var clampedLimit = limit <= 0 ? MaxLimit : Math.Min(limit, MaxLimit);

        // Build the query. SQLite via EF Core can't translate
        // DateTimeOffset comparison or ordering, so we keep ONLY
        // the UserId / EventType / ORDER BY Id filters server-side.
        // Timestamp filtering happens after the round-trip, in
        // LINQ to Objects — see below.
        //
        // Microsoft's docs are explicit about this:
        //   https://learn.microsoft.com/en-us/ef/core/providers/sqlite/limitations
        //   "DateTimeOffset ... comparison and ordering will require
        //   evaluation on the client."
        //
        // Long-term fix: a value converter that stores Timestamp
        // as long (UTC ticks). Bigger change because existing rows
        // would need migration; deferred to a focused ship.
        var q = _db.AuditEvents.AsQueryable();
        if (userId.HasValue)       q = q.Where(e => e.UserId == userId.Value);
        if (!string.IsNullOrWhiteSpace(eventType))
                                   q = q.Where(e => e.EventType == eventType);

        // Pull a candidate set ordered by Id desc. Id is a
        // monotonically-increasing long, so descending Id ≡
        // descending Timestamp for our purposes (events are
        // inserted in time order).
        //
        // If a timestamp filter is in play we pull more candidates
        // than the clamped limit so the post-filter count still
        // hits the limit. 5x is a generous safety margin for an
        // audit log where the filter window is usually broad.
        var candidatePull = (since.HasValue || until.HasValue)
            ? clampedLimit * 5
            : clampedLimit;

        var raw = await q
            .OrderByDescending(e => e.Id)
            .Take(candidatePull)
            .Select(e => new
            {
                e.Id,
                e.Timestamp,
                e.EventType,
                e.UserId,
                e.IpAddress,
                e.Details,
                Username = e.UserId == null
                    ? null
                    : _db.Users.Where(u => u.Id == e.UserId).Select(u => u.Username).FirstOrDefault(),
            })
            .ToListAsync(ct);

        // Client-side timestamp filter, then take the final limit.
        // The anonymous-type fields are strongly-typed; sticking
        // with IEnumerable of the same anonymous shape so we don't
        // need `dynamic` or pre-declared classes.
        var afterTimestamp = raw.AsEnumerable();
        if (since.HasValue) afterTimestamp = afterTimestamp.Where(r => r.Timestamp >= since.Value);
        if (until.HasValue) afterTimestamp = afterTimestamp.Where(r => r.Timestamp <= until.Value);

        return afterTimestamp
            .Take(clampedLimit)
            .Select(r => new AuditEntryDto(
                Id: r.Id,
                Timestamp: r.Timestamp,
                EventType: r.EventType,
                UserId: r.UserId,
                Username: r.Username,
                IpAddress: r.IpAddress,
                Details: r.Details))
            .ToList();
    }

    public async Task<IReadOnlyList<string>> ListEventTypesAsync(CancellationToken ct = default)
    {
        return await _db.AuditEvents
            .Select(e => e.EventType)
            .Distinct()
            .OrderBy(t => t)
            .ToListAsync(ct);
    }
}
