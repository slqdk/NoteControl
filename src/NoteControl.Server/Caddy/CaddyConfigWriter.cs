using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace NoteControl.Server.Caddy;

/// <summary>
/// Ship 93 — write the generated Caddyfile to disk and tell a
/// running Caddy process to reload its config.
///
/// Two distinct operations, intentionally separated:
///
///   1. <see cref="Write"/> — pure file write to a known path.
///      Idempotent. Always succeeds if the disk is healthy.
///   2. <see cref="ReloadAsync"/> — fire `caddy reload --config <path>`
///      against a running service. May fail (Caddy not running,
///      Caddy not in PATH, the new Caddyfile is invalid). Failures
///      are logged but NOT thrown — the Settings save shouldn't
///      fail just because Caddy is unhappy. Caddy will pick up
///      the new file on its next restart anyway, so the user's
///      change is persisted regardless.
///
/// Why CLI-based reload instead of the admin API
/// (POST http://localhost:2019/load):
///   - The admin API requires sending the WHOLE config in JSON,
///     not the Caddyfile. We'd need to either parse our own
///     Caddyfile back into JSON or maintain two formats. The CLI
///     `caddy reload --config <path>` does the parsing for us.
///   - Caddy's `caddy.exe` ships in the same directory we just
///     installed it to. PATH is the most natural way to invoke
///     it. We accept that PATH might not have `caddy.exe`; the
///     reload then fails with a logged error.
///   - The admin API endpoint is only on localhost:2019 by default
///     anyway, so there's no security advantage either way.
///
/// Reload semantics: Caddy's `reload` is graceful — running
/// connections aren't dropped. New connections use the new config.
/// If parsing the new Caddyfile fails, Caddy keeps serving the
/// old config and exits non-zero from the CLI; we log the
/// non-zero exit + stderr.
///
/// This class is a singleton; thread-safe because Write uses a
/// per-call StreamWriter and ReloadAsync just spawns a process.
/// Multiple concurrent Save calls would be benign — last write wins
/// on disk, last reload wins in Caddy. The ConfigService writer
/// already serialises saves at a higher level.
/// </summary>
public sealed class CaddyConfigWriter
{
    private readonly ILogger<CaddyConfigWriter> _log;

    public CaddyConfigWriter(ILogger<CaddyConfigWriter> log)
    {
        _log = log;
    }

    /// <summary>
    /// Write the Caddyfile to <paramref name="caddyfilePath"/>,
    /// creating parent directories as needed.
    ///
    /// Atomic-ish: writes to a `.tmp` file then renames. Caddy is
    /// reading the file we're rewriting, so a partial write would
    /// be a problem if Caddy reloaded mid-write. The temp+rename
    /// pattern hands Caddy either the old file or the new file,
    /// never a half-written one.
    /// </summary>
    public void Write(string caddyfilePath, string contents)
    {
        var dir = Path.GetDirectoryName(caddyfilePath);
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
        {
            Directory.CreateDirectory(dir);
        }

        var tmp = caddyfilePath + ".tmp";
        File.WriteAllText(tmp, contents);
        // File.Move with overwrite=true is atomic on Windows when
        // source and dest are on the same volume (which they are
        // — both under DataRoot). If something else has the file
        // open exclusively, this throws — log + retry once is the
        // pragmatic option but we don't bother yet; in practice
        // only Caddy reads this file, and Caddy releases its
        // handle between reloads.
        File.Move(tmp, caddyfilePath, overwrite: true);

        _log.LogInformation(
            "Wrote Caddyfile to {Path} ({Bytes} bytes).",
            caddyfilePath, contents.Length);
    }

    /// <summary>
    /// Invoke <c>caddy reload --config &lt;path&gt;</c> and wait
    /// up to <paramref name="timeoutSeconds"/> for it to return.
    ///
    /// Returns true on exit code 0; false on any failure (Caddy
    /// not found, parse error, timeout). Failures are logged with
    /// stderr captured so the user can see the reason in
    /// <c>logs/notecontrol-*.log</c>. The Settings save UI may
    /// want to surface "Caddy reload failed — see logs"; that's
    /// up to the caller.
    ///
    /// Async only because we wait on the process; the work itself
    /// is essentially synchronous from Caddy's perspective.
    /// </summary>
    public async Task<bool> ReloadAsync(string caddyfilePath, int timeoutSeconds = 15)
    {
        try
        {
            // Ship 94: resolve caddy.exe explicitly. Pre-Ship-94 we
            // relied on `caddy` resolving via PATH, which it doesn't
            // — Windows doesn't add `C:\Program Files\Caddy\` to
            // PATH automatically. The setup-https.ps1 script copies
            // caddy.exe to that conventional location, so we look
            // there first; PATH is checked as a fallback for unusual
            // setups where someone deliberately put caddy.exe on
            // PATH (e.g. via Chocolatey, Scoop, or a manual edit).
            //
            // If we can't find it, return false. The caller (settings-
            // save flow, etc.) treats reload failure as a logged
            // warning, not a thrown exception — Caddy will pick up
            // the new config on its next start anyway.
            var caddyExe = ResolveCaddyExe();
            if (caddyExe is null)
            {
                _log.LogWarning(
                    "Could not find caddy.exe to invoke reload. Looked in: " +
                    "C:\\Program Files\\Caddy\\caddy.exe and on PATH. The Caddyfile " +
                    "WAS written to {Path}; Caddy will pick it up on its next start.",
                    caddyfilePath);
                return false;
            }

            var psi = new ProcessStartInfo
            {
                FileName = caddyExe,
                // --config picks the file; --adapter caddyfile is
                // the default for .Caddyfile-format files but we
                // pass it explicitly so a future Caddy version
                // change doesn't switch the default and break us.
                Arguments = $"reload --config \"{caddyfilePath}\" --adapter caddyfile",
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            using var proc = Process.Start(psi);
            if (proc is null)
            {
                _log.LogWarning(
                    "Could not start `{Exe} reload` — Process.Start returned null.",
                    caddyExe);
                return false;
            }

            // Read both streams concurrently and wait. Caddy reload
            // is fast (< 1s on a healthy install); 15s timeout is
            // generous for slow/contested machines.
            var stdoutTask = proc.StandardOutput.ReadToEndAsync();
            var stderrTask = proc.StandardError.ReadToEndAsync();
            var exitTask = proc.WaitForExitAsync();
            var done = await Task.WhenAny(exitTask, Task.Delay(TimeSpan.FromSeconds(timeoutSeconds)));
            if (done != exitTask)
            {
                try { proc.Kill(entireProcessTree: true); } catch { /* best effort */ }
                _log.LogWarning(
                    "Timed out after {Seconds}s waiting for `caddy reload`. Killed the process.",
                    timeoutSeconds);
                return false;
            }

            var stdout = await stdoutTask;
            var stderr = await stderrTask;

            if (proc.ExitCode != 0)
            {
                _log.LogWarning(
                    "`caddy reload` failed with exit code {Code}. stderr: {Stderr}. stdout: {Stdout}",
                    proc.ExitCode, stderr.Trim(), stdout.Trim());
                return false;
            }

            _log.LogInformation("Caddy reloaded successfully ({Path}).", caddyfilePath);
            return true;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex,
                "Exception while invoking `caddy reload`. The Caddyfile WAS " +
                "written successfully and Caddy will pick it up on next start.");
            return false;
        }
    }

    /// <summary>
    /// Ship 94: locate caddy.exe via fallback list. Returns null
    /// if not found anywhere. Order:
    ///   1. C:\Program Files\Caddy\caddy.exe — where setup-https.ps1
    ///      puts it. The expected location for a NoteControl install.
    ///   2. PATH — for edge cases where caddy was installed via
    ///      package manager (Chocolatey: C:\ProgramData\chocolatey\bin,
    ///      Scoop: %USERPROFILE%\scoop\shims, etc).
    ///
    /// We prefer the conventional location because PATH lookups
    /// inside a Windows Service running as LocalSystem are subtler
    /// than they look (different PATH from the desktop user that
    /// installed Caddy via package manager). The script-deployed
    /// location is reliable from any service identity.
    /// </summary>
    private static string? ResolveCaddyExe()
    {
        const string conventional = @"C:\Program Files\Caddy\caddy.exe";
        if (File.Exists(conventional)) return conventional;

        // PATH lookup. Walk PATH manually rather than relying on
        // Process.Start's implicit search — the implicit search
        // depends on the working directory + PATH of the calling
        // process, which inside a Windows Service is typically
        // C:\Windows\system32 with a LocalSystem PATH. Our explicit
        // walk uses the same env var but doesn't add the working
        // directory, matching what the user usually expects.
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            var candidate = Path.Combine(dir.Trim(), "caddy.exe");
            if (File.Exists(candidate)) return candidate;
        }

        return null;
    }
}
