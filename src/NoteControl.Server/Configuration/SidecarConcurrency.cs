using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace NoteControl.Server.Configuration;

/// <summary>
/// Optimistic concurrency for the whole-file per-vault sidecars
/// (startpage.json / dashboards, assignments.json, note-widgets.json).
///
/// Why: those files are replaced wholesale on every PUT, and the SPA
/// loads them once per page. Two tabs/devices (TwinCAT + lightserver,
/// phone + desktop) each held a snapshot, and whichever saved last
/// silently erased what the other had added — stickies, assignments,
/// other notes' widgets. Now:
///
///   - GET sends an ETag (hash of the file bytes, or "none" when the
///     file doesn't exist yet).
///   - PUT with If-Match is rejected with 412 when the file changed
///     since that ETag; the client then re-reads, merges its own
///     change into the fresh copy and retries.
///   - PUT without If-Match keeps the old last-write-wins behaviour,
///     so older clients keep working.
///
/// The check-then-write runs under a per-file lock, and GET reads the
/// file + computes the ETag under the same lock, so a client can't
/// receive old content paired with a new ETag. In-process only — the
/// server is the sole writer of these files.
/// </summary>
public static class SidecarConcurrency
{
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Locks =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>ETag for a file that doesn't exist (yet).</summary>
    public const string MissingEtag = "\"none\"";

    /// <summary>Run <paramref name="action"/> while holding the file's lock.</summary>
    public static async Task<T> WithLockAsync<T>(string filePath, Func<Task<T>> action)
    {
        var gate = Locks.GetOrAdd(Path.GetFullPath(filePath), _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync();
        try
        {
            return await action();
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>Strong ETag over the file's current bytes.</summary>
    public static async Task<string> ComputeEtagAsync(string filePath)
    {
        if (!File.Exists(filePath)) return MissingEtag;
        var bytes = await File.ReadAllBytesAsync(filePath);
        var hash = SHA256.HashData(bytes);
        return "\"" + Convert.ToHexString(hash, 0, 16).ToLowerInvariant() + "\"";
    }

    /// <summary>
    /// True when the request carries no If-Match (legacy client) or an
    /// If-Match equal to the current ETag ("*" matches anything).
    /// </summary>
    public static bool IfMatchSatisfied(HttpRequest request, string currentEtag)
    {
        var header = request.Headers.IfMatch.ToString();
        if (string.IsNullOrWhiteSpace(header)) return true;
        foreach (var raw in header.Split(','))
        {
            var candidate = raw.Trim();
            if (candidate == "*" || string.Equals(candidate, currentEtag, StringComparison.Ordinal))
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>The 412 every sidecar PUT returns on a stale If-Match.</summary>
    public static IResult PreconditionFailed(string what) =>
        Results.Problem(
            statusCode: StatusCodes.Status412PreconditionFailed,
            title: $"The {what} were changed elsewhere since you loaded them.",
            detail: "Reload, merge your change and try again.");
}
