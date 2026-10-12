using System.Globalization;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using NoteControl.Server.Options;

namespace NoteControl.Server.Backups.Services;

/// <summary>
/// Background service that runs the daily backup at the configured
/// time. Wakes up periodically, checks whether "now" has crossed
/// the configured time-of-day since the last run, and if so kicks
/// off a backup.
/// <para>
/// <c>DailyTime</c> is the server machine's LOCAL time of day (the
/// tray field says so). It used to be read as UTC, so "03:30" ran at
/// 05:30 in Danish summer time.
/// </para>
/// <para>
/// Missed-run policy: <strong>skip silently</strong>. If the
/// server was off at 03:30 and starts at 09:00, we don't run
/// retroactively — we just wait until the next 03:30. But a server
/// that starts BEFORE today's slot (e.g. a 03:00 Windows Update
/// reboot with a 03:30 slot) still runs today; previously the
/// start day was always skipped.
/// </para>
/// <para>
/// Concurrency: <see cref="IBackupService.RunNowAsync"/> already
/// has its own single-permit lock, so a manual run-now in flight
/// when our timer fires causes the timer's call to return
/// "already running" — which we log and forget.
/// </para>
/// </summary>
public sealed class BackupScheduler : BackgroundService
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromMinutes(1);

    private readonly IServiceProvider _services;
    private readonly IOptionsMonitor<BackupOptions> _options;
    private readonly TimeProvider _time;
    private readonly ILogger<BackupScheduler> _log;

    // We track the most recent (local) date on which we kicked off a
    // scheduled run — or decided that day's slot was missed — so we
    // fire at most once per day.
    private DateOnly? _lastFiredDate;

    public BackupScheduler(
        IServiceProvider services,
        IOptionsMonitor<BackupOptions> options,
        TimeProvider time,
        ILogger<BackupScheduler> log)
    {
        _services = services;
        _options = options;
        _time = time;
        _log = log;
    }

    /// <summary>
    /// The "already handled" date to start with. If today's slot is
    /// still ahead, yesterday — so today's run happens. If it has
    /// passed (server started at 14:00 for a 03:30 slot), today — the
    /// missed run is skipped, not run late. Pure; unit-tested.
    /// </summary>
    public static DateOnly InitialLastFiredDate(DateTime nowLocal, string dailyTime)
    {
        var today = DateOnly.FromDateTime(nowLocal);
        if (!TryParseHhmm(dailyTime, out var hour, out var minute)) return today;
        var slot = today.ToDateTime(new TimeOnly(hour, minute));
        return nowLocal < slot ? today.AddDays(-1) : today;
    }

    /// <summary>
    /// Should a tick at <paramref name="nowLocal"/> fire? True once
    /// the local time of day has reached the slot on a day that
    /// hasn't been handled yet. Pure; unit-tested.
    /// </summary>
    public static bool ShouldFire(DateTime nowLocal, DateOnly? lastFiredDate, int hour, int minute)
    {
        var today = DateOnly.FromDateTime(nowLocal);
        if (lastFiredDate.HasValue && lastFiredDate.Value >= today) return false;
        return nowLocal >= today.ToDateTime(new TimeOnly(hour, minute));
    }

    private DateTime NowLocal() => _time.GetLocalNow().DateTime;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _log.LogInformation("BackupScheduler started.");

        // See InitialLastFiredDate: skip today's slot only if it has
        // already passed at startup.
        _lastFiredDate = InitialLastFiredDate(NowLocal(), _options.CurrentValue.DailyTime);

        try
        {
            using var timer = new PeriodicTimer(PollInterval);
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await TickAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown.
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "BackupScheduler loop crashed.");
        }
    }

    private async Task TickAsync(CancellationToken ct)
    {
        var opts = _options.CurrentValue;
        if (!opts.Enabled) return;

        if (!TryParseHhmm(opts.DailyTime, out var hour, out var minute))
        {
            _log.LogWarning(
                "BackupScheduler: invalid DailyTime '{Value}', skipping.",
                opts.DailyTime);
            return;
        }

        var nowLocal = NowLocal();
        if (!ShouldFire(nowLocal, _lastFiredDate, hour, minute)) return;

        // Fire. Mark the date BEFORE we await so a slow run doesn't
        // double-trigger from a subsequent tick.
        _lastFiredDate = DateOnly.FromDateTime(nowLocal);
        _log.LogInformation(
            "BackupScheduler firing: scheduled time {Time} (server local time) has passed.",
            opts.DailyTime);

        try
        {
            // Resolve the engine from a fresh DI scope — we don't
            // want to capture services for the lifetime of the
            // scheduler.
            await using var scope = _services.CreateAsyncScope();
            var engine = scope.ServiceProvider.GetRequiredService<IBackupService>();
            var audit = scope.ServiceProvider.GetRequiredService<NoteControl.Server.Audit.IAuditLog>();
            var result = await engine.RunNowAsync(ct);

            if (result.Success)
            {
                _log.LogInformation(
                    "Scheduled backup {Id} succeeded ({Bytes} bytes, {Ms} ms).",
                    result.BackupId, result.BytesCopied, result.DurationMs);
            }
            else
            {
                _log.LogWarning(
                    "Scheduled backup failed: {Error}",
                    result.Error);
            }

            // Audit the run with userId=null (no human triggered it)
            // and trigger="scheduled" so the Logs window can tell
            // the manual + scheduled flavours apart.
            await audit.WriteAsync(
                NoteControl.Server.Audit.AuditEventTypes.BackupRun,
                userId: null,
                ipAddress: null,
                details: new
                {
                    trigger = "scheduled",
                    success = result.Success,
                    backupId = result.BackupId,
                    bytes = result.BytesCopied,
                    durationMs = result.DurationMs,
                    error = result.Error,
                },
                ct);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Scheduled backup threw.");
        }
    }

    /// <summary>
    /// Parse "HH:MM" into hour + minute. Tight regex would be
    /// nicer but Int32.TryParse is plenty for two pre-validated
    /// fragments.
    /// </summary>
    private static bool TryParseHhmm(string s, out int hour, out int minute)
    {
        hour = 0; minute = 0;
        if (string.IsNullOrEmpty(s)) return false;
        var parts = s.Split(':');
        if (parts.Length != 2) return false;
        if (!int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out hour)) return false;
        if (!int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out minute)) return false;
        return hour is >= 0 and < 24 && minute is >= 0 and < 60;
    }
}
