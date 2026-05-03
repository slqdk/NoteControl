using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using NoteControl.Shared.Vaults;
using NoteControl.Tray.Admin.Client;
using NoteControl.Tray.Settings;

namespace NoteControl.Tray.Admin.Windows;

public partial class VaultsWindow : Window
{
    private readonly IAdminClient _client;
    private readonly ObservableCollection<VaultRow> _rows = new();
    private readonly TrayPrefs _prefs;
    // Track whether we're currently restoring the checkbox state from
    // prefs at window-open time, so the Checked/Unchecked event handler
    // doesn't try to save+reload while we're still initializing.
    private bool _suppressCheckboxHandler;

    public VaultsWindow(IAdminClient client)
    {
        _client = client;
        _prefs = TrayPrefs.Load();
        InitializeComponent();
        VaultsGrid.ItemsSource = _rows;
        SignedInAsText.Text = client.CurrentUser is { } me
            ? $"Signed in as {me.Username}"
            : string.Empty;

        // Show the "Show all vaults" checkbox AND the "Register..."
        // button only for admins. Non-admin users have no privileged
        // listing nor the ability to register on someone else's
        // behalf -- and can already create vaults for themselves
        // via Create. Hiding both avoids dead UI.
        if (IsAdmin)
        {
            ShowAllCheckbox.Visibility = Visibility.Visible;
            RegisterButton.Visibility = Visibility.Visible;
            // Restore the persisted toggle state. _suppressCheckboxHandler
            // prevents the side effects (save + reload) that would
            // otherwise fire before Loaded does the initial reload anyway.
            _suppressCheckboxHandler = true;
            ShowAllCheckbox.IsChecked = _prefs.VaultsShowAll;
            _suppressCheckboxHandler = false;
        }

        Loaded += async (_, _) => await ReloadAsync();
    }

    private VaultRow? Selected => VaultsGrid.SelectedItem as VaultRow;

    private bool IsAdmin => _client.CurrentUser is { } me
        && string.Equals(me.Role, "admin", System.StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// True if the caller has owner-level privileges on the selected
    /// vault. The historical definition was "user is the OwnerId"; admin
    /// god-mode (step 30) extends it to "any admin, on any vault." The
    /// server enforces the same rule, so the UI just mirrors it.
    /// </summary>
    private bool CanActAsOwner => Selected is { } sel
        && _client.CurrentUser is { } me
        && (sel.OwnerId == me.Id || IsAdmin);

    private void VaultsGrid_SelectionChanged(object sender, System.Windows.Controls.SelectionChangedEventArgs e)
        => UpdateButtons();

    private void UpdateButtons()
    {
        var hasSelection = Selected is not null;
        // Members button: anyone with any role on the vault can list
        // members, AND admins can always view (server-side rule
        // mirrors this). For simplicity, enable it whenever there's
        // a selection -- the server rejects with 404 if the caller
        // really has no business viewing, which the status bar will
        // surface.
        MembersButton.IsEnabled = hasSelection;
        // Share / Delete: owner-only by default, admin override.
        ShareButton.IsEnabled  = hasSelection && CanActAsOwner;
        DeleteButton.IsEnabled = hasSelection && CanActAsOwner;
        // Open folder: any selection is fine -- this is a shell-level
        // action that opens Windows Explorer. The OS handles file-
        // system permissions; if the user lacks NTFS read access on
        // someone else's user folder, Explorer just shows an empty
        // window or a permission prompt. We don't second-guess.
        OpenFolderButton.IsEnabled = hasSelection;
        // Ship 52: Install Sample Data is owner-only with admin
        // override. Same gate as Share / Delete because it writes
        // into the vault, just additively rather than destructively.
        InstallSampleDataButton.IsEnabled = hasSelection && CanActAsOwner;
    }

    private async Task ReloadAsync()
    {
        SetStatus("Loading vaults…");
        try
        {
            // Honour the "Show all vaults" toggle. Non-admin users
            // never see the checkbox so all=false here for them.
            var showAll = ShowAllCheckbox.IsChecked == true;
            var vaults = await _client.ListVaultsAsync(all: showAll);
            _rows.Clear();
            foreach (var v in vaults)
            {
                _rows.Add(VaultRow.From(v));
            }
            SetStatus(_rows.Count == 0
                ? "No vaults yet — click Create vault to make one."
                : $"{_rows.Count} vault{(_rows.Count == 1 ? "" : "s")}.");
        }
        catch (AdminClientException ex)
        {
            SetStatus("Error: " + ex.Message);
        }
        UpdateButtons();
    }

    private async void ShowAllCheckbox_Changed(object sender, RoutedEventArgs e)
    {
        // Skip during the constructor's initial restore from prefs --
        // the Loaded handler will do the first reload anyway.
        if (_suppressCheckboxHandler) return;

        // Persist the new state immediately so a crash / process kill
        // mid-session doesn't lose the user's choice.
        _prefs.VaultsShowAll = ShowAllCheckbox.IsChecked == true;
        _prefs.Save();

        await ReloadAsync();
    }

    private async void RefreshButton_Click(object sender, RoutedEventArgs e) => await ReloadAsync();

    private async void CreateButton_Click(object sender, RoutedEventArgs e)
    {
        if (_client.CurrentUser is not { } me) return;

        // Fetch the user list so the dialog can offer an owner picker.
        // Non-admin: the users endpoint returns 403, so we fall back to
        // a single-entry list (just `me`) and pass isAdmin=false. The
        // dialog will lock the dropdown to the current user, matching
        // pre-step-29 behaviour.
        IReadOnlyList<NoteControl.Shared.Auth.UserDto> users;
        var isAdmin = string.Equals(me.Role, "admin", System.StringComparison.OrdinalIgnoreCase);
        if (isAdmin)
        {
            try
            {
                users = await _client.ListUsersAsync();
            }
            catch (AdminClientException ex)
            {
                SetStatus("Couldn't load user list: " + ex.Message);
                // Still let them create their own vault as a fallback.
                users = new[] { me };
            }
        }
        else
        {
            // Non-admin: just themselves. Saves a 403 round-trip.
            users = new[] { me };
        }

        var dialog = new CreateVaultDialog(users, me, isAdmin) { Owner = this };
        if (dialog.ShowDialog() == true)
        {
            await CallAsync(
                () => _client.CreateVaultAsync(dialog.BuildRequest()),
                onSuccess: v => SetStatus($"Created {v.Path}."));
            await ReloadAsync();
        }
    }

    private async void RegisterButton_Click(object sender, RoutedEventArgs e)
    {
        if (_client.CurrentUser is not { } me) return;
        // Admin-only button (visibility set in constructor); double-
        // check anyway so an unexpected non-admin click can't sneak
        // through.
        if (!IsAdmin) return;

        // The dialog needs the user list so its owner picker has
        // someone to choose from. Same fetch-with-fallback pattern as
        // CreateButton_Click.
        IReadOnlyList<NoteControl.Shared.Auth.UserDto> users;
        try
        {
            users = await _client.ListUsersAsync();
        }
        catch (AdminClientException ex)
        {
            SetStatus("Couldn't load user list: " + ex.Message);
            users = new[] { me };
        }

        var dialog = new RegisterVaultDialog(users, me) { Owner = this };
        if (dialog.ShowDialog() == true)
        {
            await CallAsync(
                () => _client.RegisterVaultAsync(dialog.BuildRequest()),
                onSuccess: v => SetStatus(
                    $"Registered {v.Path}. Search index is rebuilding in the background."));
            await ReloadAsync();
        }
    }

    private void MembersButton_Click(object sender, RoutedEventArgs e)
    {
        var sel = Selected; if (sel is null) return;
        // Pass CanActAsOwner so admins inherit owner privileges in
        // the members sub-window (add/remove members on any vault),
        // not just literal owners.
        var window = new VaultMembersWindow(_client, sel.Id, sel.Path, CanActAsOwner) { Owner = this };
        window.ShowDialog();
    }

    private async void ShareButton_Click(object sender, RoutedEventArgs e)
    {
        var sel = Selected; if (sel is null) return;
        var dialog = new ShareVaultDialog(sel.Path) { Owner = this };
        if (dialog.ShowDialog() == true)
        {
            await CallAsync(
                () => _client.ShareVaultAsync(sel.Id, dialog.BuildRequest()),
                onSuccess: m => SetStatus($"Shared with {m.Username} as {m.Role}."));
        }
    }

    private async void DeleteButton_Click(object sender, RoutedEventArgs e)
    {
        var sel = Selected; if (sel is null) return;
        var confirm = MessageBox.Show(
            this,
            $"Delete the vault at '{sel.Path}'?\n\n" +
            "The folder is moved to a quarantine subfolder named .deleted next to it; " +
            "the database row and all permissions are removed. " +
            "Notes inside are not destroyed but the vault becomes invisible to NoteControl.",
            "Confirm delete",
            MessageBoxButton.OKCancel,
            MessageBoxImage.Warning);
        if (confirm != MessageBoxResult.OK) return;

        await CallAsync(
            () => _client.DeleteVaultAsync(sel.Id),
            onSuccess: () => SetStatus($"Deleted {sel.Path}."));
        await ReloadAsync();
    }

    private void OpenFolderButton_Click(object sender, RoutedEventArgs e)
    {
        var sel = Selected; if (sel is null) return;

        // Resolve the vault's relative path (as returned by the API) to
        // an absolute Windows path on this machine. This works because
        // the tray runs on the same machine as the server -- single-
        // machine deployment is the only deployment story today. If we
        // ever go multi-machine, the server would need to return the
        // absolute path in the DTO instead.
        var absolute = TrayPaths.ResolveVaultFolder(sel.Path);
        if (absolute is null)
        {
            SetStatus("Could not resolve the data folder. NC_DATA_ROOT may be unset and %ProgramData% is missing.");
            return;
        }

        if (!Directory.Exists(absolute))
        {
            // Possible if the folder was moved or deleted out from
            // under the server. Surface the path so the user can go
            // looking for it manually.
            SetStatus($"Folder not found on disk: {absolute}");
            return;
        }

        try
        {
            // UseShellExecute=true lets Windows pick the right handler
            // for the path -- which for a folder is Explorer. This is
            // the same pattern AboutWindow uses for its "Open data
            // folder" button.
            Process.Start(new ProcessStartInfo { FileName = absolute, UseShellExecute = true });
            SetStatus($"Opened {absolute} in Explorer.");
        }
        catch (System.Exception ex)
        {
            SetStatus("Could not open: " + ex.Message);
        }
    }

    /// <summary>
    /// Ship 52: install bundled sample data into the selected vault.
    /// Always-overwrite semantics (per the design choice) — the
    /// confirmation dialog warns explicitly so the user can opt out.
    /// On success, surface the file/folder counts in the status bar.
    /// </summary>
    private async void InstallSampleDataButton_Click(object sender, RoutedEventArgs e)
    {
        var sel = Selected; if (sel is null) return;

        var confirm = MessageBox.Show(
            this,
            $"Install sample data into '{sel.Path}'?\n\n" +
            "This creates the folders 'Welcome', 'Examples', and 'Daily journal' " +
            "with a few sample notes inside each, demonstrating headings, code " +
            "blocks (incl. Structured Text), tables, callouts, and links.\n\n" +
            "If you've already installed the sample data and edited any of the " +
            "sample notes, your edits will be overwritten. Notes you've added " +
            "(with different filenames) are not touched.",
            "Install Sample Data",
            MessageBoxButton.OKCancel,
            MessageBoxImage.Information);
        if (confirm != MessageBoxResult.OK) return;

        await CallAsync(
            () => _client.InstallSampleDataAsync(sel.Id),
            onSuccess: r => SetStatus(
                $"Installed sample data into {sel.Path} — wrote {r.FilesWritten} note{(r.FilesWritten == 1 ? "" : "s")}, " +
                $"created {r.FoldersCreated} new folder{(r.FoldersCreated == 1 ? "" : "s")}. " +
                "Search index is rebuilding in the background."));
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e) => Close();

    private void SetStatus(string text) => StatusText.Text = text;

    private async Task CallAsync<T>(Func<Task<T>> op, Action<T>? onSuccess = null)
    {
        IsEnabled = false;
        try
        {
            var result = await op();
            onSuccess?.Invoke(result);
        }
        catch (AdminClientException ex)
        {
            SetStatus("Error: " + ex.Message);
            MessageBox.Show(this, ex.Message, "NoteControl",
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally
        {
            IsEnabled = true;
        }
    }

    private async Task CallAsync(Func<Task> op, Action? onSuccess = null)
    {
        IsEnabled = false;
        try
        {
            await op();
            onSuccess?.Invoke();
        }
        catch (AdminClientException ex)
        {
            SetStatus("Error: " + ex.Message);
            MessageBox.Show(this, ex.Message, "NoteControl",
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally
        {
            IsEnabled = true;
        }
    }
}

public sealed class VaultRow
{
    public Guid Id { get; init; }
    public string Path { get; init; } = "";
    public string Name { get; init; } = "";
    public string Scope { get; init; } = "";
    public Guid OwnerId { get; init; }
    public string OwnerUsername { get; init; } = "";
    public string MyRole { get; init; } = "";
    public DateTimeOffset CreatedAt { get; init; }

    public string CreatedDisplay => CreatedAt.ToLocalTime().ToString("yyyy-MM-dd");

    public static VaultRow From(VaultDto v) => new()
    {
        Id = v.Id,
        Path = v.Path,
        Name = v.Name,
        Scope = v.Scope,
        OwnerId = v.OwnerId,
        OwnerUsername = v.OwnerUsername,
        MyRole = v.MyRole,
        CreatedAt = v.CreatedAt,
    };
}
