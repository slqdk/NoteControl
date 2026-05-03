using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace NoteControl.Tray.Updates;

/// <summary>
/// Subset of the GitHub Releases API JSON we actually use. The full
/// schema has dozens of fields; we deserialise only what we need.
/// System.Text.Json ignores unknown properties by default, so adding
/// fields later doesn't break old binaries.
///
/// Reference: https://docs.github.com/en/rest/releases/releases
/// </summary>
internal sealed class GitHubReleaseDto
{
    [JsonPropertyName("tag_name")]
    public string? TagName { get; set; }

    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("body")]
    public string? Body { get; set; }

    [JsonPropertyName("html_url")]
    public string? HtmlUrl { get; set; }

    [JsonPropertyName("prerelease")]
    public bool Prerelease { get; set; }

    [JsonPropertyName("draft")]
    public bool Draft { get; set; }

    [JsonPropertyName("published_at")]
    public string? PublishedAt { get; set; }

    [JsonPropertyName("assets")]
    public List<GitHubAssetDto> Assets { get; set; } = new();
}

internal sealed class GitHubAssetDto
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("browser_download_url")]
    public string? BrowserDownloadUrl { get; set; }

    [JsonPropertyName("size")]
    public long Size { get; set; }
}

/// <summary>
/// Outcome of a single update check, suitable for driving UI state.
/// </summary>
internal sealed record UpdateCheckResult
{
    /// <summary>
    /// True when there's a newer version available than what's
    /// installed AND we have a usable download URL. False covers:
    /// no network, no release found, asset missing, version
    /// unparseable, etc.
    /// </summary>
    public bool UpdateAvailable { get; init; }

    /// <summary>The currently-installed version, or null if unknown.</summary>
    public SemanticVersion? Installed { get; init; }

    /// <summary>The latest version on GitHub, or null if we couldn't fetch.</summary>
    public SemanticVersion? Latest { get; init; }

    /// <summary>
    /// Display name of the release ("NoteControl 1.2.3"). May be the
    /// same as the tag if the release has no name set.
    /// </summary>
    public string? ReleaseName { get; init; }

    /// <summary>Markdown body of the release ("release notes").</summary>
    public string? ReleaseNotes { get; init; }

    /// <summary>
    /// Direct download URL of the matching .zip asset. Null when
    /// no matching asset was found on the release.
    /// </summary>
    public string? AssetUrl { get; init; }

    /// <summary>Asset size in bytes (for download progress).</summary>
    public long AssetSize { get; init; }

    /// <summary>
    /// HTML page URL on github.com — useful as a fallback "open in
    /// browser" link in the dialog.
    /// </summary>
    public string? ReleasePageUrl { get; init; }

    /// <summary>
    /// One-line diagnostic string for the menu tooltip / debug log.
    /// Always populated, even on success ("Up to date" etc).
    /// </summary>
    public string Status { get; init; } = "";

    public static UpdateCheckResult NoUpdate(string status, SemanticVersion? installed = null) =>
        new() { UpdateAvailable = false, Status = status, Installed = installed };
}
