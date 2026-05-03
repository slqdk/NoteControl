using System.IO;
using System.Text.Json;

namespace NoteControl.Tray.Server;

/// <summary>
/// Reads the server URL file written by the server's
/// ServerUrlPublisher (step 43). Used by the tray to figure out
/// which port to talk to instead of hardcoding 8080.
///
/// File location: <c>{DataRoot}/.server/server.url</c>, same
/// folder as <c>tray.token</c>. <c>NC_DATA_ROOT</c> env var takes
/// precedence over the platform default, mirroring the resolution
/// logic in HttpAdminClient.ResolveTrayTokenPath.
///
/// File shape: a small JSON object with two known keys, both
/// strings:
/// <code>
/// {
///   "trayUrl":   "http://127.0.0.1:1234",
///   "publicUrl": "http://30.11.0.101:1234"
/// }
/// </code>
///
/// Resolution semantics:
/// <list type="bullet">
///   <item>
///     <description>
///     <b>TrayUrl</b>: the loopback URL the tray uses for its own
///     HTTP traffic. Falls back to <see cref="DefaultTrayUrl"/>
///     (port 8080, the historic default) if the file is missing
///     or unreadable. This means: if the user has never started
///     the new server, or the file got deleted, the tray still
///     does *something* — usually wrong, but visibly so, and
///     fixable by starting the server (which writes the file).
///     </description>
///   </item>
///   <item>
///     <description>
///     <b>PublicUrl</b>: the externally-typeable URL. Less
///     critical for tray operation; used by code paths that
///     display "the URL others would use." Same fallback chain.
///     </description>
///   </item>
/// </list>
///
/// Read once at app startup. Changes to the file (e.g. user
/// reconfigures the port) take effect on next tray restart, NOT
/// the next API call. We could re-read on every call but the
/// existing tray UX already implies a tray restart for port
/// changes (the historic hardcoded const had the same constraint),
/// and reading on every call adds complexity for a workflow the
/// user runs maybe once a year.
/// </summary>
public static class ServerUrlResolver
{
    /// <summary>
    /// Default tray URL when the server.url file isn't available.
    /// Matches the legacy hardcoded value so unconfigured installs
    /// keep working as they always did.
    /// </summary>
    public const string DefaultTrayUrl = "http://127.0.0.1:8080";

    public static ResolvedUrls Resolve()
    {
        try
        {
            var path = ResolveFilePath();
            if (!File.Exists(path))
            {
                return new ResolvedUrls(DefaultTrayUrl, DefaultTrayUrl, FallbackReason.FileMissing);
            }

            var json = File.ReadAllText(path);
            var dto = JsonSerializer.Deserialize<ServerUrlFile>(json, JsonOpts);
            if (dto is null
                || string.IsNullOrWhiteSpace(dto.TrayUrl)
                || string.IsNullOrWhiteSpace(dto.PublicUrl))
            {
                return new ResolvedUrls(DefaultTrayUrl, DefaultTrayUrl, FallbackReason.FileInvalid);
            }
            return new ResolvedUrls(dto.TrayUrl, dto.PublicUrl, FallbackReason.None);
        }
        catch (Exception ex)
        {
            // Logging would be ideal here, but this static helper
            // is called before the WPF app's logger is set up, so
            // we just return the fallback. Caller can inspect
            // FallbackReason and log if it cares.
            return new ResolvedUrls(
                DefaultTrayUrl,
                DefaultTrayUrl,
                FallbackReason.ReadFailed,
                ex.Message);
        }
    }

    /// <summary>
    /// File path resolution. Mirrors HttpAdminClient.ResolveTrayTokenPath
    /// — same DataRoot environment variable, same folder. Uses a
    /// platform-specific default when NC_DATA_ROOT isn't set.
    /// </summary>
    private static string ResolveFilePath()
    {
        var dataRoot = Environment.GetEnvironmentVariable("NC_DATA_ROOT");
        if (string.IsNullOrWhiteSpace(dataRoot))
        {
            // Same default as HttpAdminClient. On Windows:
            // %ProgramData%\NoteControl\NotesData. On other
            // platforms (test only): /var/lib/notecontrol.
            if (OperatingSystem.IsWindows())
            {
                var programData = Environment.GetFolderPath(
                    Environment.SpecialFolder.CommonApplicationData);
                dataRoot = Path.Combine(programData, "NoteControl", "NotesData");
            }
            else
            {
                dataRoot = "/var/lib/notecontrol";
            }
        }
        return Path.Combine(dataRoot, ".server", "server.url");
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private sealed record ServerUrlFile(string TrayUrl, string PublicUrl);
}

/// <summary>
/// Result of a resolve. Always non-null TrayUrl and PublicUrl —
/// fallback is the legacy default rather than throwing, so callers
/// don't have to special-case "no file." The FallbackReason lets
/// callers report status to the user if they want.
/// </summary>
public sealed record ResolvedUrls(
    string TrayUrl,
    string PublicUrl,
    FallbackReason FallbackReason,
    string? Detail = null);

public enum FallbackReason
{
    /// <summary>File found, parsed, both URLs valid. Use as-is.</summary>
    None,
    /// <summary>server.url didn't exist; using legacy default.</summary>
    FileMissing,
    /// <summary>File existed but couldn't be parsed; using legacy default.</summary>
    FileInvalid,
    /// <summary>I/O error reading the file; using legacy default.</summary>
    ReadFailed,
}
