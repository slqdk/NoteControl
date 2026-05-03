using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using NoteControl.Shared.Admin;
using NoteControl.Tray.Admin.Client;

namespace NoteControl.Tray.Admin.Windows;

/// <summary>
/// The Logs window. Two tabs:
/// <list type="bullet">
///   <item><b>Audit</b> — structured user-action events from the
///     <c>audit_events</c> table (logins, vault changes, note
///     creates/deletes/moves, settings/backup ops).</item>
///   <item><b>Server log</b> — tail of the latest Serilog file on
///     disk. Useful for debugging "what broke" rather than "what
///     happened."</item>
/// </list>
/// <para>
/// Each tab has its own filter row + Refresh button. An auto-refresh
/// checkbox at the top polls every 5 seconds while ticked.
/// </para>
/// </summary>
public partial class LogsWindow : Window
{
    private readonly IAdminClient _client;
    private readonly DispatcherTimer _autoRefresh;
    private bool _isLoadingAudit;
    private bool _isLoadingLog;

    // Cache the full server-log result so changing the level / text
    // filter doesn't require a server round-trip — the data is
    // already on the client.
    private IReadOnlyList<ServerLogLineDto> _serverLogCache = Array.Empty<ServerLogLineDto>();

    private static readonly Dictionary<string, int> LevelOrder = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Verbose"]     = 0,
        ["Debug"]       = 1,
        ["Information"] = 2,
        ["Warning"]     = 3,
        ["Error"]       = 4,
        ["Fatal"]       = 5,
    };

    public LogsWindow(IAdminClient client)
    {
        _client = client;
        InitializeComponent();

        _autoRefresh = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        _autoRefresh.Tick += async (_, _) => await RefreshActiveTabAsync();

        Loaded += async (_, _) =>
        {
            await LoadAuditEventTypesAsync();
            await RefreshAuditAsync();
        };
        Closed += (_, _) => _autoRefresh.Stop();
    }

    // -------------------------------------------------------------
    // Tab switch + auto-refresh
    // -------------------------------------------------------------

    private async void Tabs_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        // Tabs_SelectionChanged fires during InitializeComponent before
        // the controls inside the new tab are realised. Guard by
        // checking IsLoaded — once the window is done loading, the
        // event reflects a real user click.
        if (!IsLoaded) return;
        if (!ReferenceEquals(e.OriginalSource, Tabs)) return; // ignore inner DataGrid selection bubbles
        await RefreshActiveTabAsync();
    }

    private void AutoRefreshBox_Click(object sender, RoutedEventArgs e)
    {
        if (AutoRefreshBox.IsChecked == true) _autoRefresh.Start();
        else _autoRefresh.Stop();
    }

    private async Task RefreshActiveTabAsync()
    {
        if (Tabs.SelectedIndex == 0) await RefreshAuditAsync();
        else await RefreshServerLogAsync();
    }

    // -------------------------------------------------------------
    // Audit tab
    // -------------------------------------------------------------

    private async Task LoadAuditEventTypesAsync()
    {
        try
        {
            var types = await _client.ListAuditEventTypesAsync();
            // Build dropdown items: "(any)" + the distinct list.
            AuditEventTypeBox.Items.Clear();
            AuditEventTypeBox.Items.Add(new ComboBoxItem { Content = "(any)" });
            foreach (var t in types)
            {
                AuditEventTypeBox.Items.Add(new ComboBoxItem { Content = t });
            }
            AuditEventTypeBox.SelectedIndex = 0;
        }
        catch (AdminClientException ex)
        {
            StatusText.Text = "Could not load event types: " + ex.Message;
        }
    }

    private async Task RefreshAuditAsync()
    {
        if (_isLoadingAudit) return;
        _isLoadingAudit = true;
        StatusText.Text = "Loading audit log…";
        try
        {
            DateTimeOffset? since = null;
            if (!string.IsNullOrWhiteSpace(AuditSinceBox.Text))
            {
                if (DateTimeOffset.TryParse(
                    AuditSinceBox.Text, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out var parsed))
                {
                    since = parsed;
                }
                else
                {
                    StatusText.Text = "Could not parse 'Since' date — ignored. Use ISO format like 2026-04-30T00:00:00Z.";
                }
            }

            string? eventType = null;
            if (AuditEventTypeBox.SelectedItem is ComboBoxItem item
                && item.Content is string s
                && s != "(any)")
            {
                eventType = s;
            }

            int limit = 200;
            if (int.TryParse(AuditLimitBox.Text, out var l) && l > 0) limit = Math.Min(l, 200);

            var rows = await _client.QueryAuditAsync(since, until: null, userId: null, eventType: eventType, limit, default);
            ApplyAudit(rows);
            StatusText.Text = $"{rows.Count} audit row(s).";
        }
        catch (AdminClientException ex)
        {
            StatusText.Text = "Audit query failed: " + ex.Message;
        }
        finally
        {
            _isLoadingAudit = false;
        }
    }

    private void ApplyAudit(IReadOnlyList<AuditEntryDto> rows)
    {
        var vms = rows.Select(r => new AuditRow
        {
            Source = r,
            TimestampDisplay = r.Timestamp.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss"),
            EventType = r.EventType,
            UserDisplay = r.Username ?? (r.UserId.HasValue ? r.UserId.Value.ToString() : "(system)"),
            IpAddress = r.IpAddress ?? "",
            Details = r.Details ?? "",
        }).ToList();
        AuditGrid.ItemsSource = vms;
    }

    private async void AuditRefreshButton_Click(object sender, RoutedEventArgs e)
    {
        await RefreshAuditAsync();
    }

    // -------------------------------------------------------------
    // Server log tab
    // -------------------------------------------------------------

    private async Task RefreshServerLogAsync()
    {
        if (_isLoadingLog) return;
        _isLoadingLog = true;
        StatusText.Text = "Loading server log…";
        try
        {
            int lines = 500;
            if (int.TryParse(LogLinesBox.Text, out var n) && n > 0) lines = Math.Min(n, 5000);

            var tail = await _client.TailServerLogAsync(lines);
            _serverLogCache = tail.Lines;
            LogPathText.Text = tail.LogFilePath ?? "";
            ApplyLogFilter();

            if (!string.IsNullOrEmpty(tail.Note))
            {
                StatusText.Text = tail.Note;
            }
            else
            {
                StatusText.Text = $"{tail.Lines.Count} log line(s) loaded.";
            }
        }
        catch (AdminClientException ex)
        {
            StatusText.Text = "Log tail failed: " + ex.Message;
        }
        finally
        {
            _isLoadingLog = false;
        }
    }

    /// <summary>
    /// Apply the level + contains filter to the cached server log
    /// without going back to the server. Cheap, instant.
    /// </summary>
    private void ApplyLogFilter()
    {
        var minLevel = (LogLevelBox.SelectedItem is ComboBoxItem c && c.Content is string lvl) ? lvl : "Information";
        if (!LevelOrder.TryGetValue(minLevel, out var minRank)) minRank = 2; // Information
        var contains = LogContainsBox.Text?.Trim() ?? "";

        var filtered = _serverLogCache.Where(line =>
        {
            // Drop unparseable / empty levels (the regex didn't match
            // and the line was surfaced raw). Show them anyway — they
            // might be relevant exception traces.
            if (LevelOrder.TryGetValue(line.Level, out var lineRank)
                && lineRank < minRank)
            {
                return false;
            }
            if (contains.Length > 0
                && line.Message.IndexOf(contains, StringComparison.OrdinalIgnoreCase) < 0)
            {
                return false;
            }
            return true;
        });

        var vms = filtered.Select(line => new LogRow
        {
            Source = line,
            TimestampDisplay = line.Timestamp == default
                ? ""
                : line.Timestamp.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss.fff"),
            Level = line.Level,
            Message = line.Message,
        }).ToList();
        LogGrid.ItemsSource = vms;
    }

    private async void LogRefreshButton_Click(object sender, RoutedEventArgs e)
    {
        await RefreshServerLogAsync();
    }

    /// <summary>Re-applies filters; doesn't hit the server.</summary>
    private void LogFilterChanged(object sender, RoutedEventArgs e)
    {
        if (!IsLoaded) return;
        ApplyLogFilter();
    }

    // -------------------------------------------------------------
    // Misc
    // -------------------------------------------------------------

    private void CloseButton_Click(object sender, RoutedEventArgs e) => Close();

    /// <summary>Row VM for the audit DataGrid.</summary>
    private sealed class AuditRow
    {
        public AuditEntryDto Source { get; set; } = default!;
        public string TimestampDisplay { get; set; } = "";
        public string EventType { get; set; } = "";
        public string UserDisplay { get; set; } = "";
        public string IpAddress { get; set; } = "";
        public string Details { get; set; } = "";
    }

    /// <summary>Row VM for the server-log DataGrid.</summary>
    private sealed class LogRow
    {
        public ServerLogLineDto Source { get; set; } = default!;
        public string TimestampDisplay { get; set; } = "";
        public string Level { get; set; } = "";
        public string Message { get; set; } = "";
    }
}
