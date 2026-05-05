using System.Diagnostics;
using System.IO;
using System.Reflection;
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
        // Ship 96: crash logging. Wire global exception handlers FIRST,
        // before anything else can throw. Pre-Ship-96 a startup failure
        // (anywhere in OnStartup, or any unhandled exception in any
        // async handler later) killed the tray process silently with
        // no log on disk and no UI: the user just saw "no tray icon"
        // and had to reboot to recover. The handlers below write a
        // crash file to %LOCALAPPDATA%\NoteControl\tray-crash-{date}.log
        // so a future failure leaves a usable diagnostic trail.
        //
        // We register handlers here (not in App.xaml or a static
        // constructor) because:
        //   - DispatcherUnhandledException needs the Dispatcher to exist,
        //     which it does by the time OnStartup is called.
        //   - Static ctors run before WPF infrastructure is initialised
        //     and can't safely interact with Application.Current.
        // Hooks must be set before any code that might throw runs;
        // hence "first thing in OnStartup" is the right anchor.
        CrashLogger.Initialise();
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += OnAppDomainUnhandledException;
        System.Threading.Tasks.TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;

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

        // Ship 96: wrap the rest of startup in a try/catch so any
        // exception during tray initialisation surfaces as a crash
        // log + visible error dialog instead of a silent process
        // death. Without this, an unhandled exception during tray
        // init landed in OnDispatcherUnhandledException -- but the
        // handler runs INSIDE the Dispatcher pump, which hasn't
        // been started yet during OnStartup, so the handler's
        // log-write happened but the user-visible MessageBox in
        // it never displayed. Catching here lets us show the
        // dialog directly off the startup thread.
        try
        {
            BootstrapTray();
        }
        catch (Exception ex)
        {
            CrashLogger.WriteCrash("OnStartup", ex);
            ShowFatalErrorAndShutdown(ex);
        }
    }

    /// <summary>
    /// Ship 96: factored out of OnStartup so the try/catch wrapping
    /// the body is shallow. Everything that creates UI or holds
    /// disposable resources lives here; OnStartup itself only does
    /// the wire-up + dispatch.
    /// </summary>
    private void BootstrapTray()
    {
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
        // someone running the tray under a debugger. Also write a
        // line to the crash log's "info" channel so the same
        // information shows up in the on-disk diagnostics if the
        // tray later dies and we go hunting.
        if (_serverUrls.FallbackReason != FallbackReason.None)
        {
            var msg =
                $"server.url fallback: {_serverUrls.FallbackReason} " +
                $"({_serverUrls.Detail ?? "no detail"}). Using {_serverUrls.TrayUrl}.";
            Debug.WriteLine($"[NoteControl.Tray] {msg}");
            CrashLogger.WriteInfo("startup", msg);
        }

        // Ship 96: log a startup-OK marker. If the tray dies later
        // we can quickly see the last successful start vs the
        // crash time and rule out "never made it past init".
        CrashLogger.WriteInfo("startup",
            $"Tray started OK. Version={GetTrayVersion()}, TrayUrl={_serverUrls.TrayUrl}");

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

    // -----------------------------------------------------------------------
    // Ship 96: global exception handlers
    //
    // Three channels, three handlers, all routing to the same
    // CrashLogger.WriteCrash. Each channel catches a different class
    // of failure:
    //
    //   - DispatcherUnhandledException: exceptions on the WPF UI
    //     thread (button clicks, paint, dispatcher-marshalled
    //     callbacks). Setting Handled=true keeps the app alive
    //     after a non-fatal blip; we still log it.
    //
    //   - AppDomain.UnhandledException: exceptions on background
    //     threads that nobody catches. By the time this fires the
    //     CLR is already terminating; we can write a log but can't
    //     keep the app alive. e.IsTerminating is virtually always
    //     true on .NET Core / .NET 5+.
    //
    //   - TaskScheduler.UnobservedTaskException: faults on Task
    //     instances that were never awaited and got GC'd. By
    //     observing them here we mark them Observed (preventing
    //     the crash that would otherwise come on the next GC) and
    //     get a log entry to investigate later.
    // -----------------------------------------------------------------------

    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        CrashLogger.WriteCrash("DispatcherUnhandledException", e.Exception);

        // Show a user-visible dialog so they see *something* when
        // the tray hits an issue. We don't keep the app alive
        // (Handled=false) because the exception escaped a normal
        // try/catch in our code, meaning we're in unknown state.
        // Letting the process exit + the next launch start fresh
        // is safer than soldiering on with a possibly-corrupt UI.
        try
        {
            MessageBox.Show(
                "NoteControl ran into an unexpected problem and will close.\n\n" +
                "Details have been written to:\n" +
                CrashLogger.LogPath + "\n\n" +
                "Error: " + e.Exception.Message,
                "NoteControl — Unexpected error",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
        catch
        {
            // If we can't even show a MessageBox (rare; e.g. the
            // dispatcher is in a really bad state), let it go --
            // the log on disk is the main goal.
        }

        // Handled=false lets the runtime terminate the process.
        // We tried marking it true in an earlier draft to "keep
        // the tray alive" but discovered that any exception leaking
        // this far means our internal state is suspect; better to
        // exit cleanly and rely on the OS to relaunch via HKLM Run
        // on next sign-in, or the user to relaunch manually.
        e.Handled = false;
    }

    private static void OnAppDomainUnhandledException(object sender, UnhandledExceptionEventArgs e)
    {
        // ExceptionObject is typed object because the CLR's contract
        // doesn't constrain what gets thrown (you can throw any
        // object in IL, though C# normalises to Exception). Almost
        // always Exception in practice; we cast defensively.
        var ex = e.ExceptionObject as Exception
              ?? new Exception("Non-Exception object thrown: " + e.ExceptionObject);
        CrashLogger.WriteCrash("AppDomain.UnhandledException", ex);
        // No MessageBox here -- by the time this fires the dispatch
        // loop may already be torn down. Disk log is the goal.
    }

    private static void OnUnobservedTaskException(object? sender, System.Threading.Tasks.UnobservedTaskExceptionEventArgs e)
    {
        CrashLogger.WriteCrash("UnobservedTaskException", e.Exception);
        // Mark observed so the runtime doesn't escalate to an
        // unhandled exception on the next GC. We've logged it;
        // throwing it again would just be loud and unrecoverable.
        e.SetObserved();
    }

    /// <summary>
    /// Ship 96: last-resort error path. Called from the OnStartup
    /// catch when bootstrap fails before the tray icon could be
    /// shown. Displays the error to the user and exits cleanly.
    /// </summary>
    private void ShowFatalErrorAndShutdown(Exception ex)
    {
        try
        {
            MessageBox.Show(
                "NoteControl could not start.\n\n" +
                "A diagnostic log has been written to:\n" +
                CrashLogger.LogPath + "\n\n" +
                "Error: " + ex.Message + "\n\n" +
                "Try signing out and back in (Windows will relaunch the tray), " +
                "or run NoteControl.Tray.exe manually after checking the log.",
                "NoteControl — Startup failed",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
        catch
        {
            // MessageBox itself failed -- nothing more we can do.
        }
        Shutdown(1);
    }

    private static string GetTrayVersion()
    {
        try
        {
            return Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "(unknown)";
        }
        catch
        {
            return "(unknown)";
        }
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

/// <summary>
/// Ship 96: dead-simple crash logger for the tray.
///
/// Why a hand-rolled logger instead of Serilog: the tray currently
/// has zero logging dependencies and adding Serilog for a single
/// crash file is overkill. The whole point of this is to be the
/// last line of defence -- we can't depend on a richer logger
/// because the failures we're trying to log might happen during
/// that logger's own initialisation.
///
/// Storage: %LOCALAPPDATA%\NoteControl\tray-crash-{yyyyMMdd}.log
/// Per-day rolling so a chatty day doesn't grow unbounded; we keep
/// 7 days' worth, deleted on Initialise().
///
/// Thread safety: all writes go through a private lock. Throughput
/// isn't a concern (a handful of lines per day at worst), and the
/// alternative (per-thread buffers, lock-free queue) would defeat
/// the goal of "as simple as possible so we trust it under stress".
///
/// Failure handling: every public method catches its own
/// exceptions. A logger that throws when the disk is full or the
/// folder is locked just makes things worse.
/// </summary>
internal static class CrashLogger
{
    private static readonly object _lock = new();
    private static string _path = ""; // resolved in Initialise; empty until then
    private static bool _initialised;

    public static string LogPath => _path;

    /// <summary>
    /// Resolve the log path, ensure the folder exists, and prune
    /// old logs. Idempotent; safe to call more than once. If
    /// anything fails (e.g. LOCALAPPDATA not set, disk full, ACLs)
    /// the logger silently degrades to a no-op.
    /// </summary>
    public static void Initialise()
    {
        try
        {
            if (_initialised) return;

            // %LOCALAPPDATA% on Windows == per-user, not roaming.
            // Right place for diagnostics: machine-local, no need
            // for elevation, survives logoff/reboot, doesn't bloat
            // the roaming profile. Falls back to %TEMP% in the
            // exotic case where LocalApplicationData is empty.
            var baseDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrWhiteSpace(baseDir))
            {
                baseDir = Path.GetTempPath();
            }
            var dir = Path.Combine(baseDir, "NoteControl");
            Directory.CreateDirectory(dir);

            var today = DateTime.Now.ToString("yyyyMMdd");
            _path = Path.Combine(dir, $"tray-crash-{today}.log");

            // Keep ~7 days of crash logs. Anything older gets
            // deleted to bound disk use. The pattern below matches
            // any tray-crash-*.log; we parse the date out of each.
            try
            {
                var cutoff = DateTime.Now.AddDays(-7);
                foreach (var f in Directory.EnumerateFiles(dir, "tray-crash-*.log"))
                {
                    try
                    {
                        var fi = new FileInfo(f);
                        if (fi.LastWriteTime < cutoff)
                        {
                            fi.Delete();
                        }
                    }
                    catch
                    {
                        // Best-effort prune; a locked old log is
                        // not worth aborting initialisation over.
                    }
                }
            }
            catch
            {
                // Pruning is housekeeping; failure here doesn't
                // affect our ability to log new crashes.
            }

            _initialised = true;
        }
        catch
        {
            // No log path means later Write* calls become no-ops.
            // Whatever broke, it's not worth crashing the crash
            // logger over.
            _initialised = false;
            _path = "";
        }
    }

    /// <summary>
    /// Append a crash entry. Channel is a free-form label
    /// describing where the exception came from
    /// (e.g. "DispatcherUnhandledException", "OnStartup").
    /// </summary>
    public static void WriteCrash(string channel, Exception ex)
    {
        Write(channel, "CRASH", ex.ToString());
    }

    /// <summary>
    /// Append an info entry. Used for non-fatal context that's
    /// useful when reading a crash log later (last successful
    /// startup, fallback URL reasons, etc.).
    /// </summary>
    public static void WriteInfo(string channel, string message)
    {
        Write(channel, "INFO", message);
    }

    private static void Write(string channel, string level, string body)
    {
        if (!_initialised || string.IsNullOrEmpty(_path)) return;
        try
        {
            // ISO-8601 with millis + offset so log times sort
            // correctly even across DST transitions and UTC offset
            // changes.
            var stamp = DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss.fff zzz");
            var line = $"[{stamp}] [{level}] [{channel}] {body}{Environment.NewLine}";
            lock (_lock)
            {
                File.AppendAllText(_path, line);
            }
        }
        catch
        {
            // We are the last line of defence; if appending fails,
            // there's nothing useful left to do but swallow.
        }
    }
}
