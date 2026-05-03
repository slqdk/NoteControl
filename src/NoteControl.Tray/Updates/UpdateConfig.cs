namespace NoteControl.Tray.Updates;

/// <summary>
/// Hardcoded configuration for the in-app updater. Update these
/// when you set up a different repo, fork, or move release hosting.
///
/// Why hardcoded and not in a config file:
///   - The values change once a year at most, and committing the
///     change is exactly the right level of "recompile to take effect".
///   - A misconfigured update endpoint silently breaks the update
///     flow; baking it in makes it impossible to start the tray
///     with the wrong values.
///   - No admin UI is needed for what's essentially a build-time
///     constant.
///
/// If we ever decide to support forks pointing at different release
/// channels (unlikely), pull these into appsettings or a tray
/// config file.
/// </summary>
internal static class UpdateConfig
{
    /// <summary>
    /// GitHub username or organisation that owns the repo.
    ///
    /// TODO: set this to your GitHub username/org before the first
    /// real release. The placeholder value below makes the update
    /// check return "no updates" cleanly (the API call 404s and
    /// the checker treats that as "up to date" rather than crashing
    /// the tray). So shipping with the placeholder is safe — the
    /// updater is just a no-op until you fix it.
    /// </summary>
    public const string Owner = "REPLACE_ME_GITHUB_OWNER";

    /// <summary>Repository name. See note on Owner about the placeholder.</summary>
    public const string Repo = "REPLACE_ME_GITHUB_REPO";

    /// <summary>
    /// User-Agent string sent to api.github.com. GitHub rejects
    /// requests without a User-Agent header. The convention is
    /// app-name/version, but version isn't known at compile time
    /// here — we'll append the runtime-resolved version inside
    /// UpdateChecker so the value carries useful diagnostics.
    /// </summary>
    public const string UserAgentBase = "NoteControl-Tray";

    /// <summary>
    /// How often the tray polls for new releases after the initial
    /// startup check. 24 hours is the right ratio of "user notices
    /// updates within a day" vs "GitHub doesn't ratelimit us into
    /// oblivion." The unauthenticated API limit is 60 requests/hour
    /// per IP, so even with extreme bad luck we use ~1 of those.
    /// </summary>
    public static readonly TimeSpan PollInterval = TimeSpan.FromHours(24);

    /// <summary>
    /// Asset filename pattern. Releases must include an asset whose
    /// name matches this exact pattern (with {0} replaced by the
    /// version number from the tag). publish.ps1 -Zip produces
    /// "NoteControl-{version}.zip" which matches.
    /// </summary>
    public const string AssetNameFormat = "NoteControl-{0}.zip";
}
