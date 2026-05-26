namespace NoteControl.Shared.Admin;

/// <summary>
/// The whole server configuration, sectioned for the Settings
/// window. Round-trips between the admin endpoint and the tray's
/// ServerSettingsWindow.
/// <para>
/// Storage is read-only on the wire because changing the data
/// root requires a manual <c>appsettings.json</c> edit + service
/// restart (see Server Settings window for the explanation
/// shown to the user). Including it here lets the UI display
/// the current value.
/// </para>
/// </summary>
public sealed record ServerConfigDto(
    StorageConfigDto Storage,
    NetworkConfigDto Network,
    AuthConfigDto Auth,
    BackupConfigDto Backup,
    LoggingConfigDto Logging);

/// <summary>Read-only — informational. Changing requires manual edit.</summary>
public sealed record StorageConfigDto(
    string DataRoot,
    string ConfigFilePath);

/// <summary>
/// Network bindings + identity. <c>BindUrl</c> is what Kestrel is
/// actually listening on (read-only, set at startup).
/// <c>ExposeOnLan</c> + <c>Port</c> are the saved settings; toggling
/// or editing them takes effect on next server restart since
/// Kestrel wires its sockets at host build time.
/// <c>LanUrls</c> is a server-detected list of "http://&lt;ip&gt;:&lt;port&gt;"
/// strings -- one per active IPv4 interface in private LAN ranges
/// (192.168.*, 10.*, 172.16-31.*). The Tray Settings UI shows these
/// so the admin knows what to type into their phone's browser.
/// <c>PublicUrl</c> is what gets inlined into outbound emails;
/// independent of the bind address.
/// </summary>
public sealed record NetworkConfigDto(
    string BindUrl,
    bool ExposeOnLan,
    int Port,
    IReadOnlyList<string> LanUrls,
    string PublicUrl,
    /// <summary>
    /// Ship 93: list of public hostnames to serve via Caddy
    /// (HTTPS auto-cert). Empty list means "no Caddy fronting"
    /// — the server is reached directly on its bind URL. Each
    /// entry is a bare hostname (e.g. "notes.slq.dk"); validated
    /// server-side before persistence.
    /// </summary>
    IReadOnlyList<string> PublicHostnames);

/// <summary>
/// All editable. Hot-reload-capable consumers (rate limiters, password
/// policy) pick up changes on the next request. Session timeout
/// changes apply to NEW sessions only — existing sessions keep
/// their previous expiry until they next refresh.
/// </summary>
public sealed record AuthConfigDto(
    int IdleTimeoutMinutes,
    int AbsoluteTimeoutMinutes,
    int MinimumPasswordLength,
    bool CheckPasswordAgainstHibp,
    int LoginAttemptsPerIpPerMinute,
    int LoginAttemptsPerAccountPerHour,
    int AccountLockoutMinutes);

/// <summary>
/// Editable. Persists today; backup execution comes in the next
/// ship's Backups window.
/// </summary>
public sealed record BackupConfigDto(
    bool Enabled,
    string TargetPath,
    string DailyTime,        // HH:MM 24h
    int RetainDailyCount,
    int RetainWeeklyCount);

/// <summary>Editable. Hot-reloadable for level changes.</summary>
public sealed record LoggingConfigDto(
    string MinimumLevel,     // Verbose | Debug | Information | Warning | Error | Fatal
    int RetainDays);
