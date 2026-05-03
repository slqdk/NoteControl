using System;
using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Threading;
using System.Threading.Tasks;

namespace NoteControl.Tray.Updates;

/// <summary>
/// Talks to the GitHub Releases API to check for newer versions.
/// Stateless — each Check call is independent, and the App layer
/// owns the timer + last-result cache.
/// </summary>
internal sealed class UpdateChecker
{
    // Static so multiple checks share one socket pool and the
    // underlying HttpClient. HttpClient is the one type in .NET
    // where instance-per-call is wrong (socket exhaustion); the
    // recommended pattern is one shared instance.
    private static readonly HttpClient Http = CreateHttp();

    private static HttpClient CreateHttp()
    {
        var c = new HttpClient
        {
            // GitHub's API is generally fast (<500ms), but DNS or
            // TCP issues can hang indefinitely. 15s is generous
            // for a one-shot JSON GET.
            Timeout = TimeSpan.FromSeconds(15),
        };

        // Required header; GitHub API rejects requests without it.
        var version = InstalledVersion.Resolve()?.ToString() ?? "dev";
        c.DefaultRequestHeaders.UserAgent.Add(
            new ProductInfoHeaderValue(UpdateConfig.UserAgentBase, version));

        // Recommended by GitHub for long-term stability of the
        // response shape. Without it you get the "default" media
        // type which they explicitly say "may change."
        c.DefaultRequestHeaders.Accept.Add(
            new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));

        return c;
    }

    /// <summary>
    /// Run a single update check. Always succeeds (returns a
    /// result instead of throwing) — failures show up in the
    /// returned record's Status field. Designed for "fire from a
    /// timer, look at the result, don't worry about exceptions".
    /// </summary>
    public async Task<UpdateCheckResult> CheckAsync(CancellationToken ct = default)
    {
        var installed = InstalledVersion.Resolve();
        if (installed is null)
        {
            // Dev build, or VERSION.txt missing. Bail before we
            // make any network call -- offering an "update" to a
            // dev build would be confusing.
            return UpdateCheckResult.NoUpdate("Running a dev build (no VERSION.txt). Updates skipped.");
        }

        // Bail early if the constants haven't been pointed at a
        // real repo. The placeholder values cause the API to 404
        // anyway, but failing locally is cleaner than burning a
        // request to confirm.
        if (UpdateConfig.Owner.StartsWith("REPLACE_ME") ||
            UpdateConfig.Repo.StartsWith("REPLACE_ME"))
        {
            return UpdateCheckResult.NoUpdate(
                "Updater not configured (UpdateConfig.Owner/Repo placeholders).",
                installed);
        }

        var url = $"https://api.github.com/repos/{UpdateConfig.Owner}/{UpdateConfig.Repo}/releases/latest";

        GitHubReleaseDto? release;
        try
        {
            release = await Http.GetFromJsonAsync<GitHubReleaseDto>(url, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex) when ((int?)ex.StatusCode == 404)
        {
            // 404 = no public releases yet. Not an error from the
            // user's point of view -- just nothing to update to.
            return UpdateCheckResult.NoUpdate("No releases published yet.", installed);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return UpdateCheckResult.NoUpdate("Update check timed out.", installed);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[NoteControl.Tray] Update check failed: {ex}");
            return UpdateCheckResult.NoUpdate($"Update check failed: {ex.GetType().Name}.", installed);
        }

        if (release is null || release.Draft)
        {
            return UpdateCheckResult.NoUpdate("No published release found.", installed);
        }

        var latest = SemanticVersion.TryParseLoose(release.TagName);
        if (latest is null)
        {
            return UpdateCheckResult.NoUpdate(
                $"Latest tag '{release.TagName}' is not a valid version string.",
                installed);
        }

        if (latest.CompareTo(installed) <= 0)
        {
            return new UpdateCheckResult
            {
                UpdateAvailable = false,
                Installed = installed,
                Latest = latest,
                Status = "Up to date.",
            };
        }

        // We have a newer version. Find the asset with the right name.
        // The expected pattern matches what publish.ps1 produces.
        var expectedAssetName = string.Format(UpdateConfig.AssetNameFormat, latest.ToString());
        GitHubAssetDto? asset = null;
        foreach (var a in release.Assets)
        {
            if (string.Equals(a.Name, expectedAssetName, StringComparison.OrdinalIgnoreCase))
            {
                asset = a;
                break;
            }
        }

        if (asset is null || string.IsNullOrEmpty(asset.BrowserDownloadUrl))
        {
            // The release exists but doesn't have the expected zip.
            // Surface this clearly: the user might have done a
            // source-only release without uploading the build.
            // Offer the page URL instead so they can grab it manually.
            return new UpdateCheckResult
            {
                UpdateAvailable = false,
                Installed = installed,
                Latest = latest,
                ReleaseName = release.Name,
                ReleaseNotes = release.Body,
                ReleasePageUrl = release.HtmlUrl,
                Status = $"Newer version {latest} found, but no '{expectedAssetName}' asset attached. " +
                         "Open the release page to download manually.",
            };
        }

        return new UpdateCheckResult
        {
            UpdateAvailable = true,
            Installed = installed,
            Latest = latest,
            ReleaseName = string.IsNullOrEmpty(release.Name) ? release.TagName : release.Name,
            ReleaseNotes = release.Body,
            AssetUrl = asset.BrowserDownloadUrl,
            AssetSize = asset.Size,
            ReleasePageUrl = release.HtmlUrl,
            Status = $"Update available: {latest} (you have {installed}).",
        };
    }
}
