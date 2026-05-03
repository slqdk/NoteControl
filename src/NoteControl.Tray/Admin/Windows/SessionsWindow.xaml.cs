using System.Collections.ObjectModel;
using System.Windows;
using NoteControl.Shared.Auth;
using NoteControl.Tray.Admin.Client;

namespace NoteControl.Tray.Admin.Windows;

public partial class SessionsWindow : Window
{
    private readonly IAdminClient _client;
    private readonly Guid _userId;
    private readonly string _username;
    private readonly ObservableCollection<SessionRow> _rows = new();

    public SessionsWindow(IAdminClient client, Guid userId, string username)
    {
        _client = client;
        _userId = userId;
        _username = username;
        InitializeComponent();
        SessionsGrid.ItemsSource = _rows;
        HeaderText.Text = $"Active sessions for '{username}'";
        SessionsGrid.SelectionChanged += (_, _) => RevokeButton.IsEnabled = SessionsGrid.SelectedItem is not null;
        Loaded += async (_, _) => await ReloadAsync();
    }

    private async Task ReloadAsync()
    {
        StatusText.Text = "Loading…";
        try
        {
            var sessions = await _client.ListSessionsAsync(_userId);
            _rows.Clear();
            foreach (var s in sessions)
            {
                _rows.Add(SessionRow.From(s));
            }
            StatusText.Text = _rows.Count == 0
                ? "No active sessions."
                : $"{_rows.Count} active session{(_rows.Count == 1 ? "" : "s")}.";
        }
        catch (AdminClientException ex)
        {
            StatusText.Text = "Error: " + ex.Message;
        }
    }

    private async void RefreshButton_Click(object sender, RoutedEventArgs e) => await ReloadAsync();

    private async void RevokeButton_Click(object sender, RoutedEventArgs e)
    {
        if (SessionsGrid.SelectedItem is not SessionRow row) return;
        await RevokeOneAsync(row.Id);
        await ReloadAsync();
    }

    private async void RevokeAllButton_Click(object sender, RoutedEventArgs e)
    {
        if (_rows.Count == 0) return;
        var confirm = MessageBox.Show(
            this,
            $"Revoke all {_rows.Count} session(s) for '{_username}'? They will be signed out immediately.",
            "Revoke all",
            MessageBoxButton.OKCancel,
            MessageBoxImage.Warning);
        if (confirm != MessageBoxResult.OK) return;

        IsEnabled = false;
        try
        {
            // Snapshot so we don't mutate the collection while iterating.
            foreach (var row in _rows.ToList())
            {
                try { await _client.RevokeSessionAsync(row.Id); }
                catch (AdminClientException) { /* keep going for the rest */ }
            }
        }
        finally
        {
            IsEnabled = true;
        }
        await ReloadAsync();
    }

    private async Task RevokeOneAsync(Guid sessionId)
    {
        IsEnabled = false;
        try
        {
            await _client.RevokeSessionAsync(sessionId);
        }
        catch (AdminClientException ex)
        {
            MessageBox.Show(this, ex.Message, "Revoke session",
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally
        {
            IsEnabled = true;
        }
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e) => Close();
}

public sealed class SessionRow
{
    public Guid Id { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset LastActivityAt { get; init; }
    public DateTimeOffset ExpiresAt { get; init; }
    public string? IpAddress { get; init; }
    public string? UserAgent { get; init; }
    public bool IsCurrent { get; init; }

    public string CreatedDisplay    => CreatedAt.ToLocalTime().ToString("yyyy-MM-dd HH:mm");
    public string LastActiveDisplay => LastActivityAt.ToLocalTime().ToString("yyyy-MM-dd HH:mm");
    public string ExpiresDisplay    => ExpiresAt.ToLocalTime().ToString("yyyy-MM-dd HH:mm");

    /// <summary>
    /// Trimmed user-agent: full UA strings are 200+ chars and noisy. We
    /// pull the most informative middle slice for display; tooltip with
    /// the full string can come later.
    /// </summary>
    public string ShortUserAgent
    {
        get
        {
            if (string.IsNullOrEmpty(UserAgent)) return "";
            var ua = UserAgent;
            return ua.Length <= 80 ? ua : ua[..80] + "…";
        }
    }

    public static SessionRow From(SessionDto s) => new()
    {
        Id = s.Id,
        CreatedAt = s.CreatedAt,
        LastActivityAt = s.LastActivityAt,
        ExpiresAt = s.ExpiresAt,
        IpAddress = s.IpAddress,
        UserAgent = s.UserAgent,
        IsCurrent = s.IsCurrent,
    };
}
