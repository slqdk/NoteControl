using System.Windows;
using System.Windows.Controls;
using NoteControl.Shared.Auth;

namespace NoteControl.Tray.Admin.Windows;

public partial class EditUserDialog : Window
{
    private readonly UserDto _original;

    public EditUserDialog(UserDto user)
    {
        _original = user;
        InitializeComponent();
        UsernameText.Text = user.Username;
        EmailBox.Text = user.Email;
        SelectComboBoxItem(RoleBox, user.Role);
        SelectComboBoxItem(StatusBox, user.Status);
        Loaded += (_, _) => EmailBox.Focus();
    }

    /// <summary>
    /// Builds an UpdateUserRequest carrying only the fields the user actually
    /// changed. Sending a null for an unchanged field tells the server to
    /// leave it alone.
    /// </summary>
    public UpdateUserRequest BuildRequest()
    {
        var newEmail  = EmailBox.Text.Trim();
        var newRole   = ((ComboBoxItem)RoleBox.SelectedItem).Content.ToString() ?? _original.Role;
        var newStatus = ((ComboBoxItem)StatusBox.SelectedItem).Content.ToString() ?? _original.Status;

        return new UpdateUserRequest(
            Email:  newEmail  != _original.Email  ? newEmail  : null,
            Role:   newRole   != _original.Role   ? newRole   : null,
            Status: newStatus != _original.Status ? newStatus : null);
    }

    private static void SelectComboBoxItem(ComboBox combo, string value)
    {
        foreach (ComboBoxItem item in combo.Items)
        {
            if (string.Equals(item.Content?.ToString(), value, StringComparison.OrdinalIgnoreCase))
            {
                combo.SelectedItem = item;
                return;
            }
        }
        combo.SelectedIndex = 0;
    }

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private void OkButton_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(EmailBox.Text))
        {
            MessageBox.Show(this, "Email is required.", "Edit user",
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        DialogResult = true;
        Close();
    }
}
