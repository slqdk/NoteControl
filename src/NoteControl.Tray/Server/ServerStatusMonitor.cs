using System.Diagnostics;
using System.Net.Http;
using System.Windows.Threading;

namespace NoteControl.Tray.Server;

/// <summary>
/// Live server-state monitor for the tray. Polls the local server
/// every few seconds and surfaces the result to subscribers
/// (icon swap + menu label + tooltip).
///
/// Lives next to ServerController because it consumes ServerController's
/// Detect() output and shares its HTTP client topology. Kept as a
/// separate class (not folded into ServerController) because the
/// concerns don't overlap: ServerController does one-shot
/// Start/Stop/Restart, whereas this thing runs continuously and is
/// owned by App.xaml.cs for its lifetime.
///
/// Threading: the timer fires on the WPF UI thread (DispatcherTimer);
/// the probe itself runs on the thread pool via Task.Run. State
/// changes are marshalled back to the UI thread via the Dispatcher
/// before invoking <see cref="StateChanged"/> so subscribers can
/// touch UI elements directly without re-marshalling.
///
/// Manual override: while a Start/Stop/Restart operation is in
/// flight, the monitor enters an override state set by the caller
/// (typically <see cref="ServerState.StartingTransition"/> etc).
/// Poll results are ignored until the override ends. This avoids a
/// race where the poll lands mid-operation and overwrites the
/// transitional label with whatever the half-stopped server happens
/// to return.
/// </summary>
internal sealed class ServerStatusMonitor : IDisposable
{
    /// <summary>
    /// Poll cadence. 4 seconds is a balance between "feels live"
    /// and "doesn't hammer loopback". A health probe is cheap
    /// (<10ms on loopback) so we could go faster, but a busy
    /// machine with the tray running for hours would still rack
    /// up thousands of probes a day; 4s feels live in practice.
    /// </summary>
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(4);

    /// <summary>
    /// Initial-probe delay. Small but non-zero so the tray
    /// has time to render before we kick off the first probe.
    /// First-launch UX is "tray appears then state updates a
    /// second later" rather than "tray appears with a frozen
    /// initial state".
    /// </summary>
    private static readonly TimeSpan FirstFireDelay = TimeSpan.FromSeconds(1);

    /// <summary>
    /// Per-probe HTTP timeout. Loopback /health is sub-10ms when
    /// healthy; 1 second is generous and lets us bail on a hung
    /// server (e.g. it bound but isn't accepting connections yet)
    /// without holding the timer up.
    ///
    /// Note: this is intentionally MORE aggressive than
    /// ServerController.HealthClient (2s) because:
    /// - ServerController polls during start/stop, where the
    ///   server is legitimately slow to come up.
    /// - This monitor polls steady-state, where 1s is a clear
    ///   "something is wrong" signal.
    /// </summary>
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(1);

    // Dedicated HttpClient. Shared static instance to avoid socket
    // exhaustion (the canonical HttpClient pitfall) and configured
    // with our shorter timeout. Separate from
    // ServerController.HealthClient so we don't accidentally
    // change its semantics.
    private static readonly HttpClient HealthClient = new()
    {
        Timeout = ProbeTimeout,
    };

    private readonly ServerController _controller;
    private readonly Dispatcher _dispatcher;
    private readonly DispatcherTimer _timer;

    private ServerState _lastReported = ServerState.Unknown;
    private ServerState? _override;
    private bool _disposed;

    /// <summary>
    /// Fires on every reported-state transition. Always invoked on
    /// the WPF UI thread; subscribers may touch UI elements
    /// directly. Initial fire happens after the first probe, not
    /// at Start() — subscribers should set a sensible "unknown"
    /// state before calling Start.
    /// </summary>
    public event Action<ServerState>? StateChanged;

    public ServerStatusMonitor(ServerController controller, Dispatcher dispatcher)
    {
        _controller = controller;
        _dispatcher = dispatcher;
        _timer = new DispatcherTimer { Interval = FirstFireDelay };
        _timer.Tick += OnTick;
    }

    /// <summary>
    /// Start polling. Schedules the first probe after a short
    /// delay; subsequent probes run at <see cref="PollInterval"/>.
    /// Safe to call more than once — no-op on subsequent calls.
    /// </summary>
    public void Start()
    {
        if (_disposed) return;
        if (_timer.IsEnabled) return;
        _timer.Start();
    }

    /// <summary>
    /// Set a manual override. While an override is active, poll
    /// results are ignored and the override state is the only one
    /// reported. The override fires StateChanged immediately so
    /// the UI updates without waiting for the next tick.
    /// </summary>
    public void BeginManualOverride(ServerState state)
    {
        if (_disposed) return;
        _override = state;
        Report(state);
    }

    /// <summary>
    /// Clear the manual override. The next poll will report the
    /// real state. We don't fire StateChanged synchronously here
    /// because the real state isn't known until we probe — firing
    /// an immediate "Unknown" would flicker the icon. The next
    /// tick is ≤PollInterval away.
    /// </summary>
    public void EndManualOverride()
    {
        if (_disposed) return;
        _override = null;
    }

    private async void OnTick(object? sender, EventArgs e)
    {
        // After the first fire, switch to the steady-state cadence.
        // The flip is one assignment — DispatcherTimer reads
        // Interval on each tick before scheduling the next.
        if (_timer.Interval != PollInterval)
        {
            _timer.Interval = PollInterval;
        }

        if (_override is not null)
        {
            // Don't probe at all while overridden. The override
            // owner is responsible for ending it.
            return;
        }

        ServerState state;
        try
        {
            state = await Task.Run(ProbeAsync).ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            // Defensive: ProbeAsync handles its own exceptions and
            // returns a state. Anything that escapes is a
            // programming error; surface but don't crash the timer.
            Debug.WriteLine($"[NoteControl.Tray] Status probe failed: {ex}");
            state = ServerState.Unreachable;
        }

        // Re-check the override flag now that we're back on the
        // UI thread: the user may have started a lifecycle op
        // while ProbeAsync was running.
        if (_override is not null)
        {
            return;
        }

        Report(state);
    }

    /// <summary>
    /// One probe iteration. Combines ServerController.Detect()
    /// (which sees the OS-level service / process state) with a
    /// /health GET (which sees whether the server is actually
    /// serving requests).
    ///
    /// State decision table:
    ///   Detect = NotRunning           → Stopped
    ///   Detect = Service, Status=Stopped → Stopped
    ///   Detect = Service|Process, /health 200 → Running
    ///   Detect = Service|Process, /health failed → Unreachable
    ///
    /// "Unreachable" specifically means "we can see a server
    /// process exists, but it isn't answering" — typically a
    /// startup-in-progress, a crashed-but-not-cleaned-up process,
    /// or a port-rebinding mid-restart. Distinct from Stopped
    /// because the recovery is different: Stopped → click Start;
    /// Unreachable → wait or look at logs.
    /// </summary>
    private async Task<ServerState> ProbeAsync()
    {
        ServerController.DetectionResult det;
        try
        {
            det = _controller.Detect();
        }
        catch (Exception ex)
        {
            // Detect() reads sc.exe output and enumerates
            // processes — both can fail under unusual permissions
            // or system-fault conditions. Reporting Unreachable
            // (rather than crashing the timer) keeps the icon
            // showing SOMETHING.
            Debug.WriteLine($"[NoteControl.Tray] Detect() failed: {ex}");
            return ServerState.Unreachable;
        }

        if (det.Status == ServerController.ServerStatus.Stopped || det.Mode == ServerController.ServerMode.NotRunning)
        {
            return ServerState.Stopped;
        }

        // Something is running. Verify /health.
        var url = ResolveHealthUrl();
        if (url is null)
        {
            // No server.url available AND no fallback worked.
            // Unusual — the resolver always returns the legacy
            // default. Defensive branch only.
            return ServerState.Unreachable;
        }

        try
        {
            using var resp = await HealthClient.GetAsync(url).ConfigureAwait(false);
            return resp.IsSuccessStatusCode
                ? ServerState.Running
                : ServerState.Unreachable;
        }
        catch
        {
            // Connection refused / timeout / DNS. The server
            // process exists per Detect() but isn't answering.
            return ServerState.Unreachable;
        }
    }

    /// <summary>
    /// Resolve the /health URL fresh each probe. ServerController
    /// has a static helper but it's private; rather than expose
    /// it we re-resolve here. The resolver is cheap (one file
    /// read), and re-reading per probe means we pick up a port
    /// change automatically — admin changes port + restarts
    /// server, the next poll already targets the new port.
    /// Inline-fallback to the legacy default if the resolver
    /// throws.
    /// </summary>
    private static string? ResolveHealthUrl()
    {
        try
        {
            var resolved = ServerUrlResolver.Resolve();
            return resolved.TrayUrl.TrimEnd('/') + "/health";
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Marshal to UI thread and invoke StateChanged when the
    /// state actually changes. Suppressing duplicate events
    /// avoids needless icon-swap churn (a no-op visually, but
    /// noisy in any subscriber logs).
    /// </summary>
    private void Report(ServerState state)
    {
        if (state == _lastReported) return;
        _lastReported = state;

        if (_dispatcher.CheckAccess())
        {
            StateChanged?.Invoke(state);
        }
        else
        {
            _dispatcher.BeginInvoke(() => StateChanged?.Invoke(state));
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _timer.Stop();
        _timer.Tick -= OnTick;
        // HealthClient is static — outlives this instance and is
        // not disposed here.
    }
}

/// <summary>
/// Reported state. Maps 1:1 to the four tray icon variants in
/// Resources/ (running / stopped / transitional / unreachable),
/// plus an Unknown bootstrap state that's used briefly between
/// tray startup and the first probe result.
/// </summary>
internal enum ServerState
{
    /// <summary>
    /// Pre-first-probe placeholder. Treated as Unreachable for
    /// icon purposes (the only state without a definitive
    /// answer); kept distinct so the menu can show "Probing..."
    /// instead of "Unreachable" during the first second.
    /// </summary>
    Unknown,

    /// <summary>Server is up and /health is responding 200.</summary>
    Running,

    /// <summary>
    /// Service installed but not running, OR no service and no
    /// matching process. Recovery: click Start Server.
    /// </summary>
    Stopped,

    /// <summary>
    /// User-initiated Start operation is in flight. Set as a
    /// manual override; cleared when the operation finishes.
    /// </summary>
    StartingTransition,

    /// <summary>User-initiated Stop is in flight.</summary>
    StoppingTransition,

    /// <summary>User-initiated Restart is in flight.</summary>
    RestartingTransition,

    /// <summary>
    /// Process visible per Detect() but /health isn't answering.
    /// Could be startup-in-progress (transient), a hung server, or
    /// a process the OS hasn't reaped yet. Distinct from Stopped
    /// because the recovery is different: Stopped → start it;
    /// Unreachable → wait or check logs.
    /// </summary>
    Unreachable,
}
