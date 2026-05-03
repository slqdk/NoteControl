using System.Collections.ObjectModel;
using System.Windows;
using NoteControl.Shared.Auth;
using NoteControl.Tray.Admin.Client;

namespace NoteControl.Tray.Admin.Windows;

public partial class UsersWindow : Window
{
    private readonly IAdminClient _client;
    private readonly ObservableCollection<UserRow> _rows = new();

    public UsersWindow(IAdminClient client)
    {
        _client = client;
        InitializeComponent();
        UsersGrid.ItemsSource = _rows;
        SignedInAsText.Text = client.CurrentUser is { } me
            ? $"Signed in as {me.Username}"
            : string.Empty;
        Loaded += async (_, _) => await ReloadAsync();
    }

    // -----------------------------------------------------------------
    // Loading
    // -----------------------------------------------------------------

    private async Task ReloadAsync()
    {
        SetStatus("Loading users…");
        try
        {
            var users = await _client.ListUsersAsync();
            _rows.Clear();
            foreach (var u in users)
            {
                _rows.Add(UserRow.From(u));
            }
            SetStatus($"{_rows.Count} user{(_rows.Count == 1 ? "" : "s")}.");
        }
        catch (AdminClientException ex)
        {
            SetStatus("Error: " + ex.Message);
        }
        UpdateButtons();
    }

    // -----------------------------------------------------------------
    // Selection-driven button state
    // -----------------------------------------------------------------

    private UserRow? Selected => UsersGrid.SelectedItem as UserRow;

    private void UsersGrid_SelectionChanged(object sender, System.Windows.Controls.SelectionChangedEventArgs e)
        => UpdateButtons();

    private void UpdateButtons()
    {
        var sel = Selected;
        var hasSelection = sel is not null;
        EditButton.IsEnabled     = hasSelection;
        ResetButton.IsEnabled    = hasSelection;
        SessionsButton.IsEnabled = hasSelection;
        DeleteButton.IsEnabled   = hasSelection;
        DisableButton.IsEnabled  = hasSelection && !string.Equals(sel!.Status, "disabled", StringComparison.OrdinalIgnoreCase);
        EnableButton.IsEnabled   = hasSelection && !string.Equals(sel!.Status, "active",   StringComparison.OrdinalIgnoreCase);
    }

    // -----------------------------------------------------------------
    // Action handlers
    // -----------------------------------------------------------------

    private async void RefreshButton_Click(object sender, RoutedEventArgs e) => await ReloadAsync();

    private async void AddButton_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new AddUserDialog { Owner = this };
        if (dialog.ShowDialog() == true)
        {
            await CallAsync(
                () => _client.CreateUserAsync(dialog.BuildRequest()),
                onSuccess: u => SetStatus($"Created {u.Username}."));
            await ReloadAsync();
        }
    }

    private async void EditButton_Click(object sender, RoutedEventArgs e)
    {
        var sel = Selected; if (sel is null) return;
        var dialog = new EditUserDialog(sel.ToDto()) { Owner = this };
        if (dialog.ShowDialog() == true)
        {
            await CallAsync(
                () => _client.UpdateUserAsync(sel.Id, dialog.BuildRequest()),
                onSuccess: u => SetStatus($"Updated {u.Username}."));
            await ReloadAsync();
        }
    }

    private async void ResetButton_Click(object sender, RoutedEventArgs e)
    {
        var sel = Selected; if (sel is null) return;
        var dialog = new ResetPasswordDialog(sel.Username) { Owner = this };
        if (dialog.ShowDialog() == true)
        {
            await CallAsync(
                () => _client.ChangePasswordAsync(sel.Id, dialog.BuildRequest()),
                onSuccess: () => SetStatus($"Password reset for {sel.Username}. Existing sessions revoked."));
        }
    }

    private void SessionsButton_Click(object sender, RoutedEventArgs e)
    {
        var sel = Selected; if (sel is null) return;
        var window = new SessionsWindow(_client, sel.Id, sel.Username) { Owner = this };
        window.ShowDialog();
        // No reload — sessions don't show up in the user grid.
    }

    private async void DisableButton_Click(object sender, RoutedEventArgs e)
        => await SetStatusAsync("disabled");

    private async void EnableButton_Click(object sender, RoutedEventArgs e)
        => await SetStatusAsync("active");

    private async Task SetStatusAsync(string newStatus)
    {
        var sel = Selected; if (sel is null) return;
        await CallAsync(
            () => _client.UpdateUserAsync(sel.Id, new UpdateUserRequest(Email: null, Role: null, Status: newStatus)),
            onSuccess: u => SetStatus($"{u.Username} is now {u.Status}."));
        await ReloadAsync();
    }

    private async void DeleteButton_Click(object sender, RoutedEventArgs e)
    {
        var sel = Selected; if (sel is null) return;
        var confirm = MessageBox.Show(
            this,
            $"Delete user '{sel.Username}'?\n\nThis revokes their sessions and removes their account record. " +
            "Vault data on disk is not touched.",
            "Confirm delete",
            MessageBoxButton.OKCancel,
            MessageBoxImage.Warning);
        if (confirm != MessageBoxResult.OK) return;

        await CallAsync(
            () => _client.DeleteUserAsync(sel.Id),
            onSuccess: () => SetStatus($"Deleted {sel.Username}."));
        await ReloadAsync();
    }

    private async void SignOutButton_Click(object sender, RoutedEventArgs e)
    {
        try { await _client.LogoutAsync(); } catch { /* ignore */ }
        Close();
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    private void SetStatus(string text) => StatusText.Text = text;

    /// <summary>
    /// Runs an async operation, showing errors as a status message and a
    /// MessageBox. Generic over the return type so call sites can stay terse.
    /// </summary>
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

    /// <summary>Overload for void-returning operations.</summary>
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

/// <summary>
/// View-model row for the DataGrid. Adds display strings derived from the
/// raw DTO so binding stays simple in XAML.
/// </summary>
public sealed class UserRow
{
    public Guid Id { get; init; }
    public string Username { get; init; } = "";
    public string Email { get; init; } = "";
    public string Role { get; init; } = "";
    public string Status { get; init; } = "";
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? LastLoginAt { get; init; }

    public string LastLoginDisplay => LastLoginAt is { } t
        ? t.ToLocalTime().ToString("yyyy-MM-dd HH:mm")
        : "(never)";

    public string CreatedDisplay => CreatedAt.ToLocalTime().ToString("yyyy-MM-dd");

    public static UserRow From(UserDto u) => new()
    {
        Id = u.Id,
        Username = u.Username,
        Email = u.Email,
        Role = u.Role,
        Status = u.Status,
        CreatedAt = u.CreatedAt,
        LastLoginAt = u.LastLoginAt,
    };

    public UserDto ToDto() => new(Id, Username, Email, Role, Status, CreatedAt, LastLoginAt);
}
