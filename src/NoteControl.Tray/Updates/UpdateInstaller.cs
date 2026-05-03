using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace NoteControl.Tray.Updates;

/// <summary>
/// Performs the actual update: downloads the release asset zip
/// to %TEMP%, extracts it, then launches the bundled
/// installer\install.ps1 with elevation. The installer takes over
/// from there -- it stops the service, kills this very tray
/// process, replaces files, and re-launches the new tray. So
/// after we kick off the installer, our job is to exit fast.
/// </summary>
internal sealed class UpdateInstaller
{
    /// <summary>
    /// Reports a download / extract progress update. Phase is one
    /// of "Downloading", "Extracting", "Launching installer", "Done".
    /// percent is 0..100 for the download, -1 for indeterminate
    /// phases (extract, launch).
    /// </summary>
    public sealed record Progress(string Phase, int Percent);

    private readonly UpdateCheckResult _result;
    public UpdateInstaller(UpdateCheckResult result)
    {
        _result = result;
    }

    /// <summary>
    /// Run the full download + extract + launch flow. Returns the
    /// path to the launched installer process if everything went
    /// well; throws if anything failed before the installer was
    /// running. The caller is responsible for shutting down the
    /// tray after this returns -- the installer will kill it
    /// otherwise, but a graceful exit is friendlier.
    /// </summary>
    public async Task RunAsync(IProgress<Progress>? progress, CancellationToken ct)
    {
        if (!_result.UpdateAvailable || string.IsNullOrEmpty(_result.AssetUrl))
        {
            throw new InvalidOperationException("No update available; nothing to install.");
        }

        // Stage in a fresh, version-named temp folder so we can
        // identify what's ours and clean it up afterwards. Don't
        // use Path.GetTempFileName() -- that creates a 0-byte
        // file we'd have to delete; we want a directory.
        var version = _result.Latest!.ToString();
        var stageRoot = Path.Combine(Path.GetTempPath(), $"NoteControl-update-{version}");

        // If a previous attempt left a stage folder around, remove
        // it. Don't try to be clever about resuming downloads --
        // start fresh, the asset is small (~50 MB).
        if (Directory.Exists(stageRoot))
        {
            try { Directory.Delete(stageRoot, recursive: true); } catch { /* best effort */ }
        }
        Directory.CreateDirectory(stageRoot);

        var zipPath = Path.Combine(stageRoot, $"NoteControl-{version}.zip");
        var extractDir = Path.Combine(stageRoot, "extracted");

        // ---------------- download ----------------
        progress?.Report(new Progress("Downloading", 0));
        await DownloadAsync(_result.AssetUrl!, zipPath, _result.AssetSize, progress, ct)
            .ConfigureAwait(false);

        // ---------------- extract ----------------
        progress?.Report(new Progress("Extracting", -1));
        // The dist zip contains "NoteControl-{version}\..." as its
        // top-level folder (because publish.ps1 zips the dist folder
        // by name). ExtractToDirectory preserves that.
        ZipFile.ExtractToDirectory(zipPath, extractDir, overwriteFiles: true);

        // Find install.ps1. publish.ps1 puts it at
        // {extractDir}\NoteControl-{version}\installer\install.ps1.
        var installScript = LocateInstallScript(extractDir)
            ?? throw new InvalidOperationException(
                $"Could not find installer\\install.ps1 inside {extractDir}. " +
                "The downloaded archive may be malformed.");

        // ---------------- launch elevated ----------------
        progress?.Report(new Progress("Launching installer", -1));
        LaunchInstallerElevated(installScript);

        progress?.Report(new Progress("Done", 100));
    }

    private static string? LocateInstallScript(string extractDir)
    {
        // First look one level deep (the standard layout); fall
        // back to a recursive search if for some reason the zip's
        // top-level folder isn't named the way we expect.
        foreach (var sub in Directory.EnumerateDirectories(extractDir))
        {
            var candidate = Path.Combine(sub, "installer", "install.ps1");
            if (File.Exists(candidate)) return candidate;
        }
        // Recursive fallback. Capped to 4 levels deep so a
        // pathological zip can't burn unbounded time here.
        return EnumerateLimited(extractDir, "install.ps1", maxDepth: 4);
    }

    private static string? EnumerateLimited(string root, string fileName, int maxDepth)
    {
        // Iterative DFS with depth tracking. We push (dir, depth)
        // pairs on the stack so we know when we've gone too deep.
        var stack = new Stack<(string Dir, int Depth)>();
        stack.Push((root, 0));
        while (stack.Count > 0)
        {
            var (dir, depth) = stack.Pop();
            try
            {
                foreach (var f in Directory.EnumerateFiles(dir, fileName))
                {
                    return f;
                }
                if (depth < maxDepth)
                {
                    foreach (var sd in Directory.EnumerateDirectories(dir))
                    {
                        stack.Push((sd, depth + 1));
                    }
                }
            }
            catch { /* skip unreadable */ }
        }
        return null;
    }

    private static async Task DownloadAsync(
        string url,
        string destPath,
        long expectedSize,
        IProgress<Progress>? progress,
        CancellationToken ct)
    {
        // Use a fresh HttpClient with no timeout for the streaming
        // download. The shared one in UpdateChecker has a 15s
        // timeout, which would kill a 50 MB download on a slow
        // line. PerRequestTimeout is the new API but isn't in
        // .NET 8 yet, so just disable the per-instance timeout.
        using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"{UpdateConfig.UserAgentBase}/installer");

        using var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();

        var total = resp.Content.Headers.ContentLength ?? expectedSize;
        await using var src = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        await using var dst = new FileStream(
            destPath,
            FileMode.Create,
            FileAccess.Write,
            FileShare.None,
            bufferSize: 81920,
            useAsync: true);

        var buffer = new byte[81920];
        long copied = 0;
        var lastReportedPct = -1;
        while (true)
        {
            var read = await src.ReadAsync(buffer.AsMemory(0, buffer.Length), ct).ConfigureAwait(false);
            if (read <= 0) break;
            await dst.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
            copied += read;

            if (progress is not null && total > 0)
            {
                var pct = (int)Math.Min(100, copied * 100 / total);
                // Throttle progress updates -- WPF data binding
                // doesn't love being hit hundreds of times per second.
                if (pct != lastReportedPct)
                {
                    progress.Report(new Progress("Downloading", pct));
                    lastReportedPct = pct;
                }
            }
        }
    }

    private static void LaunchInstallerElevated(string installScriptPath)
    {
        // Run install.ps1 as Administrator. UAC will prompt the
        // user. If they decline, the elevated process never starts
        // and we get an exception below -- caller decides how to
        // surface that.
        //
        // -ExecutionPolicy Bypass: needed because install.ps1 isn't
        // signed and the default policy would block it.
        // -NoProfile: don't load the user's PowerShell profile, which
        // could be slow or have side effects.
        // -File: invoke the script with no remaining args.
        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            UseShellExecute = true,         // required for Verb=runas
            Verb = "runas",
            Arguments = $"-ExecutionPolicy Bypass -NoProfile -File \"{installScriptPath}\"",
            // No WindowStyle: leave PowerShell's normal window so the
            // user can see install progress. The installer takes
            // ~30s and the visible console reassures them it's working.
        };

        // Process.Start can throw Win32Exception with HRESULT
        // 0x800704C7 (1223) when the user clicks "No" on the UAC
        // prompt. We let that propagate so the caller can show
        // a friendly message.
        Process.Start(psi);
    }
}
