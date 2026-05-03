using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using NoteControl.Shared.Admin;
using NoteControl.Tray.Admin.Client;

namespace NoteControl.Tray.Admin.Windows;

/// <summary>
/// Backups admin window. Shows last-run status, the list of
/// existing backups in the configured target folder, and lets the
/// admin run a backup now / open the target folder in Explorer /
/// delete a backup / restore a vault from a backup.
/// <para>
/// Works alongside the Server Settings window, where the Backups
/// tab configures the target path and retention.
/// </para>
/// </summary>
public partial class BackupsWindow : Window
{
    private readonly IAdminClient _client;
    private bool _isBusy;

    public BackupsWindow(IAdminClient client)
    {
        _client = client;
        InitializeComponent();
        Loaded += async (_, _) => await ReloadAsync();
    }

    // -------------------------------------------------------------
    // Reload — refreshes status + list together. Called on open
    // and after every mutating action.
    // -------------------------------------------------------------

    private async Task ReloadAsync()
    {
        if (_isBusy) return;
        SetBusy(true, "Loading…");
        try
        {
            var status = await _client.GetBackupStatusAsync();
            var list = await _client.ListBackupsAsync();
            ApplyStatus(status);
            ApplyList(list);
            SetBusy(false, "");
        }
        catch (AdminClientException ex)
        {
            SetBusy(false, "");
            MessageBox.Show(this, "Could not load backups: " + ex.Message,
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void ApplyStatus(BackupStatusDto s)
    {
        TargetPathText.Text = string.IsNullOrEmpty(s.CurrentTargetPath)
            ? "(not configured — set it in Server Settings → Backups)"
            : s.CurrentTargetPath;

        if (s.LastRunAt is null)
        {
            LastRunText.Text = "Never (no backup has run since this server started)";
        }
        else
        {
            var when = s.LastRunAt.Value.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss");
            var outcome = s.LastRunSuccess == true
                ? "✓ succeeded"
                : "✗ failed: " + (s.LastRunError ?? "(no error message)");
            var dur = s.LastRunDurationMs is null ? "" : $" ({s.LastRunDurationMs} ms)";
            LastRunText.Text = $"{when} — {outcome}{dur}";
        }

        CountText.Text = s.BackupCount.ToString();
        TotalSizeText.Text = FormatBytes(s.TotalBytes);

        // Disable Run if no target is configured. Keep the Run
        // button visible so the disabled state hints at the
        // missing config.
        RunNowButton.IsEnabled = !string.IsNullOrEmpty(s.CurrentTargetPath) && !s.Running;
        OpenFolderButton.IsEnabled = !string.IsNullOrEmpty(s.CurrentTargetPath)
            && Directory.Exists(s.CurrentTargetPath);
    }

    private void ApplyList(IReadOnlyList<BackupListItemDto> list)
    {
        // Project to view-models with display strings so the grid
        // can bind directly without value converters.
        var rows = list.Select(b => new BackupRow
        {
            Source = b,
            CreatedAtDisplay = b.CreatedAt.ToLocalTime().ToString("yyyy-MM-dd HH:mm"),
            Id = b.Id,
            SizeDisplay = FormatBytes(b.SizeBytes),
            VaultsDisplay = string.Join(", ", b.VaultFolders),
        }).ToList();
        BackupGrid.ItemsSource = rows;
    }

    // -------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------

    private async void RunNowButton_Click(object sender, RoutedEventArgs e)
    {
        if (_isBusy) return;
        SetBusy(true, "Running backup… this may take a while for large vaults.");
        try
        {
            var result = await _client.RunBackupAsync();
            if (result.Success)
            {
                SetBusy(false, $"✓ Backup {result.BackupId} created in {result.DurationMs} ms ({FormatBytes(result.BytesCopied)}).");
            }
            else
            {
                SetBusy(false, "");
                MessageBox.Show(this,
                    "Backup failed:\n\n" + (result.Error ?? "(no error message)"),
                    "NoteControl", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            await ReloadAsync();
        }
        catch (AdminClientException ex)
        {
            SetBusy(false, "");
            MessageBox.Show(this, "Run-now failed: " + ex.Message,
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OpenFolderButton_Click(object sender, RoutedEventArgs e)
    {
        // Launch Explorer at the target path. Best-effort — if the
        // path is on a UNC share that's currently unreachable,
        // Explorer will show its own error dialog.
        if (TargetPathText.Text is not { Length: > 0 } || !Directory.Exists(TargetPathText.Text))
        {
            MessageBox.Show(this,
                "Target folder isn't available.",
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = $"\"{TargetPathText.Text}\"",
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Could not open Explorer: " + ex.Message,
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private async void DeleteButton_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button btn || btn.Tag is not BackupRow row) return;
        if (_isBusy) return;

        var confirm = MessageBox.Show(this,
            $"Delete backup {row.Id}?\n\nThis removes the entire folder from disk. Restorable only if you have another copy elsewhere.",
            "NoteControl", MessageBoxButton.OKCancel, MessageBoxImage.Warning);
        if (confirm != MessageBoxResult.OK) return;

        SetBusy(true, "Deleting…");
        try
        {
            await _client.DeleteBackupAsync(row.Id);
            SetBusy(false, $"Deleted {row.Id}.");
            await ReloadAsync();
        }
        catch (AdminClientException ex)
        {
            SetBusy(false, "");
            MessageBox.Show(this, "Delete failed: " + ex.Message,
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void RestoreButton_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button btn || btn.Tag is not BackupRow row) return;

        // Open the dedicated dialog. It does its own confirmation
        // pass with two checkboxes the user has to tick — restore
        // is destructive enough to deserve the friction.
        var dlg = new RestoreVaultDialog(_client, row.Source) { Owner = this };
        var ok = dlg.ShowDialog();
        if (ok == true)
        {
            // Refresh so the status block reflects whatever just
            // happened. (List doesn't change — restore doesn't add
            // or remove backups.)
            _ = ReloadAsync();
        }
    }

    private async void ReloadButton_Click(object sender, RoutedEventArgs e)
    {
        await ReloadAsync();
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e) => Close();

    // -------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------

    private void SetBusy(bool busy, string message)
    {
        _isBusy = busy;
        RunNowButton.IsEnabled = !busy;
        BackupGrid.IsEnabled = !busy;
        RunStatusText.Text = message;
    }

    private static string FormatBytes(long bytes)
    {
        // Tiny human-readable formatter. Good enough for "is this
        // 50 MB or 50 GB" recognition; precision past one decimal
        // doesn't help the admin make decisions.
        if (bytes < 1024) return $"{bytes} B";
        double kb = bytes / 1024.0;
        if (kb < 1024) return $"{kb:F1} KB";
        double mb = kb / 1024.0;
        if (mb < 1024) return $"{mb:F1} MB";
        return $"{mb / 1024.0:F2} GB";
    }

    /// <summary>
    /// Row VM for the DataGrid. Holds the original DTO plus
    /// pre-formatted display strings so XAML bindings stay simple.
    /// </summary>
    private sealed class BackupRow
    {
        public BackupListItemDto Source { get; set; } = default!;
        public string CreatedAtDisplay { get; set; } = "";
        public string Id { get; set; } = "";
        public string SizeDisplay { get; set; } = "";
        public string VaultsDisplay { get; set; } = "";
    }
}
