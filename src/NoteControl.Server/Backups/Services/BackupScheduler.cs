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
/// Missed-run policy: <strong>skip silently</strong>. If the
/// server was off at 03:30 and starts at 09:00, we don't run
/// retroactively — we just wait until the next 03:30.
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
    private readonly ILogger<BackupScheduler> _log;

    // We track the most recent date on which we successfully kicked
    // off a scheduled run, so we don't fire repeatedly within the
    // same day if the scheduled time has already passed at startup.
    // Stored as DateOnly UTC.
    private DateOnly? _lastFiredDate;

    public BackupScheduler(
        IServiceProvider services,
        IOptionsMonitor<BackupOptions> options,
        ILogger<BackupScheduler> log)
    {
        _services = services;
        _options = options;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _log.LogInformation("BackupScheduler started.");

        // Initialise _lastFiredDate to "today" so we don't fire on
        // the first poll when the user just started the server at
        // 14:00 and the scheduled time is 03:30 (already past, but
        // not "missed" in any actionable sense — we only run new
        // scheduled times going forward).
        _lastFiredDate = DateOnly.FromDateTime(DateTime.UtcNow);

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

        var nowUtc = DateTime.UtcNow;
        var todayUtc = DateOnly.FromDateTime(nowUtc);

        // Have we already fired today? (Either via our own
        // scheduler, or because we just bumped the date marker.)
        if (_lastFiredDate.HasValue && _lastFiredDate.Value >= todayUtc) return;

        // Has the configured time-of-day passed for today?
        var scheduledToday = new DateTime(
            nowUtc.Year, nowUtc.Month, nowUtc.Day, hour, minute, 0, DateTimeKind.Utc);
        if (nowUtc < scheduledToday) return;

        // Fire. Mark the date BEFORE we await so a slow run doesn't
        // double-trigger from a subsequent tick.
        _lastFiredDate = todayUtc;
        _log.LogInformation(
            "BackupScheduler firing: scheduled time {Time} UTC has passed.",
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
