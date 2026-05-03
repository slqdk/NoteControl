using System.Net.Http;
using System.Windows;
using NoteControl.Tray.Admin.Client;
using NoteControl.Tray.Admin.Windows;

namespace NoteControl.Tray.Admin;

/// <summary>
/// Single point of entry for opening admin windows from the tray menu.
/// Holds the IAdminClient for the lifetime of the tray process and lazily
/// shows the login window the first time it's needed (or after sign-out).
/// </summary>
public sealed class AdminWorkflow : IDisposable
{
    private readonly HttpAdminClient _client;

    public AdminWorkflow(string serverBaseUrl)
    {
        _client = new HttpAdminClient(serverBaseUrl);
    }

    /// <summary>Open the Users window, prompting for login first if needed.</summary>
    public async Task OpenUsersAsync()
    {
        if (!await EnsureLoggedInAsync()) return;
        OpenSingle<UsersWindow>(() => new UsersWindow(_client));
    }

    /// <summary>Open the Vaults window, prompting for login first if needed.</summary>
    public async Task OpenVaultsAsync()
    {
        if (!await EnsureLoggedInAsync()) return;
        OpenSingle<VaultsWindow>(() => new VaultsWindow(_client));
    }

    /// <summary>Open the Server Settings window, prompting for login first if needed.</summary>
    public async Task OpenSettingsAsync()
    {
        if (!await EnsureLoggedInAsync()) return;
        OpenSingle<ServerSettingsWindow>(() => new ServerSettingsWindow(_client));
    }

    /// <summary>Open the Backups window, prompting for login first if needed.</summary>
    public async Task OpenBackupsAsync()
    {
        if (!await EnsureLoggedInAsync()) return;
        OpenSingle<BackupsWindow>(() => new BackupsWindow(_client));
    }

    /// <summary>Open the Logs window (audit + Serilog tabs), prompting for login first if needed.</summary>
    public async Task OpenLogsAsync()
    {
        if (!await EnsureLoggedInAsync()) return;
        OpenSingle<LogsWindow>(() => new LogsWindow(_client));
    }

    /// <summary>
    /// Open the About window. No login required — About doesn't
    /// talk to the server, just displays local build/runtime info.
    /// Returns Task to keep signatures consistent across the
    /// Open*Async family.
    /// </summary>
    public Task OpenAboutAsync()
    {
        OpenSingle<AboutWindow>(() => new AboutWindow(_client));
        return Task.CompletedTask;
    }

    private async Task<bool> EnsureLoggedInAsync()
    {
        if (_client.IsLoggedIn) return true;

        if (!await IsServerReachableAsync())
        {
            MessageBox.Show(
                "The NoteControl server doesn't appear to be running on " +
                $"{_client.BaseAddress}.\n\n" +
                "Start NoteControl.Server (F5 in Visual Studio with both projects " +
                "set as startup projects) and try again.",
                "NoteControl",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
            return false;
        }

        // Try local-token auto-login first. The server writes a
        // fresh token to {DataRoot}/.server/tray.token on startup;
        // if we can read it and the server accepts it, we get an
        // admin session without bothering the user. This is the
        // common path on the local box.
        //
        // We silently swallow failures (returns false) and fall
        // through to interactive login. Reasons it might fail:
        // running on a different machine, token file missing, file
        // ACL'd off, server restarted between the file write and
        // our read. None of those are worth a popup — the login
        // window is the right surface for "tell me who you are."
        if (await _client.TryLocalTokenLoginAsync()) return true;

        var login = new LoginWindow(_client);
        return login.ShowDialog() == true;
    }

    private async Task<bool> IsServerReachableAsync()
    {
        try
        {
            using var probe = new HttpClient
            {
                Timeout = TimeSpan.FromSeconds(5),
                BaseAddress = _client.BaseAddress,
            };
            using var response = await probe.GetAsync(
                "/health",
                HttpCompletionOption.ResponseHeadersRead);
            return true;
        }
        catch (HttpRequestException) { return false; }
        catch (TaskCanceledException) { return false; }
        catch { return false; }
    }

    private static void OpenSingle<TWindow>(Func<TWindow> factory) where TWindow : Window
    {
        foreach (Window open in Application.Current.Windows)
        {
            if (open is TWindow existing)
            {
                if (existing.WindowState == WindowState.Minimized)
                {
                    existing.WindowState = WindowState.Normal;
                }
                existing.Activate();
                return;
            }
        }

        var window = factory();
        window.Show();
    }

    public void Dispose() => _client.Dispose();
}
