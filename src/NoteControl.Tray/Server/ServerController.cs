using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace NoteControl.Tray.Server;

/// <summary>
/// Detects how the NoteControl server is running on this machine
/// and provides start/stop/restart operations against the right
/// surface.
///
/// Two execution modes:
///   1. <see cref="ServerMode.Service"/> — the server has been
///      installed as a Windows Service (future install-service.ps1
///      target). Lifecycle is managed via <c>sc.exe</c>.
///   2. <see cref="ServerMode.Process"/> — the server is being run
///      by hand (NoteControl.Server.exe launched from a console or
///      Explorer). Lifecycle is managed by killing/respawning the
///      process directly.
///
/// Detection runs every time the user clicks a menu item, not at
/// startup, because the server can be installed-as-service /
/// uninstalled / launched-by-hand at any moment without the tray
/// being notified.
///
/// Why <c>sc.exe</c> instead of the <c>System.ServiceProcess.ServiceController</c>
/// API: that API would add a NuGet dependency
/// (System.ServiceProcess.ServiceController) which the tray
/// otherwise doesn't need. <c>sc.exe</c> ships with every Windows
/// since NT4 and gives us exit codes that are good enough for our
/// needs (0 = success, ~1060 = service not installed, ~1062 = not
/// running, etc — we only really care about 0 vs not-0). Trade-off:
/// uglier code, but zero new dependencies + battle-tested CLI.
/// </summary>
internal sealed class ServerController
{
    /// <summary>
    /// The Windows Service short-name we expect the server to be
    /// registered under, if installed as a service. The future
    /// install-service.ps1 script MUST use this exact name —
    /// otherwise detection will think the service isn't installed
    /// and silently fall back to process control.
    /// </summary>
    public const string ServiceName = "NoteControlServer";

    /// <summary>
    /// Process basename we look for when running in process mode.
    /// Must match the .exe shipped by publish.ps1.
    /// </summary>
    public const string ProcessName = "NoteControl.Server";

    /// <summary>
    /// Where to find the server .exe when starting from cold (no
    /// service, no running process). Resolved relative to the tray's
    /// own directory: dist layout is …\dist\X\tray\NoteControl.Tray.exe
    /// next to …\dist\X\server\NoteControl.Server.exe, so "..\server"
    /// is the relative path between them. If the layout ever
    /// changes, update this — and the deploy README.
    /// </summary>
    private static readonly string ExpectedServerExeRelativePath =
        Path.Combine("..", "server", ProcessName + ".exe");

    /// <summary>
    /// Health endpoint we ping to confirm the server is actually
    /// serving requests after a Start/Restart, not just running.
    /// Step 43: the URL is resolved from the server.url file (same
    /// resolver used by App.xaml.cs) so this works even when the
    /// user has changed the port. We read it at WaitForHealthAsync
    /// time rather than caching, because the user might have
    /// changed the port between tray startup and when they hit
    /// "Start Server" — we want the freshest URL we can get.
    /// </summary>
    private static string ResolveHealthUrl()
    {
        var resolved = ServerUrlResolver.Resolve();
        return resolved.TrayUrl.TrimEnd('/') + "/health";
    }

    private static readonly HttpClient HealthClient = new()
    {
        Timeout = TimeSpan.FromSeconds(2),
    };

    public enum ServerMode
    {
        /// <summary>Installed and registered as a Windows Service.</summary>
        Service,
        /// <summary>Running as a plain user process (hand-launched).</summary>
        Process,
        /// <summary>Neither — the server isn't currently running anywhere.</summary>
        NotRunning,
    }

    public enum ServerStatus
    {
        Unknown,
        Running,
        Stopped,
    }

    /// <summary>
    /// Snapshot of detection at one point in time. The mode tells
    /// the caller WHICH lifecycle surface is in play; the status
    /// tells whether the thing is up.
    /// </summary>
    public sealed record DetectionResult(ServerMode Mode, ServerStatus Status);

    // ---------------------------------------------------------------
    // Detection
    // ---------------------------------------------------------------

    /// <summary>
    /// Inspect the system and return what we found. Service detection
    /// wins when both are present (service + a stray process), because
    /// in that scenario the user almost certainly wants to manage the
    /// service and the stray process is a mistake.
    /// </summary>
    public DetectionResult Detect()
    {
        // Service first.
        var (serviceInstalled, serviceRunning) = QueryService();
        if (serviceInstalled)
        {
            return new DetectionResult(
                ServerMode.Service,
                serviceRunning ? ServerStatus.Running : ServerStatus.Stopped);
        }

        // Otherwise process.
        var procRunning = Process.GetProcessesByName(ProcessName).Length > 0;
        if (procRunning)
        {
            return new DetectionResult(ServerMode.Process, ServerStatus.Running);
        }

        // Nothing.
        return new DetectionResult(ServerMode.NotRunning, ServerStatus.Stopped);
    }

    // ---------------------------------------------------------------
    // Operations
    // ---------------------------------------------------------------

    /// <summary>Start the server. If already running, no-op + true.</summary>
    public async Task<OperationResult> StartAsync(CancellationToken ct = default)
    {
        var det = Detect();
        if (det.Status == ServerStatus.Running)
        {
            return OperationResult.Ok("Already running.");
        }

        if (det.Mode == ServerMode.Service)
        {
            // Ship 66: try sc.exe first. On exit-5 (Access denied)
            // re-launch ourselves elevated to do just the sc call.
            // The Ship-66 installer grants Authenticated Users
            // start/stop via `sc sdset`, so the elevation path is
            // a fallback for: (a) installs done before Ship 66, and
            // (b) machines where sdset failed for some reason.
            var sc = RunScWithElevationFallback("start " + ServiceName);
            if (sc.ExitCode != 0)
            {
                return OperationResult.Fail(
                    $"sc.exe start failed (exit {sc.ExitCode}). {sc.CombinedOutput}");
            }
        }
        else
        {
            // No service installed AND no process running — start the
            // .exe relative to the tray's location.
            var exePath = ResolveServerExePath();
            if (exePath is null)
            {
                return OperationResult.Fail(
                    $"Could not find {ProcessName}.exe. Looked at " +
                    $"{Path.GetFullPath(ExpectedServerExeRelativePath)} relative " +
                    $"to the tray. Is this a packaged build (run publish.ps1)?");
            }

            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = exePath,
                    WorkingDirectory = Path.GetDirectoryName(exePath)!,
                    UseShellExecute = true, // gets its own console window
                });
            }
            catch (Exception ex)
            {
                return OperationResult.Fail($"Could not launch server: {ex.Message}");
            }
        }

        // Wait for /health to come up. The server takes a moment to
        // bind sockets + apply migrations after Process.Start returns.
        var ready = await WaitForHealthAsync(timeout: TimeSpan.FromSeconds(15), ct);
        return ready
            ? OperationResult.Ok("Started.")
            : OperationResult.Fail(
                "Started, but /health didn't respond within 15 seconds. " +
                "The server may still be coming up — check its console window.");
    }

    /// <summary>Stop the server. If already stopped, no-op + true.</summary>
    public async Task<OperationResult> StopAsync(CancellationToken ct = default)
    {
        var det = Detect();
        if (det.Status == ServerStatus.Stopped || det.Mode == ServerMode.NotRunning)
        {
            return OperationResult.Ok("Already stopped.");
        }

        if (det.Mode == ServerMode.Service)
        {
            // Ship 66: same elevation-fallback dance as Start.
            // 1062 = ERROR_SERVICE_NOT_ACTIVE (already stopped) is
            // success from the user's POV.
            var sc = RunScWithElevationFallback("stop " + ServiceName);
            if (sc.ExitCode != 0 && sc.ExitCode != 1062)
            {
                return OperationResult.Fail(
                    $"sc.exe stop failed (exit {sc.ExitCode}). {sc.CombinedOutput}");
            }
        }
        else
        {
            // Process mode — kill every NoteControl.Server.exe we
            // can find. Multiple instances would be a configuration
            // mistake, but if it happens we kill them all to leave
            // the system in a sensible state.
            var killed = 0;
            foreach (var p in Process.GetProcessesByName(ProcessName))
            {
                try
                {
                    p.Kill(entireProcessTree: true);
                    p.WaitForExit(5000);
                    killed++;
                }
                catch (Exception ex)
                {
                    return OperationResult.Fail(
                        $"Could not stop {ProcessName} (pid {p.Id}): {ex.Message}");
                }
                finally
                {
                    p.Dispose();
                }
            }
            if (killed == 0)
            {
                return OperationResult.Ok("Already stopped.");
            }
        }

        // Confirm the port frees up — the OS sometimes lingers on
        // socket cleanup briefly. We don't fail hard if /health is
        // still answering after this delay; a service that ignores
        // SIGTERM is its own problem.
        await Task.Delay(500, ct);
        return OperationResult.Ok("Stopped.");
    }

    /// <summary>
    /// Stop then start. Bias toward 'sc.exe restart' for service mode
    /// (one atomic call) but fall back to stop+start if that fails.
    /// </summary>
    public async Task<OperationResult> RestartAsync(CancellationToken ct = default)
    {
        var det = Detect();
        if (det.Mode == ServerMode.Service)
        {
            // sc.exe doesn't have a `restart` verb (despite the
            // name in some docs). Two-step: stop, then start. We do
            // both unconditionally — if the service was already
            // stopped, the stop is a no-op and we proceed to start.
            var stop = await StopAsync(ct);
            if (!stop.Success) return stop;
            return await StartAsync(ct);
        }
        else
        {
            var stop = await StopAsync(ct);
            if (!stop.Success) return stop;
            // If we just killed the process, ResolveServerExePath has
            // to find it for a clean Start. Detect now reports
            // NotRunning, which sends StartAsync down the process
            // launch path.
            return await StartAsync(ct);
        }
    }

    // ---------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------

    /// <summary>
    /// (installed, running) for the configured service. (false, false)
    /// when the service doesn't exist. We tell those apart by exit
    /// code: <c>sc query</c> returns 1060 for "service does not exist".
    /// </summary>
    private static (bool installed, bool running) QueryService()
    {
        var result = RunSc("query " + ServiceName);

        // 1060 = ERROR_SERVICE_DOES_NOT_EXIST
        if (result.ExitCode == 1060) return (false, false);

        // Any other failure: pessimistically treat as "service mode
        // unavailable" rather than mis-routing the user's click.
        // Most non-zero codes here mean we can't talk to the SCM
        // (permission, SCM down) — process mode is the safer default.
        if (result.ExitCode != 0) return (false, false);

        // Output looks like:
        //   STATE              : 4  RUNNING
        // We just look for "RUNNING" — case-sensitive in the SCM
        // output, so a plain Contains is fine.
        var running = result.CombinedOutput.Contains("RUNNING");
        return (true, running);
    }

    /// <summary>
    /// Run sc.exe and capture stdout+stderr together. We return the
    /// raw exit code so callers can distinguish "not installed" from
    /// "permission denied" from "actual failure".
    /// </summary>
    private static (int ExitCode, string CombinedOutput) RunSc(string args)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "sc.exe",
                Arguments = args,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var proc = Process.Start(psi);
            if (proc is null) return (-1, "Could not start sc.exe");
            // Read both streams to completion BEFORE WaitForExit to
            // avoid the classic "child blocks on full pipe" deadlock.
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit(10000);
            return (proc.ExitCode, stdout + stderr);
        }
        catch (Exception ex)
        {
            // Ex.HResult tends to be useless here; just return the
            // message so the caller can surface it.
            return (-1, ex.Message);
        }
    }

    /// <summary>
    /// Ship 66: like <see cref="RunSc"/> but on exit-5 (Access denied)
    /// re-launches the tray .exe elevated to perform just the sc
    /// call. Used for start/stop operations on the service.
    ///
    /// Why two layers: the tray is asInvoker (un-elevated). Without
    /// the Ship-66 installer's `sc sdset` widening the DACL, the
    /// SCM rejects start/stop from a non-admin token with exit code
    /// 5. Even WITH sdset, we keep the fallback for older installs
    /// and for machines where sdset failed.
    ///
    /// Re-launch contract: the elevated tray sees argv
    /// <c>--service-action start</c> or <c>--service-action stop</c>,
    /// runs that sc command, and exits with the sc exit code as its
    /// own process exit code. We surface that to the caller as if
    /// they'd run sc directly.
    ///
    /// Why a re-launch instead of an embedded admin helper exe: it
    /// keeps the Setup unchanged (one tray binary, no second
    /// signed/elevation-marked sibling). The downside is one UAC
    /// prompt per click on machines without the DACL widening, plus
    /// the brief flash of a second tray.exe in Process Explorer.
    /// Acceptable for an admin-only operation.
    ///
    /// We don't re-launch on every error. Only exit code 5 means
    /// "permission denied at the SCM" and is what the elevation
    /// path can fix. Other failures (1060 not installed, 1062 not
    /// running, 1056 already running, etc.) are returned as-is.
    /// </summary>
    private static (int ExitCode, string CombinedOutput) RunScWithElevationFallback(string args)
    {
        var direct = RunSc(args);
        if (direct.ExitCode != 5) return direct;

        // Parse the verb out of args ("start NoteControlServer" -> "start").
        // We only support start/stop here; defensive guard returns the
        // original failure if anything else slips through.
        var firstSpace = args.IndexOf(' ');
        var verb = firstSpace > 0 ? args.Substring(0, firstSpace) : args;
        if (verb is not ("start" or "stop"))
        {
            return direct;
        }

        try
        {
            // AppContext.BaseDirectory is the tray's own folder.
            // We re-invoke the same .exe so we don't have to know
            // where in Program Files it lives or how it was launched.
            var trayExe = Path.Combine(
                AppContext.BaseDirectory,
                "NoteControl.Tray.exe");

            var psi = new ProcessStartInfo
            {
                FileName = trayExe,
                Arguments = $"--service-action {verb}",
                // Verb=runas triggers the UAC prompt. UseShellExecute
                // must be true for Verb to be honored -- direct
                // CreateProcess can't elevate.
                UseShellExecute = true,
                Verb = "runas",
            };

            using var proc = Process.Start(psi);
            if (proc is null)
            {
                return (-1, "Could not relaunch tray for elevation.");
            }

            // Wait long enough for the SCM call. sc start can take a
            // while on cold-start (service is doing migrations etc.),
            // but 60s is more than enough -- we already have a 30s
            // health-poll on the caller side.
            if (!proc.WaitForExit(60000))
            {
                try { proc.Kill(); } catch { /* best effort */ }
                return (-1, "Elevated sc call timed out after 60s.");
            }

            // The elevated child set its ExitCode to whatever sc.exe
            // returned (or to its own error code on failure). Return
            // that as if we'd run sc directly. Output is empty
            // because we can't pipe across the elevation boundary
            // without a named-pipe dance we don't need yet.
            return (proc.ExitCode, "");
        }
        catch (System.ComponentModel.Win32Exception wex) when (wex.NativeErrorCode == 1223)
        {
            // 1223 = ERROR_CANCELLED. User clicked No on the UAC
            // prompt. Surface a friendly message instead of the
            // raw "operation was canceled by the user" text.
            return (5, "Administrator approval was declined.");
        }
        catch (Exception ex)
        {
            return (-1, "Elevation failed: " + ex.Message);
        }
    }

    /// <summary>
    /// Find NoteControl.Server.exe relative to where the tray is
    /// running. Returns null if it doesn't exist; caller surfaces
    /// the path in the error so the user can investigate.
    /// </summary>
    private static string? ResolveServerExePath()
    {
        // AppContext.BaseDirectory is the folder containing the
        // running .dll/.exe (works for both single-file and folder
        // publish; doesn't depend on Environment.CurrentDirectory).
        var trayDir = AppContext.BaseDirectory;
        var combined = Path.GetFullPath(
            Path.Combine(trayDir, ExpectedServerExeRelativePath));
        return File.Exists(combined) ? combined : null;
    }

    /// <summary>
    /// Poll /health until it answers 200 or the timeout passes.
    /// Step 43: resolve the health URL once at the start of the
    /// poll loop, not per-iteration. The user can't change the
    /// port between iterations of this poll (we're synchronously
    /// blocking until /health is up), and re-reading the file 30
    /// times in 15 seconds is wasteful.
    /// </summary>
    private static async Task<bool> WaitForHealthAsync(
        TimeSpan timeout,
        CancellationToken ct)
    {
        var url = ResolveHealthUrl();
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                using var resp = await HealthClient.GetAsync(url, ct);
                if (resp.IsSuccessStatusCode) return true;
            }
            catch
            {
                // Connection refused / timeout / DNS — server isn't up
                // yet. Loop and try again.
            }
            await Task.Delay(500, ct);
        }
        return false;
    }
}

/// <summary>
/// Outcome of a Start/Stop/Restart call. Includes a user-facing
/// message either way; the tray surfaces it via MessageBox or
/// (eventually) a tray balloon.
/// </summary>
internal sealed record OperationResult(bool Success, string Message)
{
    public static OperationResult Ok(string msg) => new(true, msg);
    public static OperationResult Fail(string msg) => new(false, msg);
}
