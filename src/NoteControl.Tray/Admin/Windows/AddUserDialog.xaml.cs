using System.Windows;
using System.Windows.Controls;
using NoteControl.Shared.Auth;

namespace NoteControl.Tray.Admin.Windows;

public partial class AddUserDialog : Window
{
    public AddUserDialog()
    {
        InitializeComponent();
        Loaded += (_, _) => UsernameBox.Focus();
    }

    public CreateUserRequest BuildRequest() => new(
        Username: UsernameBox.Text.Trim(),
        Email: EmailBox.Text.Trim(),
        Password: PasswordBox.Password,
        Role: ((ComboBoxItem)RoleBox.SelectedItem).Content.ToString() ?? "user");

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private void OkButton_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(UsernameBox.Text)
            || string.IsNullOrWhiteSpace(EmailBox.Text)
            || string.IsNullOrEmpty(PasswordBox.Password))
        {
            MessageBox.Show(this, "All fields are required.", "Add user",
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        DialogResult = true;
        Close();
    }
}
