using System.Net.Http;
using System.Windows;
using System.Windows.Input;
using NoteControl.Tray.Admin.Client;

namespace NoteControl.Tray.Admin.Windows;

public partial class LoginWindow : Window
{
    private readonly IAdminClient _client;

    public LoginWindow(IAdminClient client)
    {
        _client = client;
        InitializeComponent();
        Loaded += (_, _) => UsernameBox.Focus();
    }

    private async void LoginButton_Click(object sender, RoutedEventArgs e)
    {
        await TryLoginAsync();
    }

    private async void PasswordBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            await TryLoginAsync();
        }
    }

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private async Task TryLoginAsync()
    {
        var username = UsernameBox.Text.Trim();
        var password = PasswordBox.Password;

        if (string.IsNullOrEmpty(username) || string.IsNullOrEmpty(password))
        {
            ShowError("Enter a username and password.");
            return;
        }

        SetBusy(true);
        try
        {
            await _client.LoginAsync(username, password);
            DialogResult = true;
            Close();
        }
        catch (AdminClientException ex)
        {
            ShowError(ex.Message);
        }
        catch (HttpRequestException ex)
        {
            ShowError("Could not reach the server: " + ex.Message);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private void SetBusy(bool busy)
    {
        IsEnabled = !busy;
        Cursor = busy ? System.Windows.Input.Cursors.Wait : null;
    }

    private void ShowError(string message)
    {
        ErrorText.Text = message;
        ErrorText.Visibility = Visibility.Visible;
    }
}
