using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Documents;
using NoteControl.Tray.Admin.Client;
using NoteControl.Tray.Server;
using NoteControl.Tray.Settings;

namespace NoteControl.Tray.Admin.Windows;

/// <summary>
/// About window. Shows name + version + build info + a few useful
/// "open this folder" shortcuts. Doesn't talk to the server — all
/// the data shown comes from the tray process itself or from
/// well-known paths.
/// <para>
/// Step 49: the "Check for updates" button is now wired up. It
/// delegates to App.TriggerManualUpdateCheckAsync(), which runs a
/// fresh check and either shows a MessageBox ("Up to date" / error)
/// or opens the UpdateWindow.
/// </para>
/// </summary>
public partial class AboutWindow : Window
{
    private const string LogsFolderSubpath = @"NoteControl\logs";

    // Constructor signature matches the other admin windows
    // (IAdminClient passed in) so the AdminWorkflow.OpenSingle
    // helper can construct it the same way. Today About doesn't
    // actually call the server — but if a future "check for
    // updates" lands, the client is right there.
    #pragma warning disable IDE0060 // Unused parameter — see comment above.
    public AboutWindow(IAdminClient client)
    #pragma warning restore IDE0060
    {
        InitializeComponent();
        Loaded += (_, _) => Populate();
    }

    private void Populate()
    {
        var asm = Assembly.GetExecutingAssembly();

        // Version: prefer the AssemblyInformationalVersion (which
        // includes git hash + suffix when set by the build), fall
        // back to the regular version.
        var infoAttr = asm.GetCustomAttribute<AssemblyInformationalVersionAttribute>();
        var version = infoAttr?.InformationalVersion
            ?? asm.GetName().Version?.ToString()
            ?? "(unknown)";
        VersionText.Text = version;

        // Build date: use the assembly's last-write timestamp on
        // disk. Not bulletproof (a "touch" of the file would shift
        // it) but good enough for "is this last week's build or
        // last year's?" — and zero infrastructure.
        try
        {
            var path = asm.Location;
            if (!string.IsNullOrEmpty(path) && File.Exists(path))
            {
                var ts = File.GetLastWriteTime(path);
                BuildDateText.Text = "Built: " + ts.ToString("yyyy-MM-dd HH:mm");
            }
        }
        catch { /* ignored — diagnostic field, not critical */ }

        // Step 43: read the resolved tray URL fresh each time the
        // About window opens. This window can outlive a port
        // change if the user reopens it, so reading at Populate()
        // time gives slightly fresher data than reading at App
        // startup. (Still requires the SERVER to have been
        // restarted after the port change; the tray's HTTP client
        // would still be on the old URL until tray restart.)
        var resolved = ServerUrlResolver.Resolve();
        ServerUrlText.Text = resolved.TrayUrl;
        DataRootText.Text = TrayPaths.ResolveDataRoot() ?? "(unknown)";
        DotNetText.Text = RuntimeInformation.FrameworkDescription;
        OsText.Text = RuntimeInformation.OSDescription + " (" +
            RuntimeInformation.ProcessArchitecture + ")";
        PidText.Text = Environment.ProcessId.ToString();
    }

    private static string ResolveLogsFolder()
    {
        var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        return string.IsNullOrEmpty(programData)
            ? ""
            : Path.Combine(programData, LogsFolderSubpath);
    }

    // -------------------------------------------------------------
    // Hyperlink handlers
    // -------------------------------------------------------------

    private void OpenLink_Click(object sender, RoutedEventArgs e)
    {
        // Spec link uses Tag to carry the relative path inside the
        // repo. Without knowing the repo root from a tray that's
        // installed elsewhere, we can only do best-effort — open
        // it with the OS's default association if the file exists
        // somewhere we can guess (next to the data folder? next to
        // the install dir?).
        if (sender is not Hyperlink link || link.Tag is not string relPath) return;

        // Try a couple of candidate locations. Stop at the first
        // one that exists.
        var candidates = new[]
        {
            // 1. Repo layout: tray runs from src/NoteControl.Tray/bin/...
            //    The spec is up four levels at docs/.
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", relPath)),
            // 2. Same directory as the tray executable.
            Path.Combine(AppContext.BaseDirectory, relPath),
        };

        foreach (var path in candidates)
        {
            if (File.Exists(path))
            {
                OpenWithShell(path);
                return;
            }
        }

        StatusText.Text = $"Could not locate {relPath} from the tray's install location. Open it directly from your repo.";
    }

    private void OpenLogsFolder_Click(object sender, RoutedEventArgs e)
    {
        var path = ResolveLogsFolder();
        if (string.IsNullOrEmpty(path) || !Directory.Exists(path))
        {
            StatusText.Text = "Logs folder not found at " + path + " (server may not have run yet).";
            return;
        }
        OpenWithShell(path);
    }

    private void OpenDataFolder_Click(object sender, RoutedEventArgs e)
    {
        var path = TrayPaths.ResolveDataRoot();
        if (path is null || !Directory.Exists(path))
        {
            StatusText.Text = "Data folder not found at " + (path ?? "(unknown)") + ".";
            return;
        }
        OpenWithShell(path);
    }

    private void OpenWithShell(string path)
    {
        try
        {
            Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true });
        }
        catch (Exception ex)
        {
            StatusText.Text = "Could not open: " + ex.Message;
        }
    }

    // -------------------------------------------------------------
    // Step 49: Check for updates handler
    // -------------------------------------------------------------

    private async void CheckUpdates_Click(object sender, RoutedEventArgs e)
    {
        if (Application.Current is not App app)
        {
            StatusText.Text = "Update check unavailable (no application root).";
            return;
        }

        // Disable while in flight; re-enable in the finally so a
        // user can retry after a transient failure.
        CheckUpdatesButton.IsEnabled = false;
        StatusText.Text = "Checking GitHub for updates...";
        try
        {
            await app.TriggerManualUpdateCheckAsync();
            // App handles all UI feedback for the result (MessageBox
            // for no-update / errors, UpdateWindow for an available
            // update). We just clear the in-flight status.
            StatusText.Text = "";
        }
        catch (Exception ex)
        {
            StatusText.Text = "Update check failed: " + ex.Message;
        }
        finally
        {
            CheckUpdatesButton.IsEnabled = true;
        }
    }

    // -------------------------------------------------------------
    // Copy diagnostics + close
    // -------------------------------------------------------------

    private void CopyDiagnostics_Click(object sender, RoutedEventArgs e)
    {
        // Plain text, easy to paste into an email or issue tracker.
        // Keeping the format simple (key: value, one per line) so
        // future-me doesn't try to parse it back.
        var lines = new[]
        {
            "NoteControl diagnostics",
            new string('-', 30),
            "Version:    " + VersionText.Text,
            BuildDateText.Text,
            "Server URL: " + ServerUrlText.Text,
            "Data root:  " + DataRootText.Text,
            "Logs:       " + ResolveLogsFolder(),
            ".NET:       " + DotNetText.Text,
            "OS:         " + OsText.Text,
            "Tray PID:   " + PidText.Text,
            "Local time: " + DateTimeOffset.Now.ToString("u"),
        };
        var text = string.Join(Environment.NewLine, lines.Where(l => !string.IsNullOrEmpty(l)));

        try
        {
            Clipboard.SetText(text);
            StatusText.Text = "Diagnostics copied to clipboard.";
        }
        catch (Exception ex)
        {
            // Clipboard.SetText can transiently fail on Windows
            // if another app holds the clipboard lock. Tell the
            // user instead of silently swallowing.
            StatusText.Text = "Could not copy: " + ex.Message;
        }
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e) => Close();
}
