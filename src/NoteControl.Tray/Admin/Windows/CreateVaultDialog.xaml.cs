using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using NoteControl.Shared.Auth;
using NoteControl.Shared.Vaults;

namespace NoteControl.Tray.Admin.Windows;

/// <summary>
/// "Create vault" dialog.
///
/// Admin can pick the OWNER from a dropdown -- this is the user who
/// gets the owner permission row on the new vault. Non-admin users
/// see the dropdown locked to themselves (they can only create their
/// own vaults).
///
/// Path semantics:
///   - Personal scope: the path bakes the chosen owner's username
///     in: users/<owner>/<name>. The server validates the username
///     segment against the chosen owner before creating.
///   - Shared scope: the path is shared/<name>; the dropdown still
///     matters because it controls WHO ends up with the "owner" role
///     for permission management on the resulting vault. Two admins
///     can co-exist on a shared vault, but only one OwnerId per row.
///
/// Construction expects the FULL list of active users plus the
/// currently-signed-in user (so we can pick a sensible default and
/// gate the IsEnabled state).
/// </summary>
public partial class CreateVaultDialog : Window
{
    private readonly IReadOnlyList<UserDto> _users;
    private readonly UserDto _currentUser;
    private readonly bool _isAdmin;

    public CreateVaultDialog(IReadOnlyList<UserDto> users, UserDto currentUser, bool isAdmin)
    {
        // Show only ACTIVE users in the dropdown -- creating a vault
        // owned by a disabled account doesn't make sense, and the
        // server would reject it anyway. Sort alphabetically by
        // username so the list is predictable.
        _users = users
            .Where(u => string.Equals(u.Status, "active", System.StringComparison.OrdinalIgnoreCase))
            .OrderBy(u => u.Username, System.StringComparer.OrdinalIgnoreCase)
            .ToList();

        _currentUser = currentUser;
        _isAdmin = isAdmin;

        InitializeComponent();
        Loaded += (_, _) =>
        {
            PopulateOwnerCombo();
            UpdatePathPreview();
            NameBox.Focus();
        };
    }

    private void PopulateOwnerCombo()
    {
        // Each combo item is the full UserDto so we can pull the Id +
        // Username back without re-looking-up. Display = Username.
        OwnerCombo.ItemsSource = _users;
        OwnerCombo.DisplayMemberPath = nameof(UserDto.Username);

        // Default selection = the current user. If for some reason the
        // current user isn't in the active list (e.g. their own status
        // flipped to disabled mid-session), fall back to the first
        // available user just so the dropdown isn't empty.
        var defaultIndex = _users
            .Select((u, i) => (u, i))
            .Where(t => t.u.Id == _currentUser.Id)
            .Select(t => (int?)t.i)
            .FirstOrDefault() ?? 0;

        if (_users.Count > 0)
        {
            OwnerCombo.SelectedIndex = defaultIndex;
        }

        // Non-admin users can't pick a different owner. Disable the
        // dropdown rather than hide it -- visible but locked is less
        // surprising than "where did the field go?".
        OwnerCombo.IsEnabled = _isAdmin && _users.Count > 1;
    }

    public CreateVaultRequest BuildRequest()
    {
        var owner = SelectedOwner();
        return new CreateVaultRequest(
            Path: BuildPath(),
            Name: NameBox.Text.Trim(),
            // Only send OwnerUserId when it's actually different from
            // the caller -- avoids sending a redundant field on every
            // create request and keeps the audit log cleaner (the
            // endpoint includes onBehalfOf in audit only when the field
            // is non-null and != caller).
            OwnerUserId: owner?.Id == _currentUser.Id ? null : owner?.Id);
    }

    private UserDto? SelectedOwner()
        => OwnerCombo.SelectedItem as UserDto;

    private string BuildPath()
    {
        var name = NameBox.Text.Trim();
        var owner = SelectedOwner();
        var ownerUsername = owner?.Username ?? _currentUser.Username;
        return PersonalRadio.IsChecked == true
            ? $"users/{ownerUsername}/{name}"
            : $"shared/{name}";
    }

    private void ScopeChanged(object sender, RoutedEventArgs e) => UpdatePathPreview();

    private void NameBox_TextChanged(object sender, TextChangedEventArgs e)
        => UpdatePathPreview();

    private void OwnerCombo_SelectionChanged(object sender, SelectionChangedEventArgs e)
        => UpdatePathPreview();

    private void UpdatePathPreview()
    {
        if (PathPreview is null) return;
        var name = NameBox?.Text.Trim() ?? "";
        if (string.IsNullOrEmpty(name))
        {
            PathPreview.Text = "(enter a name)";
            return;
        }
        PathPreview.Text = BuildPath();
    }

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private void OkButton_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(NameBox.Text))
        {
            ShowError("Enter a vault name.");
            return;
        }
        if (SelectedOwner() is null)
        {
            ShowError("Select an owner.");
            return;
        }
        DialogResult = true;
        Close();
    }

    private void ShowError(string message)
    {
        ErrorText.Text = message;
        ErrorText.Visibility = Visibility.Visible;
    }
}
