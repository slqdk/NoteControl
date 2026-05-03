using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace NoteControl.Tray.Updates;

/// <summary>
/// Modal dialog shown when the user picks "Update available..." from
/// the tray. Displays version + release notes, and on Install Now:
///   1. Disables the buttons,
///   2. Shows a progress bar,
///   3. Runs UpdateInstaller.RunAsync,
///   4. Shuts the application down so the new install.ps1 can replace
///      tray.exe without file-lock errors.
/// </summary>
public partial class UpdateWindow : Window
{
    // Constructor + field are internal because UpdateCheckResult is
    // internal. We could make UpdateCheckResult public but there's
    // no benefit; nothing outside the assembly should construct
    // this dialog. Class itself is public to satisfy WPF's XAML
    // code generation conventions (it expects the partial type to
    // be public; we simply don't expose any constructors that
    // outsiders could use).
    private readonly UpdateCheckResult _result;
    private CancellationTokenSource? _cts;

    internal UpdateWindow(UpdateCheckResult result)
    {
        InitializeComponent();
        _result = result;
        Loaded += (_, _) => Populate();
    }

    private void Populate()
    {
        InstalledText.Text = _result.Installed?.ToString() ?? "(unknown)";
        AvailableText.Text = _result.Latest?.ToString() ?? "(unknown)";

        // Release name fallback: tag if no name set on the release.
        if (!string.IsNullOrEmpty(_result.ReleaseName))
        {
            HeadlineText.Text = $"Update available: {_result.ReleaseName}";
        }

        // Release notes: shown as plain text; the markdown isn't
        // rendered by the tray, but most release notes are readable
        // as-is. The "Open release page" button below offers the
        // properly-rendered version.
        var notes = _result.ReleaseNotes;
        if (string.IsNullOrWhiteSpace(notes))
        {
            notes = "(No release notes provided. Open the release page for details.)";
        }
        NotesText.Text = notes;

        // Disable the release page button if we don't have a URL
        // (shouldn't happen in practice, but defensive).
        ReleasePageButton.IsEnabled = !string.IsNullOrEmpty(_result.ReleasePageUrl);
    }

    // -------------------------------------------------------------
    // Button handlers
    // -------------------------------------------------------------

    private void Later_Click(object sender, RoutedEventArgs e)
    {
        // Just close; the menu's update item will still be there
        // for the user to come back to. We don't persist a
        // "snoozed-until" timestamp -- if they want to be nagged
        // again immediately, fine; if not, they'll just ignore
        // the menu item.
        DialogResult = false;
        Close();
    }

    private async void Install_Click(object sender, RoutedEventArgs e)
    {
        // Disable buttons so a frantic double-click doesn't kick
        // off two parallel downloads.
        InstallButton.IsEnabled = false;
        LaterButton.IsEnabled = false;
        ReleasePageButton.IsEnabled = false;

        ProgressPanel.Visibility = Visibility.Visible;
        ProgressText.Text = "Starting...";
        ProgressBar.Value = 0;

        _cts = new CancellationTokenSource();
        var progress = new Progress<UpdateInstaller.Progress>(p =>
        {
            // Marshalled to UI thread automatically by Progress<T>.
            ProgressText.Text = p.Phase + (p.Percent >= 0 ? $" ({p.Percent}%)" : "...");
            if (p.Percent >= 0)
            {
                ProgressBar.IsIndeterminate = false;
                ProgressBar.Value = p.Percent;
            }
            else
            {
                ProgressBar.IsIndeterminate = true;
            }
        });

        try
        {
            var installer = new UpdateInstaller(_result);
            await installer.RunAsync(progress, _cts.Token);

            // RunAsync returned successfully -> install.ps1 has been
            // launched (separate elevated process). Now we shut the
            // tray down so install.ps1 can replace tray.exe without
            // a file-lock error. install.ps1 will re-launch the new
            // tray when it's done.
            //
            // ApplicationCommands.Close on the window only closes
            // the window; we want the whole app to exit. Application.
            // Current.Shutdown() is the correct primitive.
            Application.Current.Shutdown(0);
        }
        catch (OperationCanceledException)
        {
            ProgressText.Text = "Cancelled.";
            ResetForRetry();
        }
        catch (System.ComponentModel.Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            // 1223 = ERROR_CANCELLED, the UAC "No" response. Not a
            // real error from our perspective; the user just changed
            // their mind. Reset the dialog so they can try again.
            ProgressText.Text = "Elevation declined. Update not installed.";
            ResetForRetry();
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[NoteControl.Tray] Update install failed: {ex}");
            ProgressText.Text = $"Failed: {ex.Message}";
            MessageBox.Show(
                "The update could not be installed:\n\n" + ex.Message +
                "\n\nYou can try again, or download the release manually from GitHub.",
                "NoteControl — Update failed",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            ResetForRetry();
        }
    }

    private void ResetForRetry()
    {
        InstallButton.IsEnabled = true;
        LaterButton.IsEnabled = true;
        ReleasePageButton.IsEnabled = !string.IsNullOrEmpty(_result.ReleasePageUrl);
        ProgressBar.IsIndeterminate = false;
        ProgressBar.Value = 0;
    }

    private void OpenReleasePage_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrEmpty(_result.ReleasePageUrl)) return;
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = _result.ReleasePageUrl,
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show("Could not open the release page: " + ex.Message,
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        _cts?.Cancel();
        _cts?.Dispose();
        base.OnClosed(e);
    }
}
