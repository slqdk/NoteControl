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

        // Auth
        IdleTimeoutBox.Text = c.Auth.IdleTimeoutMinutes.ToString(CultureInfo.InvariantCulture);
        AbsoluteTimeoutBox.Text = c.Auth.AbsoluteTimeoutMinutes.ToString(CultureInfo.InvariantCulture);
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
            var auth = new AuthConfigDto(
                IdleTimeoutMinutes: ParseInt(IdleTimeoutBox, "Idle timeout"),
                AbsoluteTimeoutMinutes: ParseInt(AbsoluteTimeoutBox, "Absolute lifetime"),
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

    private static string GetComboString(ComboBox combo, string fallback)
    {
        return (combo.SelectedItem is ComboBoxItem item)
            ? (string?)item.Content ?? fallback
            : fallback;
    }
}
