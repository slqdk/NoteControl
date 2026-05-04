using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using H.NotifyIcon;
using NoteControl.Tray.Admin;
using NoteControl.Tray.Server;
using NoteControl.Tray.Updates;

namespace NoteControl.Tray;

/// <summary>
/// WPF application entry point. The tray icon lives for the lifetime of the
/// Windows session; admin windows (Users, Settings, Logs, etc.) open on demand.
/// </summary>
public partial class App : Application
{
    /// <summary>
    /// Tray URL — resolved from <c>{DataRoot}/.server/server.url</c>
    /// at startup. Step 43 replaced the previous hardcoded
    /// <c>http://127.0.0.1:8080</c> constant with this lookup so the
    /// tray follows whatever port the user configures via Server
    /// Settings. Falls back to the legacy default if the file is
    /// missing (e.g. server hasn't started yet).
    ///
    /// Read ONCE at App startup. If the user changes the port and
    /// restarts the server, they need to restart the tray too —
    /// same constraint as before this fix existed.
    /// </summary>
    private readonly ResolvedUrls _serverUrls = ServerUrlResolver.Resolve();

    private TaskbarIcon? _trayIcon;
    private AdminWorkflow? _admin;
    private readonly ServerController _serverController = new();

    // Step 49: in-app updater. The checker is stateless; we own
    // the latest result here so the menu item can read it on
    // right-click. The timer drives the periodic re-check.
    private readonly UpdateChecker _updateChecker = new();
    private UpdateCheckResult? _latestUpdateCheck;
    private DispatcherTimer? _updateTimer;
    private MenuItem? _updateMenuItem;

    private void OnStartup(object sender, StartupEventArgs e)
    {
        // Ship 66: elevated re-entry hook. When the un-elevated tray
        // hits exit-5 on `sc start/stop`, it relaunches itself with
        // `--service-action <verb>` via Verb=runas. That relaunched
        // process lands here, runs ONLY the sc call, and exits with
        // sc's exit code as its own process exit code. No tray icon,
        // no UI, no message loop hanging around.
        //
        // Contract enforced by caller (ServerController.RunScWithElevationFallback):
        //   - exactly two args: --service-action <verb>
        //   - verb is "start" or "stop"
        // Any other shape we ignore and continue normal startup --
        // future-proofs against accidental flag clashes.
        if (TryHandleServiceActionAndExit(e.Args))
        {
            return;
        }

        _admin = new AdminWorkflow(_serverUrls.TrayUrl);

        _trayIcon = new TaskbarIcon
        {
            ToolTipText = "NoteControl — Starting...",
            ContextMenu = BuildContextMenu()
        };

        _trayIcon.LeftClickCommand = new RelayCommand(OpenWebUi);
        TryLoadIcon(_trayIcon);
        _trayIcon.ForceCreate();
        _trayIcon.ToolTipText = "NoteControl — Running";

        // Surface non-fatal resolver fallbacks to the debug stream
        // so a missing/corrupt server.url is at least visible to
        // someone running the tray under a debugger.
        if (_serverUrls.FallbackReason != FallbackReason.None)
        {
            Debug.WriteLine(
                $"[NoteControl.Tray] server.url fallback: " +
                $"{_serverUrls.FallbackReason} ({_serverUrls.Detail ?? "no detail"}). " +
                $"Using {_serverUrls.TrayUrl}.");
        }

        // Step 49: kick off the first update check shortly after
        // startup so the tray menu is ready quickly without
        // blocking the UI thread on a network call. Then poll
        // every 24 hours while the tray is alive.
        StartUpdateChecks();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _updateTimer?.Stop();
        _admin?.Dispose();
        _trayIcon?.Dispose();
        base.OnExit(e);
    }

    private ContextMenu BuildContextMenu()
    {
        var menu = new ContextMenu();

        var statusItem = new MenuItem { Header = "● Running", IsEnabled = false };
        menu.Items.Add(statusItem);
        menu.Items.Add(new Separator());

        menu.Items.Add(MakeItem("Open in Browser", OpenWebUi));
        menu.Items.Add(new Separator());

        // Wired up.
        menu.Items.Add(MakeItem("Users...",  OpenUsers));
        menu.Items.Add(MakeItem("Vaults...", OpenVaults));

        // Stubs.
        menu.Items.Add(MakeItem("Server Settings...", OpenSettings));
        menu.Items.Add(MakeItem("Logs...",            OpenLogs));
        menu.Items.Add(MakeItem("Backups...",         OpenBackups));
        menu.Items.Add(new Separator());

        // Step 38: Start/Stop/Restart Server now wired. They detect
        // whether the server is running as a Windows Service or as
        // a hand-launched process and act accordingly. See
        // ServerController for the detection + lifecycle logic.
        // Disabled-while-running prevents click-storms during the
        // 15s health-check window when the user keeps clicking.
        menu.Items.Add(MakeItem("Start Server",   StartServer));
        menu.Items.Add(MakeItem("Stop Server",    StopServer));
        menu.Items.Add(MakeItem("Restart Server", RestartServer));
        menu.Items.Add(new Separator());

        // Step 49: update menu item. Starts hidden; gets shown +
        // re-labelled by RefreshUpdateMenu() once the checker has
        // a result. We keep a stable MenuItem reference so the
        // toggle is just a property assignment, no menu rebuild.
        _updateMenuItem = new MenuItem
        {
            Header = "Check for updates...",
            // Visible from the start so users can force a check
            // before the periodic timer fires. Once we have a
            // cached "Update available" result, the header changes.
            Visibility = Visibility.Visible,
        };
        _updateMenuItem.Click += (_, _) => OnUpdateMenuClicked();
        menu.Items.Add(_updateMenuItem);

        menu.Items.Add(MakeItem("About",     OpenAbout));
        menu.Items.Add(MakeItem("Quit Tray", QuitTray));

        return menu;
    }

    private static MenuItem MakeItem(string header, Action action)
    {
        var item = new MenuItem { Header = header };
        item.Click += (_, _) => action();
        return item;
    }

    private static MenuItem MakeDisabledItem(string header, string tooltip)
        => new() { Header = header, IsEnabled = false, ToolTip = tooltip };

    // -----------------------------------------------------------------------
    // Command handlers.
    // -----------------------------------------------------------------------

    private void OpenWebUi()
    {
        // Step 43: use the resolved tray URL instead of a hardcoded
        // 127.0.0.1:8080. This is loopback (always) at the actually-
        // configured port. Trailing slash makes some browsers happier
        // about the URL bar layout.
        var url = _serverUrls.TrayUrl.TrimEnd('/') + "/";
        Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
    }

    private async void OpenUsers()
    {
        if (_admin is null) return;
        try { await _admin.OpenUsersAsync(); }
        catch (Exception ex)
        {
            MessageBox.Show("Could not open the Users window: " + ex.Message,
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async void OpenVaults()
    {
        if (_admin is null) return;
        try { await _admin.OpenVaultsAsync(); }
        catch (Exception ex)
        {
            MessageBox.Show("Could not open the Vaults window: " + ex.Message,
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async void OpenSettings()
    {
        if (_admin is null) return;
        try { await _admin.OpenSettingsAsync(); }
        catch (Exception ex)
        {
            MessageBox.Show("Could not open the Settings window: " + ex.Message,
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async void OpenBackups()
    {
        if (_admin is null) return;
        try { await _admin.OpenBackupsAsync(); }
        catch (Exception ex)
        {
            MessageBox.Show("Could not open the Backups window: " + ex.Message,
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async void OpenLogs()
    {
        if (_admin is null) return;
        try { await _admin.OpenLogsAsync(); }
        catch (Exception ex)
        {
            MessageBox.Show("Could not open the Logs window: " + ex.Message,
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async void OpenAbout()
    {
        if (_admin is null) return;
        try { await _admin.OpenAboutAsync(); }
        catch (Exception ex)
        {
            MessageBox.Show("Could not open the About window: " + ex.Message,
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    // -----------------------------------------------------------------------
    // Server lifecycle handlers (step 38).
    //
    // All three follow the same pattern:
    //   1. Update tooltip so the user can see "in progress" if they
    //      hover the icon during the operation.
    //   2. Run the operation on a background thread (the start/stop
    //      can take 15+ seconds while waiting for /health) so the WPF
    //      message pump stays responsive.
    //   3. Show success/failure via MessageBox. We don't currently
    //      use tray balloons because Windows 11 throttles them
    //      aggressively and they're easy to miss.
    //   4. Restore the tooltip.
    //
    // We use `async void` here because these are event handlers; the
    // alternative (Task-returning handler + .ConfigureAwait wrappers)
    // doesn't gain anything in a UI-only path.
    // -----------------------------------------------------------------------

    private async void StartServer()      => await RunServerOpAsync("Starting",   _serverController.StartAsync);
    private async void StopServer()       => await RunServerOpAsync("Stopping",   _serverController.StopAsync);
    private async void RestartServer()    => await RunServerOpAsync("Restarting", _serverController.RestartAsync);

    private async Task RunServerOpAsync(
        string verb,
        Func<CancellationToken, Task<OperationResult>> op)
    {
        var originalTooltip = _trayIcon?.ToolTipText ?? "NoteControl";
        if (_trayIcon is not null)
        {
            _trayIcon.ToolTipText = $"NoteControl — {verb}...";
        }

        OperationResult result;
        try
        {
            // Cap the whole operation. Restart can legitimately take
            // 15s for stop + 15s for start; 60s is generous but bounded.
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            result = await Task.Run(() => op(cts.Token), cts.Token);
        }
        catch (OperationCanceledException)
        {
            result = OperationResult.Fail($"{verb} timed out after 60 seconds.");
        }
        catch (Exception ex)
        {
            result = OperationResult.Fail($"{verb} failed: {ex.Message}");
        }
        finally
        {
            if (_trayIcon is not null)
            {
                _trayIcon.ToolTipText = originalTooltip;
            }
        }

        if (!result.Success)
        {
            MessageBox.Show(
                result.Message,
                $"NoteControl — {verb} server",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
        // No popup on success — silent operations feel snappier.
        // The tray tooltip already changed back, and the user can
        // verify by left-clicking to open the browser.
    }

    private static void QuitTray() => Current.Shutdown();

    private static void NotImplemented(string feature)
    {
        MessageBox.Show(
            $"{feature} is not implemented yet.\n\nThis window will be built in a later milestone.",
            "NoteControl",
            MessageBoxButton.OK,
            MessageBoxImage.Information);
    }

    // -----------------------------------------------------------------------
    // Step 49: update checking.
    // -----------------------------------------------------------------------

    /// <summary>
    /// Schedule an immediate check (running async on the thread pool)
    /// plus a recurring timer for the lifetime of the tray. The
    /// initial check is delayed slightly so the tray UI shows up
    /// fast even on a slow network.
    /// </summary>
    private void StartUpdateChecks()
    {
        // Delay the first check by a couple of seconds so the tray
        // is visibly "Running" before we hit the network. WPF
        // DispatcherTimer is fine for this -- it fires on the UI
        // thread, but the actual check runs on Task.Run inside.
        _updateTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        var firstFireDone = false;
        _updateTimer.Tick += async (_, _) =>
        {
            // After the first tick, switch the interval to the
            // long polling period.
            if (!firstFireDone)
            {
                _updateTimer!.Interval = UpdateConfig.PollInterval;
                firstFireDone = true;
            }
            await RunUpdateCheckAsync(silent: true);
        };
        _updateTimer.Start();
    }

    /// <summary>
    /// Run a single update check and refresh the menu state. When
    /// silent=true (the periodic poll), no UI is shown for "no update"
    /// or errors. When silent=false (user clicked the menu manually),
    /// we surface a message either way so they know the click did
    /// something.
    /// </summary>
    private async Task RunUpdateCheckAsync(bool silent)
    {
        UpdateCheckResult result;
        try
        {
            result = await Task.Run(() => _updateChecker.CheckAsync()).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Defensive: CheckAsync is supposed to swallow its own
            // exceptions, but a programming error in the checker
            // shouldn't take the tray down with it.
            Debug.WriteLine($"[NoteControl.Tray] Unexpected update check failure: {ex}");
            result = UpdateCheckResult.NoUpdate("Update check failed unexpectedly.");
        }

        _latestUpdateCheck = result;

        // Marshal back to UI thread to update the menu.
        await Dispatcher.InvokeAsync(() =>
        {
            RefreshUpdateMenu();

            if (!silent)
            {
                // Manual check: show a result either way.
                if (result.UpdateAvailable)
                {
                    OpenUpdateDialog(result);
                }
                else
                {
                    MessageBox.Show(
                        result.Status,
                        "NoteControl — Check for updates",
                        MessageBoxButton.OK,
                        MessageBoxImage.Information);
                }
            }
        });
    }

    /// <summary>
    /// Apply the current cached update-check result to the menu
    /// item label and visibility. Called after every check finishes.
    /// </summary>
    private void RefreshUpdateMenu()
    {
        if (_updateMenuItem is null) return;

        var result = _latestUpdateCheck;
        if (result is null)
        {
            _updateMenuItem.Header = "Check for updates...";
            return;
        }

        if (result.UpdateAvailable && result.Latest is not null)
        {
            _updateMenuItem.Header = $"Update available: {result.Latest}";
            _updateMenuItem.FontWeight = FontWeights.SemiBold;
        }
        else
        {
            _updateMenuItem.Header = "Check for updates...";
            _updateMenuItem.FontWeight = FontWeights.Normal;
        }
    }

    /// <summary>
    /// Click handler for the dynamic update menu item. If we have
    /// a cached "update available" result, open the dialog
    /// directly. Otherwise force a fresh check (which itself opens
    /// the dialog if it finds an update).
    /// </summary>
    private async void OnUpdateMenuClicked()
    {
        if (_latestUpdateCheck is { UpdateAvailable: true })
        {
            OpenUpdateDialog(_latestUpdateCheck);
            return;
        }
        // No cached update. Re-check on demand. silent=false means
        // we show a "Up to date" / error message instead of nothing.
        await RunUpdateCheckAsync(silent: false);
    }

    /// <summary>
    /// Public so the AboutWindow's "Check for updates" button can
    /// trigger the same flow. Returns the cached result if we
    /// have one; otherwise runs a fresh check synchronously
    /// (well, async-but-awaited). Internal so AboutWindow's
    /// internal-typed parameter keeps things contained.
    /// </summary>
    internal async Task TriggerManualUpdateCheckAsync()
    {
        await RunUpdateCheckAsync(silent: false);
    }

    private void OpenUpdateDialog(UpdateCheckResult result)
    {
        try
        {
            var win = new UpdateWindow(result)
            {
                // Owner = none -- it's a top-level dialog reachable
                // from a tray menu, not from another window.
            };
            win.ShowDialog();
        }
        catch (Exception ex)
        {
            MessageBox.Show("Could not open the update dialog: " + ex.Message,
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    /// <summary>
    /// Ship 66: handle the elevated-child entry point. Returns true
    /// if the args matched and the application has been told to
    /// shut down (caller should bail out of startup); false to
    /// continue normal tray startup.
    ///
    /// What this does on a hit:
    ///   1. Run `sc.exe &lt;verb&gt; NoteControlServer` directly.
    ///   2. Set Environment.ExitCode to sc's exit code so the
    ///      un-elevated parent can read it via Process.ExitCode.
    ///   3. Call Shutdown() to dismantle the (still-empty) WPF app.
    ///
    /// We do NOT instantiate the tray icon, admin workflow, or
    /// updater. This is a 200-millisecond invisible side-process,
    /// not a second tray. The user sees only the original tray's
    /// "Restarting..." tooltip until the parent's WaitForExit
    /// returns.
    ///
    /// Why not Application.Current.Shutdown(0): the message loop
    /// hasn't actually been pumped yet at this point in OnStartup,
    /// so Shutdown is queued. Returning from OnStartup lets WPF
    /// process the queued shutdown immediately. The exit code we
    /// want is on Environment.ExitCode by the time the runtime
    /// terminates the process.
    ///
    /// Process.Start with sc.exe must use UseShellExecute=false
    /// here (we're already elevated by Verb=runas one level up).
    /// CreateNoWindow=true keeps the brief sc console invisible.
    /// </summary>
    private bool TryHandleServiceActionAndExit(string[] args)
    {
        // Expected: ["--service-action", "start" | "stop"]
        if (args.Length != 2 || args[0] != "--service-action") return false;

        var verb = args[1];
        if (verb is not ("start" or "stop")) return false;

        int scExit;
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "sc.exe",
                Arguments = $"{verb} {ServerController.ServiceName}",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var proc = Process.Start(psi);
            if (proc is null)
            {
                scExit = -1;
            }
            else
            {
                // Drain pipes before WaitForExit (deadlock-avoidance,
                // same pattern as ServerController.RunSc).
                _ = proc.StandardOutput.ReadToEnd();
                _ = proc.StandardError.ReadToEnd();
                proc.WaitForExit(30000);
                scExit = proc.HasExited ? proc.ExitCode : -1;
            }
        }
        catch (Exception ex)
        {
            // We can't show a MessageBox here -- the parent is
            // waiting on us. Best we can do is a Debug write
            // (visible to anyone running with a debugger / DebugView)
            // and a generic non-zero exit code so the parent
            // surfaces a failure.
            Debug.WriteLine($"[NoteControl.Tray] --service-action {verb} threw: {ex}");
            scExit = -1;
        }

        Environment.ExitCode = scExit;
        Shutdown(scExit);
        return true;
    }

    /// <summary>
    /// Load the tray icon from embedded resources. The resource is
    /// declared in the .csproj as <c>&lt;Resource&gt;</c>, which makes it
    /// addressable via the pack:// URI scheme. We log the failure
    /// to the debug output instead of swallowing it silently —
    /// past life: the silent catch hid a missing resource for
    /// months and the tray shipped with no icon.
    ///
    /// If the icon can't be loaded, the tray still shows up (with
    /// the OS default placeholder); the user can right-click to
    /// access the menu either way. So a load failure is a
    /// cosmetic regression, not a fatal one.
    /// </summary>
    private static void TryLoadIcon(TaskbarIcon icon)
    {
        try
        {
            var uri = new Uri("pack://application:,,,/Resources/tray.ico", UriKind.Absolute);
            icon.IconSource = new BitmapImage(uri);
        }
        catch (Exception ex)
        {
            // Surfaced in the VS Output window when running from F5;
            // not visible at runtime in a packaged build, but shows
            // up via DebugView / ETW if anyone goes hunting. Better
            // than silent swallow.
            Debug.WriteLine($"[NoteControl.Tray] Icon load failed: {ex}");
        }
    }
}

internal sealed class RelayCommand : System.Windows.Input.ICommand
{
    private readonly Action _action;
    public RelayCommand(Action action) => _action = action;
    public event EventHandler? CanExecuteChanged { add { } remove { } }
    public bool CanExecute(object? parameter) => true;
    public void Execute(object? parameter) => _action();
}
