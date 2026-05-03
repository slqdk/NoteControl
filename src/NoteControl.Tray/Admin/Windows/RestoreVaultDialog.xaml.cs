using System.Windows;
using System.Windows.Controls;
using NoteControl.Shared.Admin;
using NoteControl.Shared.Vaults;
using NoteControl.Tray.Admin.Client;

namespace NoteControl.Tray.Admin.Windows;

/// <summary>
/// Dialog the user steps through to perform a vault restore. The
/// flow is intentionally friction-y:
/// </summary>
/// <list type="number">
///   <item>Pick the source vault folder (one of the vaults that
///     exists inside the backup).</item>
///   <item>Pick the target live vault. We pre-select by relative
///     path match — if the backup folder is <c>users/admin/Default</c>
///     and a live vault has that path, that's the default.</item>
///   <item>Tick TWO acknowledgement checkboxes.</item>
///   <item>Click Restore. The button is disabled until both
///     checkboxes are ticked and both pickers have selections.</item>
/// </list>
public partial class RestoreVaultDialog : Window
{
    private readonly IAdminClient _client;
    private readonly BackupListItemDto _backup;
    private bool _isBusy;

    public RestoreVaultDialog(IAdminClient client, BackupListItemDto backup)
    {
        _client = client;
        _backup = backup;
        InitializeComponent();
        Loaded += async (_, _) => await LoadAsync();
    }

    private async Task LoadAsync()
    {
        BackupIdText.Text = _backup.Id;
        CreatedAtText.Text = _backup.CreatedAt.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss");

        // Source vault folders come from the backup record itself —
        // already populated by the server when listing backups.
        SourceVaultBox.ItemsSource = _backup.VaultFolders;
        if (_backup.VaultFolders.Count > 0)
        {
            SourceVaultBox.SelectedIndex = 0;
        }

        // Target live vaults — fetch from the server.
        try
        {
            var liveVaults = await _client.ListVaultsAsync();
            var rows = liveVaults
                .Select(v => new TargetVaultRow
                {
                    VaultId = v.Id,
                    Path = v.Path,
                    DisplayName = $"{v.Name}  ·  {v.Path}",
                })
                .ToList();
            TargetVaultBox.ItemsSource = rows;

            // Pre-select by path match if the source vault folder
            // matches a live vault's path.
            PreselectTargetByPath();
        }
        catch (AdminClientException ex)
        {
            StatusText.Text = "Could not load live vaults: " + ex.Message;
        }

        UpdateRestoreEnabled();
    }

    private void PreselectTargetByPath()
    {
        if (SourceVaultBox.SelectedItem is not string sourcePath) return;
        if (TargetVaultBox.ItemsSource is not IEnumerable<TargetVaultRow> rows) return;

        // Source paths use forward slashes (the backup record's
        // shape); live vault Paths are stored the same way.
        var match = rows.FirstOrDefault(r =>
            string.Equals(r.Path, sourcePath, StringComparison.OrdinalIgnoreCase));
        if (match is not null)
        {
            TargetVaultBox.SelectedItem = match;
        }
    }

    // -------------------------------------------------------------
    // Handlers
    // -------------------------------------------------------------

    private void SourceVaultBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        // Re-pre-select target when source changes.
        PreselectTargetByPath();
        UpdateRestoreEnabled();
    }

    private void ConfirmCheckbox_Click(object sender, RoutedEventArgs e)
    {
        UpdateRestoreEnabled();
    }

    private void UpdateRestoreEnabled()
    {
        var hasSource = SourceVaultBox.SelectedItem is string;
        var hasTarget = TargetVaultBox.SelectedItem is TargetVaultRow;
        var confirmed = (Confirm1Box.IsChecked == true) && (Confirm2Box.IsChecked == true);
        RestoreButton.IsEnabled = !_isBusy && hasSource && hasTarget && confirmed;
    }

    private async void RestoreButton_Click(object sender, RoutedEventArgs e)
    {
        if (_isBusy) return;
        if (SourceVaultBox.SelectedItem is not string sourceFolder) return;
        if (TargetVaultBox.SelectedItem is not TargetVaultRow target) return;

        // Last-chance confirmation. Same shape as the delete-folder
        // prompt elsewhere — short, clear, OK / Cancel.
        var confirm = MessageBox.Show(this,
            $"Restore '{sourceFolder}' from backup {_backup.Id}\n" +
            $"into live vault '{target.DisplayName}'?\n\n" +
            "Current vault data will be moved aside as " +
            $"{target.Path}.pre-restore-<timestamp>/.",
            "Confirm restore",
            MessageBoxButton.OKCancel,
            MessageBoxImage.Warning);
        if (confirm != MessageBoxResult.OK) return;

        SetBusy(true, "Restoring… this may take a while for large vaults.");
        try
        {
            var result = await _client.RestoreVaultFromBackupAsync(
                _backup.Id, target.VaultId, sourceFolder);

            if (result.Success)
            {
                ResultPanel.Visibility = Visibility.Visible;
                ResultText.Text =
                    $"✓ Restore complete in {result.DurationMs} ms.\n\n" +
                    "Pre-restore data: " +
                    (result.PreRestoreFolderPath ?? "(none — vault was empty)") + "\n\n" +
                    "Tell any users with this vault open in their browser to refresh.";

                StatusText.Text = "Restore complete.";
                RestoreButton.IsEnabled = false;
                DialogResult = true;
            }
            else
            {
                ResultPanel.Background = System.Windows.Media.Brushes.MistyRose;
                ResultPanel.BorderBrush = System.Windows.Media.Brushes.IndianRed;
                ResultPanel.Visibility = Visibility.Visible;
                ResultText.Text = "✗ Restore failed.\n\n" + (result.Error ?? "(no error)") +
                    (result.PreRestoreFolderPath is null
                        ? ""
                        : "\n\nPre-restore data may exist at: " + result.PreRestoreFolderPath);
                StatusText.Text = "";
                SetBusy(false, "");
            }
        }
        catch (AdminClientException ex)
        {
            SetBusy(false, "");
            MessageBox.Show(this, "Restore failed: " + ex.Message,
                "NoteControl", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e) => Close();

    // -------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------

    private void SetBusy(bool busy, string message)
    {
        _isBusy = busy;
        UpdateRestoreEnabled();
        StatusText.Text = message;
    }

    /// <summary>
    /// Row VM for the live-vault dropdown. Holds the id (passed to
    /// the API) plus a friendly display string.
    /// </summary>
    private sealed class TargetVaultRow
    {
        public Guid VaultId { get; set; }
        public string Path { get; set; } = "";
        public string DisplayName { get; set; } = "";
    }
}
