using System.Globalization;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using NoteControl.Shared.Admin;
using NoteControl.Tray.Admin.Client;

namespace NoteControl.Tray.Admin.Windows;

/// <summary>
/// Tabbed editor for the Server Settings file. Loads the current
/// effective config from the server, lets the admin tweak Auth,
/// SMTP, Backup and Logging sections, and writes back. Storage and
/// Network tabs are read-only — see the explanations on each tab.
/// </summary>
public partial class ServerSettingsWindow : Window
{
    private readonly IAdminClient _client;
    private ServerConfigDto? _current;
    private bool _isBusy;

    public ServerSettingsWindow(IAdminClient client)
    {
        _client = client;
        InitializeComponent();
        Loaded += async (_, _) => await ReloadAsync();
    }

    // ---------------------------------------------------------------
    // Load
    // ---------------------------------------------------------------

    private async Task ReloadAsync()
    {
        if (_isBusy) return;
        SetBusy(true, "Loading…");
        try
        {
            _current = await _client.GetServerConfigAsync();
            ApplyToUi(_current);
            SetBusy(false, "");
        }
        catch (AdminClientException ex)
        {
            SetBusy(false, "");
            MessageBox.Show(this, "Could not load settings: " + ex.Message,
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void ApplyToUi(ServerConfigDto c)
    {
        // Storage (read-only)
        DataRootBox.Text = c.Storage.DataRoot;
        ConfigFileBox.Text = c.Storage.ConfigFilePath;

        // Network. Bind URL is derived (read-only), but ExposeOnLan,
        // Port and PublicUrl are editable. LanUrls is the list of
        // detected private LAN URLs the user can paste into another
        // device.
        BindUrlBox.Text = c.Network.BindUrl;
        ExposeOnLanCheckbox.IsChecked = c.Network.ExposeOnLan;
        PortBox.Text = c.Network.Port.ToString(CultureInfo.InvariantCulture);
        LanUrlsBox.Text = c.Network.LanUrls.Count == 0
            ? "(no non-loopback IPv4 interfaces detected)"
            : string.Join(Environment.NewLine, c.Network.LanUrls);
        PublicUrlBox.Text = c.Network.PublicUrl;

        // Ship 93: HTTPS hostname list, one per line. Empty config →
        // empty box (placeholder text shows the user what to enter).
        PublicHostnamesBox.Text = c.Network.PublicHostnames.Count == 0
            ? string.Empty
            : string.Join(Environment.NewLine, c.Network.PublicHostnames);

        // Auth — session timeouts are sliders (hours / days). The
        // ValueChanged handlers refresh the side labels automatically
        // once the new values land.
        //
        // Persisted values are minutes. Convert to slider units by
        // rounding to the nearest whole unit, then clamp into the
        // slider's range. The slider's Min/Max already match the
        // server's validation caps, so this clamp can only fire on
        // a hand-edited config.json with out-of-cap values (i.e.
        // never via this UI). When that happens we'd rather show a
        // sensible position than throw.
        IdleTimeoutSlider.Value = ClampToRange(
            (int)Math.Round(c.Auth.IdleTimeoutMinutes / 60.0),
            (int)IdleTimeoutSlider.Minimum,
            (int)IdleTimeoutSlider.Maximum);
        AbsoluteTimeoutSlider.Value = ClampToRange(
            (int)Math.Round(c.Auth.AbsoluteTimeoutMinutes / 1440.0),
            (int)AbsoluteTimeoutSlider.Minimum,
            (int)AbsoluteTimeoutSlider.Maximum);

        // Force a label refresh in case the new Value equals the
        // existing Value (no ValueChanged fired) — happens on the
        // very first load.
        UpdateIdleTimeoutLabel();
        UpdateAbsoluteTimeoutLabel();

        MinPasswordLengthBox.Text = c.Auth.MinimumPasswordLength.ToString(CultureInfo.InvariantCulture);
        CheckHibpBox.IsChecked = c.Auth.CheckPasswordAgainstHibp;
        LoginAttemptsIpBox.Text = c.Auth.LoginAttemptsPerIpPerMinute.ToString(CultureInfo.InvariantCulture);
        LoginAttemptsAccountBox.Text = c.Auth.LoginAttemptsPerAccountPerHour.ToString(CultureInfo.InvariantCulture);
        LockoutMinutesBox.Text = c.Auth.AccountLockoutMinutes.ToString(CultureInfo.InvariantCulture);

        // SMTP
        SmtpEnabledBox.IsChecked = c.Smtp.Enabled;
        SmtpHostBox.Text = c.Smtp.Host;
        SmtpPortBox.Text = c.Smtp.Port.ToString(CultureInfo.InvariantCulture);
        SmtpSecurityBox.SelectedItem = FindComboItem(SmtpSecurityBox, c.Smtp.Security);
        SmtpUsernameBox.Text = c.Smtp.Username;
        SmtpPasswordBox.Password = "";
        SmtpPasswordHint.Text = c.Smtp.HasPassword
            ? "(leave blank to keep current password)"
            : "(no password stored)";
        SmtpFromBox.Text = c.Smtp.FromAddress;
        SmtpFromNameBox.Text = c.Smtp.FromDisplayName;

        // Backup
        BackupEnabledBox.IsChecked = c.Backup.Enabled;
        BackupTargetBox.Text = c.Backup.TargetPath;
        BackupDailyTimeBox.Text = c.Backup.DailyTime;
        BackupRetainDailyBox.Text = c.Backup.RetainDailyCount.ToString(CultureInfo.InvariantCulture);
        BackupRetainWeeklyBox.Text = c.Backup.RetainWeeklyCount.ToString(CultureInfo.InvariantCulture);

        // Logging
        LogLevelBox.SelectedItem = FindComboItem(LogLevelBox, c.Logging.MinimumLevel);
        LogRetainBox.Text = c.Logging.RetainDays.ToString(CultureInfo.InvariantCulture);
    }

    // ---------------------------------------------------------------
    // Save
    // ---------------------------------------------------------------

    /// <summary>
    /// Try to read every field into a ServerConfigDto. Returns null
    /// and shows an error if a numeric / format check fails (we
    /// don't run the server's own validation here — the server will
    /// echo any issues back via 400).
    /// </summary>
    private ServerConfigDto? CollectFromUi()
    {
        if (_current is null) return null;

        try
        {
            // Slider positions are hours (idle) / days (absolute).
            // Convert to minutes — the on-wire unit — at submit time.
            // Math.Round is defensive; the slider's SmallChange/
            // LargeChange snap to whole units, but a stray fractional
            // value could otherwise round-trip as e.g. 11.999 → 11.
            var idleMinutes = (int)Math.Round(IdleTimeoutSlider.Value) * 60;
            var absoluteMinutes = (int)Math.Round(AbsoluteTimeoutSlider.Value) * 1440;

            var auth = new AuthConfigDto(
                IdleTimeoutMinutes: idleMinutes,
                AbsoluteTimeoutMinutes: absoluteMinutes,
                MinimumPasswordLength: ParseInt(MinPasswordLengthBox, "Minimum password length"),
                CheckPasswordAgainstHibp: CheckHibpBox.IsChecked == true,
                LoginAttemptsPerIpPerMinute: ParseInt(LoginAttemptsIpBox, "Login attempts per IP"),
                LoginAttemptsPerAccountPerHour: ParseInt(LoginAttemptsAccountBox, "Login attempts per account"),
                AccountLockoutMinutes: ParseInt(LockoutMinutesBox, "Lockout duration"));

            var smtp = new SmtpConfigDto(
                Enabled: SmtpEnabledBox.IsChecked == true,
                Host: SmtpHostBox.Text.Trim(),
                Port: ParseInt(SmtpPortBox, "SMTP port"),
                Security: GetComboString(SmtpSecurityBox, "STARTTLS"),
                Username: SmtpUsernameBox.Text.Trim(),
                Password: SmtpPasswordBox.Password,    // empty = preserve
                HasPassword: false,                    // ignored on the wire
                FromAddress: SmtpFromBox.Text.Trim(),
                FromDisplayName: SmtpFromNameBox.Text.Trim());

            var backup = new BackupConfigDto(
                Enabled: BackupEnabledBox.IsChecked == true,
                TargetPath: BackupTargetBox.Text.Trim(),
                DailyTime: BackupDailyTimeBox.Text.Trim(),
                RetainDailyCount: ParseInt(BackupRetainDailyBox, "Retain daily count"),
                RetainWeeklyCount: ParseInt(BackupRetainWeeklyBox, "Retain weekly count"));

            var logging = new LoggingConfigDto(
                MinimumLevel: GetComboString(LogLevelBox, "Information"),
                RetainDays: ParseInt(LogRetainBox, "Retain days"));

            // Network. ExposeOnLan, Port and PublicUrl are editable.
            // BindUrl + LanUrls are derived server-side; we send back
            // the values we received (the server ignores them on save
            // but keeping a complete DTO shape is cleaner than
            // sending nulls).
            //
            // Ship 93: also parse PublicHostnames from the multi-line
            // textbox. Each line becomes one hostname; blank lines and
            // surrounding whitespace are stripped. Server-side
            // validation catches malformed entries (the cleaner
            // approach would be to validate here AND server-side, but
            // a single source of truth — server — keeps the rules
            // consistent across CLI / API / hand-edited config.json).
            var hostnames = (PublicHostnamesBox.Text ?? "")
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(line => line.Trim())
                .Where(line => line.Length > 0)
                .ToList();

            var network = new NetworkConfigDto(
                BindUrl: _current.Network.BindUrl,                       // server-derived; pass-through
                ExposeOnLan: ExposeOnLanCheckbox.IsChecked == true,
                Port: ParseInt(PortBox, "Port"),
                LanUrls: _current.Network.LanUrls,                       // server-derived; pass-through
                PublicUrl: PublicUrlBox.Text.Trim(),
                PublicHostnames: hostnames);

            // Storage is read-only; pass it through unchanged.
            return new ServerConfigDto(
                _current.Storage, network,
                auth, smtp, backup, logging);
        }
        catch (FormatException ex)
        {
            MessageBox.Show(this, ex.Message, "NoteControl",
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return null;
        }
    }

    private async void SaveButton_Click(object sender, RoutedEventArgs e)
    {
        await SaveAsync();
    }

    private async Task<bool> SaveAsync()
    {
        var dto = CollectFromUi();
        if (dto is null) return false;

        if (_isBusy) return false;

        // Detect a Network change before the save, so the post-save
        // status message can call out the restart-required nature
        // explicitly. Server-derived fields (BindUrl, LanUrls) are
        // ignored in the comparison since the user can't edit them.
        // _current is non-null at this point (CollectFromUi returns
        // null otherwise).
        var networkChanged = _current is not null && (
            _current.Network.ExposeOnLan != dto.Network.ExposeOnLan
            || _current.Network.Port != dto.Network.Port
            || !string.Equals(_current.Network.PublicUrl, dto.Network.PublicUrl, StringComparison.Ordinal));

        SetBusy(true, "Saving…");
        try
        {
            // Server returns the fresh effective config — re-bind so
            // SMTP HasPassword / Password elision stays in sync.
            _current = await _client.UpdateServerConfigAsync(dto);
            ApplyToUi(_current);
            // Network changes need a server restart -- Kestrel binds at
            // host startup and IOptionsMonitor doesn't move sockets.
            // Other "needs restart" categories (Logging Serilog, Storage)
            // already get the generic message.
            SetBusy(false, networkChanged
                ? "Saved. Network changes need a server restart to apply."
                : "Saved. Some changes apply on next server restart.");
            return true;
        }
        catch (AdminClientException ex)
        {
            SetBusy(false, "");
            MessageBox.Show(this, "Save failed: " + ex.Message, "NoteControl",
                MessageBoxButton.OK, MessageBoxImage.Error);
            return false;
        }
    }

    // ---------------------------------------------------------------
    // SMTP test
    // ---------------------------------------------------------------

    private async void TestSmtpButton_Click(object sender, RoutedEventArgs e)
    {
        var to = SmtpTestToBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(to) || !to.Contains('@'))
        {
            SmtpTestResultText.Text = "Enter a recipient address first.";
            SmtpTestResultText.Foreground = System.Windows.Media.Brushes.OrangeRed;
            return;
        }

        // Save first so the server is testing the on-disk config,
        // not whatever was there before the user tweaked the form.
        if (!await SaveAsync()) return;

        SmtpTestResultText.Text = "Sending…";
        SmtpTestResultText.Foreground = System.Windows.Media.Brushes.Gray;
        try
        {
            var result = await _client.TestSmtpAsync(to);
            if (result.Sent)
            {
                SmtpTestResultText.Text = "✓ Sent. Check the inbox.";
                SmtpTestResultText.Foreground = System.Windows.Media.Brushes.SeaGreen;
            }
            else
            {
                SmtpTestResultText.Text = "✗ " + (result.Error ?? "Unknown error");
                SmtpTestResultText.Foreground = System.Windows.Media.Brushes.OrangeRed;
            }
        }
        catch (AdminClientException ex)
        {
            SmtpTestResultText.Text = "✗ " + ex.Message;
            SmtpTestResultText.Foreground = System.Windows.Media.Brushes.OrangeRed;
        }
    }

    // ---------------------------------------------------------------
    // Misc handlers + helpers
    // ---------------------------------------------------------------

    private async void ReloadButton_Click(object sender, RoutedEventArgs e)
    {
        await ReloadAsync();
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e)
    {
        Close();
    }

    private void SetBusy(bool busy, string statusMessage)
    {
        _isBusy = busy;
        SaveButton.IsEnabled = !busy;
        StatusText.Text = statusMessage;
    }

    /// <summary>Throws FormatException with a nice message on bad input.</summary>
    private static int ParseInt(TextBox box, string label)
    {
        var text = box.Text?.Trim() ?? "";
        if (!int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n))
        {
            throw new FormatException($"{label} must be a whole number.");
        }
        return n;
    }

    /// <summary>
    /// Find the ComboBoxItem whose Content (string) equals
    /// <paramref name="text"/> case-insensitively. Falls back to the
    /// first item if not found.
    /// </summary>
    private static ComboBoxItem FindComboItem(ComboBox combo, string text)
    {
        foreach (var item in combo.Items.OfType<ComboBoxItem>())
        {
            if (string.Equals((string?)item.Content, text, StringComparison.OrdinalIgnoreCase))
            {
                return item;
            }
        }
        return (ComboBoxItem)combo.Items[0]!;
    }

    // ---------------------------------------------------------------
    // Session-timeout sliders
    // ---------------------------------------------------------------

    /// <summary>
    /// Idle slider position changed -- recompute the side label.
    /// Wired in XAML via ValueChanged. WPF calls this once at
    /// InitializeComponent time when the Value default is applied
    /// (before the label field is non-null) -- the null check
    /// shields against that early call.
    /// </summary>
    private void IdleTimeoutSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        UpdateIdleTimeoutLabel();
    }

    private void AbsoluteTimeoutSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        UpdateAbsoluteTimeoutLabel();
    }

    private void UpdateIdleTimeoutLabel()
    {
        if (IdleTimeoutLabel is null) return;
        var hours = (int)Math.Round(IdleTimeoutSlider.Value);
        IdleTimeoutLabel.Text = FormatHoursLabel(hours);
    }

    private void UpdateAbsoluteTimeoutLabel()
    {
        if (AbsoluteTimeoutLabel is null) return;
        var days = (int)Math.Round(AbsoluteTimeoutSlider.Value);
        AbsoluteTimeoutLabel.Text = FormatDaysLabel(days);
    }

    /// <summary>
    /// Render an hour count as a human-readable label with the
    /// minute count in parens. Under 24 h we use "Xh"; from 24 h
    /// upward we shift to "X day(s)" so the unit matches what the
    /// user is thinking about. The minute total is always shown so
    /// the wire value stays visible.
    /// </summary>
    private static string FormatHoursLabel(int hours)
    {
        var minutes = hours * 60;
        string friendly;
        if (hours < 24)
        {
            friendly = hours == 1 ? "1 hour" : $"{hours} hours";
        }
        else
        {
            // Whole-day case (e.g. 24 h = 1 day, 48 h = 2 days). Hours
            // that don't divide evenly into days surface as e.g.
            // "1d 6h" so a slider position is never silently rounded
            // off in the label.
            var days = hours / 24;
            var rem = hours % 24;
            friendly = rem == 0
                ? (days == 1 ? "1 day" : $"{days} days")
                : $"{days}d {rem}h";
        }
        return $"{friendly} ({minutes:N0} min)";
    }

    private static string FormatDaysLabel(int days)
    {
        var minutes = days * 1440;
        string friendly = days switch
        {
            1   => "1 day",
            365 => "365 days (1 year)",
            _   => $"{days} days",
        };
        return $"{friendly} ({minutes:N0} min)";
    }

    /// <summary>
    /// Clamp <paramref name="value"/> into the inclusive range
    /// [<paramref name="min"/>, <paramref name="max"/>]. Used on load
    /// so out-of-cap values from a hand-edited config.json still
    /// render at a sensible slider position rather than throwing.
    /// </summary>
    private static int ClampToRange(int value, int min, int max)
    {
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }

    // ---------------------------------------------------------------

    private static string GetComboString(ComboBox combo, string fallback)
    {
        return (combo.SelectedItem is ComboBoxItem item)
            ? (string?)item.Content ?? fallback
            : fallback;
    }
}
