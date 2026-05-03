using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Win32;
using NoteControl.Shared.Auth;
using NoteControl.Shared.Vaults;
using NoteControl.Tray.Settings;

namespace NoteControl.Tray.Admin.Windows;

/// <summary>
/// Dialog for adopting an existing on-disk folder as a NoteControl
/// vault. Counterpart to CreateVaultDialog.
///
/// Path semantics: the folder MUST live under the data root. We
/// translate the absolute Windows path the user picks into the
/// API-relative forward-slash path used by the server (e.g.
/// C:\ProgramData\NoteControl\NotesData\users\alice\Plans
/// becomes "users/alice/Plans"). Folders outside the data root are
/// rejected; the user has to copy/move first.
///
/// Scope is determined automatically from the relative path's first
/// segment ("users" or "shared"). Owner is auto-set for Personal
/// (the path's second segment IS the owner's username), editable
/// for Shared.
///
/// All validation here is best-effort UI hints. The server is the
/// authoritative gate -- it re-runs the same checks server-side
/// and returns precise error messages if anything's off.
/// </summary>
public partial class RegisterVaultDialog : Window
{
    private readonly IReadOnlyList<UserDto> _users;
    private readonly UserDto _currentUser;
    private readonly string? _dataRoot;

    // Resolved fields. Updated as the user picks a folder.
    private string? _absoluteFolderPath;
    private string? _relativePath;     // forward-slash, e.g. "users/alice/Plans"
    private string? _scope;            // "personal" or "shared"
    private string? _expectedOwnerUsername;  // for Personal scope, derived from path

    public RegisterVaultDialog(IReadOnlyList<UserDto> users, UserDto currentUser)
    {
        _users = users
            .Where(u => string.Equals(u.Status, "active", StringComparison.OrdinalIgnoreCase))
            .OrderBy(u => u.Username, StringComparer.OrdinalIgnoreCase)
            .ToList();
        _currentUser = currentUser;
        _dataRoot = TrayPaths.ResolveDataRoot();

        InitializeComponent();
        Loaded += (_, _) =>
        {
            PopulateOwnerCombo();
            UpdateRegisterButton();
        };
    }

    private void PopulateOwnerCombo()
    {
        OwnerCombo.ItemsSource = _users;
        OwnerCombo.DisplayMemberPath = nameof(UserDto.Username);

        // Default selection: the current user. Will be overridden
        // when a Personal-scope path is chosen (we re-select the
        // path's username in OnFolderSelected).
        var idx = _users
            .Select((u, i) => (u, i))
            .Where(t => t.u.Id == _currentUser.Id)
            .Select(t => (int?)t.i)
            .FirstOrDefault() ?? 0;
        if (_users.Count > 0)
        {
            OwnerCombo.SelectedIndex = idx;
        }
    }

    private void BrowseButton_Click(object sender, RoutedEventArgs e)
    {
        if (_dataRoot is null)
        {
            ShowError("Cannot resolve data root. Set NC_DATA_ROOT or ensure %ProgramData% is available.");
            return;
        }
        if (!Directory.Exists(_dataRoot))
        {
            ShowError($"Data root not found at {_dataRoot}. Make sure the server has started at least once.");
            return;
        }

        // .NET 8's WPF folder picker. Defaults to the data root so
        // the user starts in the right place. They CAN navigate up
        // (to e.g. "Documents"), but folders outside the data root
        // get rejected on selection -- we surface the error then.
        var dlg = new OpenFolderDialog
        {
            Title = "Select an existing vault folder",
            InitialDirectory = _dataRoot,
            // Multiselect off; one vault at a time is the simpler
            // UX. Bulk-register would be a future "scan orphans"
            // feature.
            Multiselect = false,
        };
        if (dlg.ShowDialog(this) != true) return;
        OnFolderSelected(dlg.FolderName);
    }

    private void OnFolderSelected(string absolutePath)
    {
        ClearError();
        _absoluteFolderPath = null;
        _relativePath = null;
        _scope = null;
        _expectedOwnerUsername = null;

        FolderBox.Text = absolutePath;

        // Verify under data root.
        if (_dataRoot is null || !IsUnderDataRoot(absolutePath, _dataRoot))
        {
            RelativePathPreview.Text = "(folder is outside the data root)";
            ScopeDisplay.Text = "(invalid)";
            ShowError(
                $"This folder is not under the data root ({_dataRoot}). " +
                "Copy or move the folder there first, then browse to it again.");
            UpdateRegisterButton();
            return;
        }

        // Compute API-relative path. Strip the data-root prefix and
        // normalize backslashes to forward slashes (the API and DB
        // both use forward slashes).
        var rel = absolutePath
            .Substring(_dataRoot.Length)
            .TrimStart(Path.DirectorySeparatorChar, '/')
            .Replace(Path.DirectorySeparatorChar, '/');

        if (string.IsNullOrEmpty(rel))
        {
            RelativePathPreview.Text = "(can't register the data root itself)";
            ScopeDisplay.Text = "(invalid)";
            ShowError("Pick a vault folder under the data root, not the data root itself.");
            UpdateRegisterButton();
            return;
        }

        var segments = rel.Split('/', StringSplitOptions.RemoveEmptyEntries);

        // Determine scope from the first segment.
        string scope;
        switch (segments[0])
        {
            case "users":
                scope = "personal";
                if (segments.Length < 3)
                {
                    RelativePathPreview.Text = rel;
                    ScopeDisplay.Text = "personal (incomplete path)";
                    ShowError("Personal vault path must be users/<username>/<vault>. Pick a folder one level deeper.");
                    UpdateRegisterButton();
                    return;
                }
                _expectedOwnerUsername = segments[1];
                break;
            case "shared":
                scope = "shared";
                if (segments.Length < 2)
                {
                    RelativePathPreview.Text = rel;
                    ScopeDisplay.Text = "shared (incomplete path)";
                    ShowError("Shared vault path must be shared/<vault>. Pick a folder one level deeper.");
                    UpdateRegisterButton();
                    return;
                }
                _expectedOwnerUsername = null;
                break;
            default:
                RelativePathPreview.Text = rel;
                ScopeDisplay.Text = "(invalid)";
                ShowError("Vault path must start with users/ or shared/.");
                UpdateRegisterButton();
                return;
        }

        // For Personal scope, auto-select the owner from the path's
        // username segment AND lock the combo (the path forces it).
        // For Shared scope, leave it editable so admin can pick.
        if (scope == "personal" && _expectedOwnerUsername is not null)
        {
            var matching = _users.FirstOrDefault(u =>
                string.Equals(u.Username, _expectedOwnerUsername, StringComparison.OrdinalIgnoreCase));
            if (matching is null)
            {
                ShowError(
                    $"The path references user '{_expectedOwnerUsername}', but no active user with that " +
                    "username exists. Create the user first or rename the folder to match an existing user.");
                _scope = scope;
                _relativePath = rel;
                _absoluteFolderPath = absolutePath;
                RelativePathPreview.Text = rel;
                ScopeDisplay.Text = "personal";
                UpdateRegisterButton();
                return;
            }
            OwnerCombo.SelectedItem = matching;
            OwnerCombo.IsEnabled = false;
        }
        else
        {
            // Shared: editable; default stays at whatever it was
            // (current user from PopulateOwnerCombo).
            OwnerCombo.IsEnabled = true;
        }

        _scope = scope;
        _relativePath = rel;
        _absoluteFolderPath = absolutePath;
        RelativePathPreview.Text = rel;
        ScopeDisplay.Text = scope;

        // Default the vault name to the folder's leaf segment, but
        // only if the user hasn't typed anything custom yet.
        if (string.IsNullOrWhiteSpace(NameBox.Text))
        {
            NameBox.Text = segments[^1];
        }

        UpdateRegisterButton();
    }

    private static bool IsUnderDataRoot(string absolutePath, string dataRoot)
    {
        // Normalise both ends so a trailing slash mismatch doesn't
        // trip us up. Path.GetFullPath also resolves any '..' in the
        // input -- a security concern if the user somehow passed a
        // path with traversal, since we'd otherwise compare strings
        // before normalising.
        var normPath = Path.GetFullPath(absolutePath).TrimEnd(Path.DirectorySeparatorChar);
        var normRoot = Path.GetFullPath(dataRoot).TrimEnd(Path.DirectorySeparatorChar);
        return normPath.StartsWith(normRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || string.Equals(normPath, normRoot, StringComparison.OrdinalIgnoreCase);
    }

    private void OwnerCombo_SelectionChanged(object sender, SelectionChangedEventArgs e)
        => UpdateRegisterButton();

    private void UpdateRegisterButton()
    {
        // Enable Register only when we have a valid relative path,
        // a scope, and an owner selected. Vault name is optional
        // (defaults to leaf folder name).
        RegisterButton.IsEnabled =
            _relativePath is not null
            && _scope is not null
            && OwnerCombo.SelectedItem is UserDto;
    }

    public RegisterVaultRequest BuildRequest()
    {
        var owner = OwnerCombo.SelectedItem as UserDto
            ?? throw new InvalidOperationException("Register button should be disabled without a selected owner.");
        return new RegisterVaultRequest(
            Path: _relativePath ?? throw new InvalidOperationException("Register button should be disabled without a path."),
            Name: string.IsNullOrWhiteSpace(NameBox.Text) ? null : NameBox.Text.Trim(),
            // Send OwnerUserId only when it differs from the caller --
            // matches the convention CreateVaultDialog uses, keeps
            // audit log cleaner.
            OwnerUserId: owner.Id == _currentUser.Id ? null : owner.Id);
    }

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private void OkButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = true;
        Close();
    }

    private void ShowError(string message)
    {
        ErrorText.Text = message;
        ErrorText.Visibility = Visibility.Visible;
    }

    private void ClearError()
    {
        ErrorText.Text = "";
        ErrorText.Visibility = Visibility.Collapsed;
    }
}
