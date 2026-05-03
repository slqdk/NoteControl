using System.Windows;
using NoteControl.Shared.Auth;

namespace NoteControl.Tray.Admin.Windows;

public partial class ResetPasswordDialog : Window
{
    public ResetPasswordDialog(string username)
    {
        InitializeComponent();
        HeaderText.Text = $"Set a new password for '{username}'.";
        Loaded += (_, _) => PasswordBox.Focus();
    }

    public ChangePasswordRequest BuildRequest()
        // Admin path: no current password required.
        => new(CurrentPassword: null, NewPassword: PasswordBox.Password);

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private void OkButton_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrEmpty(PasswordBox.Password))
        {
            MessageBox.Show(this, "Enter a password.", "Reset password",
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        if (PasswordBox.Password != ConfirmBox.Password)
        {
            MessageBox.Show(this, "Passwords don't match.", "Reset password",
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        DialogResult = true;
        Close();
    }
}
