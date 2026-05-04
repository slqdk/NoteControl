using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using NoteControl.Shared.Admin;
using NoteControl.Shared.Auth;
using NoteControl.Shared.Vaults;

namespace NoteControl.Tray.Admin.Client;

/// <summary>
/// HTTP implementation of IAdminClient.
/// </summary>
public sealed class HttpAdminClient : IAdminClient, IDisposable
{
    private readonly HttpClient _http;
    private readonly CookieContainer _cookies;
    private string? _csrfToken;
    private UserDto? _currentUser;

    private static readonly JsonSerializerOptions JsonOptions =
        new(JsonSerializerDefaults.Web);

    public HttpAdminClient(string baseUrl)
    {
        _cookies = new CookieContainer();
        var handler = new HttpClientHandler
        {
            CookieContainer = _cookies,
            UseCookies = true,
            UseProxy = false,
            AllowAutoRedirect = false,
        };
        _http = new HttpClient(handler)
        {
            BaseAddress = new Uri(baseUrl),
            Timeout = TimeSpan.FromSeconds(20),
        };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("NoteControl.Tray/1.0");
    }

    public bool IsLoggedIn => _currentUser is not null;
    public UserDto? CurrentUser => _currentUser;
    public Uri? BaseAddress => _http.BaseAddress;

    // -----------------------------------------------------------------
    // Auth
    // -----------------------------------------------------------------

    public async Task LoginAsync(string username, string password, CancellationToken ct = default)
    {
        var response = await _http.PostAsJsonAsync(
            "/api/auth/login",
            new LoginRequest(username, password),
            JsonOptions, ct);

        if (!response.IsSuccessStatusCode)
        {
            throw await ToExceptionAsync(response, ct);
        }

        var login = await response.Content.ReadFromJsonAsync<LoginResponse>(JsonOptions, ct)
            ?? throw new AdminClientException("Login response was empty.");

        // Tray is admin-only — refuse a non-admin login and clear
        // the cookie that was just set so the user isn't left in a
        // half-logged-in state.
        if (!string.Equals(login.User.Role, "admin", StringComparison.OrdinalIgnoreCase))
        {
            _csrfToken = login.CsrfToken;  // need it to call /logout
            _currentUser = login.User;
            try { await LogoutAsync(ct); } catch { /* best-effort cleanup */ }
            throw new AdminClientException(
                "This account is not an administrator.",
                statusCode: (int)HttpStatusCode.Forbidden);
        }

        _csrfToken = login.CsrfToken;
        _currentUser = login.User;
    }

    /// <summary>
    /// Try to log in using the local-machine tray token written by
    /// the server at <c>{DataRoot}/.server/tray.token</c>. Returns
    /// true if the login succeeded, false if the file is missing,
    /// the token is rejected, or the data folder isn't where we
    /// expected. Errors don't throw — the caller should fall back
    /// to the interactive login window.
    /// </summary>
    public async Task<bool> TryLocalTokenLoginAsync(CancellationToken ct = default)
    {
        var path = ResolveTrayTokenPath();
        if (path is null || !File.Exists(path)) return false;

        string token;
        try
        {
            token = (await File.ReadAllTextAsync(path, ct)).Trim();
        }
        catch
        {
            // Permissions or transient I/O — silently fall through
            // to interactive login.
            return false;
        }
        if (string.IsNullOrEmpty(token)) return false;

        HttpResponseMessage response;
        try
        {
            response = await _http.PostAsJsonAsync(
                "/api/auth/local-token",
                new LocalTokenLoginRequest(token),
                JsonOptions, ct);
        }
        catch
        {
            // Server unreachable etc. Caller will surface the
            // connectivity problem when they retry.
            return false;
        }

        if (!response.IsSuccessStatusCode)
        {
            response.Dispose();
            return false;
        }

        var login = await response.Content.ReadFromJsonAsync<LoginResponse>(JsonOptions, ct);
        response.Dispose();
        if (login is null) return false;

        // Same admin check the password login uses. The local-token
        // endpoint already picks an admin user, but defence-in-depth
        // — if the server logic ever changes we still refuse to
        // hand non-admin sessions to the tray.
        if (!string.Equals(login.User.Role, "admin", StringComparison.OrdinalIgnoreCase))
        {
            _csrfToken = login.CsrfToken;
            _currentUser = login.User;
            try { await LogoutAsync(ct); } catch { /* best-effort cleanup */ }
            return false;
        }

        _csrfToken = login.CsrfToken;
        _currentUser = login.User;
        return true;
    }

    /// <summary>
    /// Resolve the tray token file path. Reads <c>NC_DATA_ROOT</c>
    /// env var first (used by dev / tests), otherwise falls back
    /// to the production default (<c>%ProgramData%\NoteControl\NotesData</c>).
    /// Returns null if neither resolves to a usable path.
    /// </summary>
    private static string? ResolveTrayTokenPath()
    {
        var dataRoot = Environment.GetEnvironmentVariable("NC_DATA_ROOT");
        if (string.IsNullOrWhiteSpace(dataRoot))
        {
            // %ProgramData% on Windows is C:\ProgramData by default.
            // Mirror the appsettings.json default for the server.
            var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            if (string.IsNullOrEmpty(programData)) return null;
            dataRoot = Path.Combine(programData, "NoteControl", "NotesData");
        }

        return Path.Combine(dataRoot, ".server", "tray.token");
    }

    public async Task LogoutAsync(CancellationToken ct = default)
    {
        if (_csrfToken is null) return;

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/auth/logout");
            request.Headers.Add("X-CSRF-Token", _csrfToken);
            using var response = await _http.SendAsync(request, ct);
        }
        finally
        {
            _csrfToken = null;
            _currentUser = null;
        }
    }

    // -----------------------------------------------------------------
    // Users
    // -----------------------------------------------------------------

    public async Task<IReadOnlyList<UserDto>> ListUsersAsync(CancellationToken ct = default)
    {
        using var response = await _http.GetAsync("/api/users", ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<List<UserDto>>(JsonOptions, ct) ?? new();
    }

    public async Task<UserDto> CreateUserAsync(CreateUserRequest request, CancellationToken ct = default)
    {
        using var response = await SendJsonAsync(HttpMethod.Post, "/api/users", request, ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<UserDto>(JsonOptions, ct)
            ?? throw new AdminClientException("Server returned an empty user payload.");
    }

    public async Task<UserDto> UpdateUserAsync(Guid id, UpdateUserRequest request, CancellationToken ct = default)
    {
        using var response = await SendJsonAsync(HttpMethod.Put, $"/api/users/{id}", request, ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<UserDto>(JsonOptions, ct)
            ?? throw new AdminClientException("Server returned an empty user payload.");
    }

    public async Task DeleteUserAsync(Guid id, CancellationToken ct = default)
    {
        using var request = BuildRequest(HttpMethod.Delete, $"/api/users/{id}");
        using var response = await _http.SendAsync(request, ct);
        await EnsureSuccessAsync(response, ct);
    }

    public async Task ChangePasswordAsync(Guid userId, ChangePasswordRequest request, CancellationToken ct = default)
    {
        using var response = await SendJsonAsync(HttpMethod.Post, $"/api/users/{userId}/password", request, ct);
        await EnsureSuccessAsync(response, ct);
    }

    public async Task<IReadOnlyList<SessionDto>> ListSessionsAsync(Guid userId, CancellationToken ct = default)
    {
        using var response = await _http.GetAsync($"/api/users/{userId}/sessions", ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<List<SessionDto>>(JsonOptions, ct) ?? new();
    }

    public async Task RevokeSessionAsync(Guid sessionId, CancellationToken ct = default)
    {
        using var request = BuildRequest(HttpMethod.Delete, $"/api/sessions/{sessionId}");
        using var response = await _http.SendAsync(request, ct);
        await EnsureSuccessAsync(response, ct);
    }

    // -----------------------------------------------------------------
    // Vaults
    // -----------------------------------------------------------------

    public async Task<IReadOnlyList<VaultDto>> ListVaultsAsync(bool all = false, CancellationToken ct = default)
    {
        // Forgiving query string: server treats all=true as opt-in,
        // non-admins silently get the filtered view, no 403. We send
        // the param either way for clarity in server logs.
        var url = all ? "/api/vaults?all=true" : "/api/vaults";
        using var response = await _http.GetAsync(url, ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<List<VaultDto>>(JsonOptions, ct) ?? new();
    }

    public async Task<VaultDto> CreateVaultAsync(CreateVaultRequest request, CancellationToken ct = default)
    {
        using var response = await SendJsonAsync(HttpMethod.Post, "/api/vaults", request, ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<VaultDto>(JsonOptions, ct)
            ?? throw new AdminClientException("Server returned an empty vault payload.");
    }

    public async Task<VaultDto> RegisterVaultAsync(RegisterVaultRequest request, CancellationToken ct = default)
    {
        using var response = await SendJsonAsync(HttpMethod.Post, "/api/vaults/register", request, ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<VaultDto>(JsonOptions, ct)
            ?? throw new AdminClientException("Server returned an empty vault payload.");
    }

    public async Task DeleteVaultAsync(Guid vaultId, CancellationToken ct = default)
    {
        using var request = BuildRequest(HttpMethod.Delete, $"/api/vaults/{vaultId}");
        using var response = await _http.SendAsync(request, ct);
        await EnsureSuccessAsync(response, ct);
    }

    public async Task<IReadOnlyList<VaultMemberDto>> ListVaultMembersAsync(Guid vaultId, CancellationToken ct = default)
    {
        using var response = await _http.GetAsync($"/api/vaults/{vaultId}/permissions", ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<List<VaultMemberDto>>(JsonOptions, ct) ?? new();
    }

    public async Task<VaultMemberDto> ShareVaultAsync(Guid vaultId, ShareVaultRequest request, CancellationToken ct = default)
    {
        using var response = await SendJsonAsync(HttpMethod.Post, $"/api/vaults/{vaultId}/permissions", request, ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<VaultMemberDto>(JsonOptions, ct)
            ?? throw new AdminClientException("Server returned an empty member payload.");
    }

    public async Task UnshareVaultAsync(Guid vaultId, Guid userId, CancellationToken ct = default)
    {
        using var request = BuildRequest(HttpMethod.Delete,
            $"/api/vaults/{vaultId}/permissions/{userId}");
        using var response = await _http.SendAsync(request, ct);
        await EnsureSuccessAsync(response, ct);
    }
    public async Task<InstallSampleDataResponse> InstallSampleDataAsync(
        Guid vaultId, CancellationToken ct = default)
    {
        // Ship 52: POST /api/vaults/{id}/install-sample-data.
        // No body — the vault id in the URL is the only input the
        // server needs. Response carries file + folder counts.
        using var request = BuildRequest(
            HttpMethod.Post,
            $"/api/vaults/{vaultId}/install-sample-data");
        using var response = await _http.SendAsync(request, ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content
            .ReadFromJsonAsync<InstallSampleDataResponse>(JsonOptions, ct)
            ?? throw new AdminClientException(
                "Server returned an empty install-sample-data response.");
    }

    // -----------------------------------------------------------------
    // Server config (step 16)
    // -----------------------------------------------------------------

    public async Task<ServerConfigDto> GetServerConfigAsync(CancellationToken ct = default)
    {
        using var response = await _http.GetAsync("/api/admin/server/config", ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<ServerConfigDto>(JsonOptions, ct)
            ?? throw new AdminClientException("Server returned an empty config payload.");
    }

    public async Task<ServerConfigDto> UpdateServerConfigAsync(
        ServerConfigDto config, CancellationToken ct = default)
    {
        using var response = await SendJsonAsync(HttpMethod.Put, "/api/admin/server/config", config, ct);
        // 400 with a ValidationProblemDetails body comes back as the
        // first error string via ToExceptionAsync. The Settings
        // window catches AdminClientException and shows the message.
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<ServerConfigDto>(JsonOptions, ct)
            ?? throw new AdminClientException("Server returned an empty config payload.");
    }

    public async Task<TestSmtpResponse> TestSmtpAsync(string to, CancellationToken ct = default)
    {
        using var response = await SendJsonAsync(
            HttpMethod.Post,
            "/api/admin/server/smtp/test",
            new TestSmtpRequest(to),
            ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<TestSmtpResponse>(JsonOptions, ct)
            ?? throw new AdminClientException("Server returned an empty SMTP test response.");
    }

    // -----------------------------------------------------------------
    // Backups (step 18)
    // -----------------------------------------------------------------

    public async Task<BackupStatusDto> GetBackupStatusAsync(CancellationToken ct = default)
    {
        using var response = await _http.GetAsync("/api/admin/server/backup/status", ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<BackupStatusDto>(JsonOptions, ct)
            ?? throw new AdminClientException("Server returned an empty backup status payload.");
    }

    public async Task<BackupRunResultDto> RunBackupAsync(CancellationToken ct = default)
    {
        // The server long-polls — typical run is seconds, large
        // vaults can be tens of seconds. We use a roomy timeout
        // here on top of the per-client default (20s), so a slow
        // backup doesn't fail spuriously.
        using var request = BuildRequest(HttpMethod.Post, "/api/admin/server/backup/run");
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromMinutes(10));
        using var response = await _http.SendAsync(request, cts.Token);
        await EnsureSuccessAsync(response, cts.Token);
        return await response.Content.ReadFromJsonAsync<BackupRunResultDto>(JsonOptions, cts.Token)
            ?? throw new AdminClientException("Server returned an empty backup run payload.");
    }

    public async Task<IReadOnlyList<BackupListItemDto>> ListBackupsAsync(CancellationToken ct = default)
    {
        using var response = await _http.GetAsync("/api/admin/server/backup/list", ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<List<BackupListItemDto>>(JsonOptions, ct)
            ?? new List<BackupListItemDto>();
    }

    public async Task DeleteBackupAsync(string id, CancellationToken ct = default)
    {
        using var request = BuildRequest(HttpMethod.Delete, $"/api/admin/server/backup/{Uri.EscapeDataString(id)}");
        using var response = await _http.SendAsync(request, ct);
        await EnsureSuccessAsync(response, ct);
    }

    public async Task<RestoreResultDto> RestoreVaultFromBackupAsync(
        string backupId, Guid vaultId, string vaultFolderInBackup, CancellationToken ct = default)
    {
        // Same long-poll treatment as backup-run — restore copy
        // duration scales with vault size.
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromMinutes(10));
        using var response = await SendJsonAsync(
            HttpMethod.Post,
            $"/api/admin/server/backup/{Uri.EscapeDataString(backupId)}/restore-vault",
            new RestoreVaultRequest(vaultId, vaultFolderInBackup),
            cts.Token);
        await EnsureSuccessAsync(response, cts.Token);
        return await response.Content.ReadFromJsonAsync<RestoreResultDto>(JsonOptions, cts.Token)
            ?? throw new AdminClientException("Server returned an empty restore result.");
    }

    // -----------------------------------------------------------------
    // Audit + Server logs (step 19)
    // -----------------------------------------------------------------

    public async Task<IReadOnlyList<AuditEntryDto>> QueryAuditAsync(
        DateTimeOffset? since,
        DateTimeOffset? until,
        Guid? userId,
        string? eventType,
        int limit,
        CancellationToken ct = default)
    {
        // Hand-build the query string. HttpClient's GET-with-query
        // helpers all want a typed Dictionary<string,string> and
        // we want optional fields — easier to just compose.
        var qp = new List<string>();
        if (since.HasValue)  qp.Add("since=" + Uri.EscapeDataString(since.Value.ToString("o")));
        if (until.HasValue)  qp.Add("until=" + Uri.EscapeDataString(until.Value.ToString("o")));
        if (userId.HasValue) qp.Add("userId=" + userId.Value);
        if (!string.IsNullOrWhiteSpace(eventType))
                             qp.Add("eventType=" + Uri.EscapeDataString(eventType));
        qp.Add("limit=" + limit);

        var path = "/api/admin/audit?" + string.Join("&", qp);
        using var response = await _http.GetAsync(path, ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<List<AuditEntryDto>>(JsonOptions, ct)
            ?? new List<AuditEntryDto>();
    }

    public async Task<IReadOnlyList<string>> ListAuditEventTypesAsync(CancellationToken ct = default)
    {
        using var response = await _http.GetAsync("/api/admin/audit/event-types", ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<List<string>>(JsonOptions, ct)
            ?? new List<string>();
    }

    public async Task<ServerLogTailDto> TailServerLogAsync(int lines, CancellationToken ct = default)
    {
        using var response = await _http.GetAsync($"/api/admin/server/logs/tail?lines={lines}", ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<ServerLogTailDto>(JsonOptions, ct)
            ?? throw new AdminClientException("Server returned an empty log tail.");
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    private async Task<HttpResponseMessage> SendJsonAsync<T>(
        HttpMethod method, string path, T payload, CancellationToken ct)
    {
        var request = BuildRequest(method, path);
        request.Content = JsonContent.Create(payload, options: JsonOptions);
        return await _http.SendAsync(request, ct);
    }

    private HttpRequestMessage BuildRequest(HttpMethod method, string path)
    {
        var request = new HttpRequestMessage(method, path);
        if (_csrfToken is not null
            && method != HttpMethod.Get
            && method != HttpMethod.Head
            && method != HttpMethod.Options)
        {
            request.Headers.Add("X-CSRF-Token", _csrfToken);
        }
        return request;
    }

    private async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken ct)
    {
        if (response.IsSuccessStatusCode) return;

        // 401 means our session has been invalidated server-side —
        // most commonly because the server restarted (which rotates
        // the local tray token AND drops the in-memory session
        // table). Clear the cached "logged in" state so the next
        // admin-window open triggers EnsureLoggedInAsync again,
        // which will re-attempt the local-token login transparently.
        // Without this clear the tray would happily keep firing
        // 401-yielding requests forever.
        if ((int)response.StatusCode == 401)
        {
            _currentUser = null;
            _csrfToken = null;
        }

        throw await ToExceptionAsync(response, ct);
    }

    private static async Task<AdminClientException> ToExceptionAsync(HttpResponseMessage response, CancellationToken ct)
    {
        var status = (int)response.StatusCode;
        string? message = null;

        try
        {
            var body = await response.Content.ReadAsStringAsync(ct);
            if (!string.IsNullOrWhiteSpace(body))
            {
                try
                {
                    using var doc = JsonDocument.Parse(body);
                    if (doc.RootElement.ValueKind == JsonValueKind.Object)
                    {
                        // RFC 7807 problem+json: combine title and detail
                        // for the human message. ProblemDetails for unhandled
                        // exceptions in dev mode puts the exception type in
                        // title and the actual message in detail — without
                        // both, the user sees "SqliteException" and no clue.
                        string? title = null, detail = null;
                        if (doc.RootElement.TryGetProperty("title", out var t)
                            && t.ValueKind == JsonValueKind.String)
                            title = t.GetString();
                        if (doc.RootElement.TryGetProperty("detail", out var d)
                            && d.ValueKind == JsonValueKind.String)
                            detail = d.GetString();

                        if (!string.IsNullOrWhiteSpace(title) && !string.IsNullOrWhiteSpace(detail))
                            message = $"{title}: {detail}";
                        else
                            message = title ?? detail;
                    }
                }
                catch (JsonException)
                {
                    if (body.Length < 500) message = body;
                }
            }
        }
        catch { }

        message ??= $"Server returned {status} {response.ReasonPhrase}.";
        return new AdminClientException(message, status);
    }

    public void Dispose() => _http.Dispose();
}
