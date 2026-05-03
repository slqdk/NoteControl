using System.Collections.ObjectModel;
using System.Windows;
using NoteControl.Shared.Vaults;
using NoteControl.Tray.Admin.Client;

namespace NoteControl.Tray.Admin.Windows;

public partial class VaultMembersWindow : Window
{
    private readonly IAdminClient _client;
    private readonly Guid _vaultId;
    private readonly string _vaultPath;
    private readonly bool _isOwner;
    private readonly ObservableCollection<MemberRow> _rows = new();

    public VaultMembersWindow(IAdminClient client, Guid vaultId, string vaultPath, bool isOwner)
    {
        _client = client;
        _vaultId = vaultId;
        _vaultPath = vaultPath;
        _isOwner = isOwner;
        InitializeComponent();
        MembersGrid.ItemsSource = _rows;
        HeaderText.Text = $"Members of '{vaultPath}'";
        Loaded += async (_, _) => await ReloadAsync();
    }

    private MemberRow? Selected => MembersGrid.SelectedItem as MemberRow;

    private void MembersGrid_SelectionChanged(object sender, System.Windows.Controls.SelectionChangedEventArgs e)
    {
        // Owners can't be revoked, and only owners may revoke.
        var canRevoke = _isOwner
            && Selected is { } sel
            && !string.Equals(sel.Role, "owner", StringComparison.OrdinalIgnoreCase);
        RevokeButton.IsEnabled = canRevoke;
    }

    private async Task ReloadAsync()
    {
        StatusText.Text = "Loading…";
        try
        {
            var members = await _client.ListVaultMembersAsync(_vaultId);
            _rows.Clear();
            foreach (var m in members)
            {
                _rows.Add(MemberRow.From(m));
            }
            StatusText.Text = $"{_rows.Count} member{(_rows.Count == 1 ? "" : "s")}.";
        }
        catch (AdminClientException ex)
        {
            StatusText.Text = "Error: " + ex.Message;
        }
        // After reload nothing is selected — disable Revoke.
        RevokeButton.IsEnabled = false;
    }

    private async void RefreshButton_Click(object sender, RoutedEventArgs e) => await ReloadAsync();

    private async void RevokeButton_Click(object sender, RoutedEventArgs e)
    {
        var sel = Selected; if (sel is null) return;
        var confirm = MessageBox.Show(
            this,
            $"Revoke {sel.Username}'s access to '{_vaultPath}'?",
            "Revoke access",
            MessageBoxButton.OKCancel,
            MessageBoxImage.Warning);
        if (confirm != MessageBoxResult.OK) return;

        IsEnabled = false;
        try
        {
            await _client.UnshareVaultAsync(_vaultId, sel.UserId);
        }
        catch (AdminClientException ex)
        {
            MessageBox.Show(this, ex.Message, "Revoke",
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally
        {
            IsEnabled = true;
        }
        await ReloadAsync();
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e) => Close();
}

public sealed class MemberRow
{
    public Guid UserId { get; init; }
    public string Username { get; init; } = "";
    public string Role { get; init; } = "";
    public DateTimeOffset GrantedAt { get; init; }

    public string GrantedDisplay => GrantedAt.ToLocalTime().ToString("yyyy-MM-dd HH:mm");

    public static MemberRow From(VaultMemberDto m) => new()
    {
        UserId = m.UserId,
        Username = m.Username,
        Role = m.Role,
        GrantedAt = m.GrantedAt,
    };
}
