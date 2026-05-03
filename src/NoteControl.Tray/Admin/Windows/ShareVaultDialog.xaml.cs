using System.Windows;
using System.Windows.Controls;
using NoteControl.Shared.Vaults;

namespace NoteControl.Tray.Admin.Windows;

public partial class ShareVaultDialog : Window
{
    public ShareVaultDialog(string vaultPath)
    {
        InitializeComponent();
        HeaderText.Text = $"Share '{vaultPath}' with another user.";
        Loaded += (_, _) => UsernameBox.Focus();
    }

    public ShareVaultRequest BuildRequest() => new(
        Username: UsernameBox.Text.Trim(),
        Role: ((ComboBoxItem)RoleBox.SelectedItem).Content.ToString() ?? "viewer");

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private void OkButton_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(UsernameBox.Text))
        {
            MessageBox.Show(this, "Enter a username.", "Share vault",
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        DialogResult = true;
        Close();
    }
}
