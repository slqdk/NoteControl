using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace NoteControl.Tray.Settings;

/// <summary>
/// Lightweight per-user tray preferences. JSON file at
/// %LOCALAPPDATA%\NoteControl\tray-prefs.json. Read on demand, written
/// when something changes. No file system watcher / hot reload --
/// each window that reads prefs gets the value at open time and
/// writes back on close. Concurrency is not a concern since only
/// one tray instance per Windows user runs at a time.
///
/// Why not %APPDATA% (roaming)? These are UI knobs that wouldn't
/// transfer meaningfully across machines, and the deployment story
/// is single-machine. Local AppData also doesn't sync to OneDrive
/// by default which avoids surprise round-trips.
///
/// Why not Properties.Settings? It works in WPF but stores XML in a
/// per-version, per-hash subfolder under LocalAppData that's a pain
/// to find or edit by hand. Plain JSON in a known path is easier to
/// inspect, edit, or delete.
///
/// Forward-compat: missing fields use the type's default (false /
/// null / 0). Extra unknown fields in the file are preserved silently
/// because we deserialize into the struct, mutate, then serialize
/// the same shape -- but unknown JSON properties at the root are
/// LOST on save. This is acceptable for a small set of UI prefs;
/// if we ever need extension fields, switch to JsonNode round-trips.
/// </summary>
public sealed class TrayPrefs
{
    [JsonPropertyName("vaultsShowAll")]
    public bool VaultsShowAll { get; set; }

    // Add future prefs here. Each new field should have a sensible
    // default (the field's default value when missing from JSON).

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingDefault,
    };

    /// <summary>
    /// Returns the path to the prefs file. Creates the parent folder
    /// if missing. The file itself may not exist yet (first run).
    /// </summary>
    public static string GetFilePath()
    {
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "NoteControl");
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, "tray-prefs.json");
    }

    /// <summary>
    /// Loads prefs from disk. Returns a fresh instance with defaults
    /// if the file is missing, empty, or corrupt -- we never throw
    /// from here, since prefs are non-critical and the tray should
    /// always start.
    /// </summary>
    public static TrayPrefs Load()
    {
        var path = GetFilePath();
        try
        {
            if (!File.Exists(path)) return new TrayPrefs();
            var json = File.ReadAllText(path);
            if (string.IsNullOrWhiteSpace(json)) return new TrayPrefs();
            return JsonSerializer.Deserialize<TrayPrefs>(json, JsonOptions) ?? new TrayPrefs();
        }
        catch
        {
            // Corrupt or unreadable file: start fresh. We could log,
            // but the tray's logger isn't wired through here and the
            // failure mode is "user's UI preference resets" which
            // isn't worth user-visible noise.
            return new TrayPrefs();
        }
    }

    /// <summary>
    /// Persists this instance to disk. Best-effort; swallows any IO
    /// errors silently (same rationale as Load -- prefs are non-
    /// critical, and failing here would block the user from closing
    /// a window).
    /// </summary>
    public void Save()
    {
        var path = GetFilePath();
        try
        {
            var json = JsonSerializer.Serialize(this, JsonOptions);
            File.WriteAllText(path, json);
        }
        catch
        {
            // Disk full / permission denied / antivirus locked file /
            // user revoked AppData access -- any of these would be
            // strange, but none should crash the tray. Silent skip.
        }
    }
}
