using Microsoft.Extensions.Options;
using NoteControl.Server.Options;

namespace NoteControl.Server.Vaults.Services;

/// <summary>
/// The single point in the codebase that turns a vault's stored relative
/// path (e.g. "users/alice/Personal") into a real absolute filesystem path.
///
/// EVERY vault-touching code path goes through this. Bypassing it — building
/// filesystem paths from user input directly — is a path-traversal bug and
/// must not happen.
/// </summary>
public interface IVaultPathResolver
{
    /// <summary>
    /// Validate that <paramref name="relativePath"/> is well-formed (no
    /// traversal, valid characters, correct prefix) and resolve it to an
    /// absolute path under DataRoot. Throws <see cref="InvalidVaultPathException"/>
    /// on any rejection — callers must catch this and surface a 400.
    /// </summary>
    string Resolve(string relativePath);

    /// <summary>
    /// Validate the same way as <see cref="Resolve"/> but also constrain the
    /// path's first segment. <paramref name="expectedScope"/> is "personal"
    /// or "shared". For personal, the second segment must equal the supplied
    /// username — preventing user A from creating a vault inside user B's
    /// folder.
    /// </summary>
    string ResolveForCreate(string relativePath, string expectedOwnerUsername, string expectedScope);

    /// <summary>
    /// Returns the canonicalized form of a relative path (forward slashes,
    /// no leading or trailing slash). Used when inserting / comparing rows.
    /// </summary>
    string Canonicalize(string relativePath);
}

public sealed class InvalidVaultPathException : Exception
{
    public InvalidVaultPathException(string message) : base(message) { }
}

public sealed class VaultPathResolver : IVaultPathResolver
{
    private readonly string _dataRoot;

    public VaultPathResolver(IOptions<StorageOptions> storage)
    {
        // Normalise the data root once, up-front. We trust this value
        // because it comes from configuration, not from user input.
        _dataRoot = Path.GetFullPath(storage.Value.DataRoot);
    }

    public string Canonicalize(string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath))
        {
            throw new InvalidVaultPathException("Vault path is required.");
        }

        // Convert any backslashes to forward slashes so callers can pass
        // either; trim leading and trailing slashes; collapse repeated
        // slashes ("foo//bar" -> "foo/bar").
        var normalized = relativePath.Replace('\\', '/').Trim('/');
        while (normalized.Contains("//", StringComparison.Ordinal))
        {
            normalized = normalized.Replace("//", "/", StringComparison.Ordinal);
        }

        if (normalized.Length == 0)
        {
            throw new InvalidVaultPathException("Vault path is required.");
        }

        var segments = normalized.Split('/');
        if (segments.Length < 2)
        {
            // Reject paths like "shared" or "users" that have no leaf folder
            // — we always need at least scope + vault name.
            throw new InvalidVaultPathException("Vault path must include a scope and a vault name.");
        }

        foreach (var segment in segments)
        {
            ValidateSegment(segment);
        }

        return normalized;
    }

    public string Resolve(string relativePath)
    {
        var canonical = Canonicalize(relativePath);
        var combined = Path.Combine(_dataRoot, canonical.Replace('/', Path.DirectorySeparatorChar));
        var fullPath = Path.GetFullPath(combined);

        // Defence in depth: even after Canonicalize() rejected ".." segments,
        // we re-check that the resolved absolute path is still under the
        // data root. If platform behaviour ever surprises us, this catches
        // it.
        if (!IsUnder(fullPath, _dataRoot))
        {
            throw new InvalidVaultPathException("Resolved vault path escapes the data root.");
        }

        return fullPath;
    }

    public string ResolveForCreate(string relativePath, string expectedOwnerUsername, string expectedScope)
    {
        var canonical = Canonicalize(relativePath);
        var segments = canonical.Split('/');

        switch (expectedScope)
        {
            case "personal":
                // users/<expectedOwnerUsername>/<vaultName>[/...]
                //
                // For self-service vault creation, the caller passes
                // their own username. For admin "create on behalf of"
                // flows, the caller passes the target owner's username
                // — VaultService is responsible for verifying the
                // caller is allowed to do so before invoking us.
                if (!string.Equals(segments[0], "users", StringComparison.Ordinal))
                {
                    throw new InvalidVaultPathException("Personal vaults must live under 'users/'.");
                }
                if (segments.Length < 3)
                {
                    throw new InvalidVaultPathException("Personal vault path must be users/<username>/<vault>.");
                }
                if (!string.Equals(segments[1], expectedOwnerUsername, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidVaultPathException(
                        "Personal vault path must use the chosen owner's username.");
                }
                break;

            case "shared":
                // shared/<vaultName>[/...]
                if (!string.Equals(segments[0], "shared", StringComparison.Ordinal))
                {
                    throw new InvalidVaultPathException("Shared vaults must live under 'shared/'.");
                }
                if (segments.Length < 2)
                {
                    throw new InvalidVaultPathException("Shared vault path must be shared/<vault>.");
                }
                break;

            default:
                throw new InvalidVaultPathException($"Unknown vault scope '{expectedScope}'.");
        }

        return Resolve(canonical);
    }

    /// <summary>
    /// Reject path segments containing characters that cause trouble on
    /// Windows or NTFS, plus dot-segments and reserved device names. Conservative
    /// — better to reject "Café" than allow "AUX".
    /// </summary>
    private static void ValidateSegment(string segment)
    {
        if (string.IsNullOrEmpty(segment))
        {
            throw new InvalidVaultPathException("Empty path segment.");
        }
        if (segment is "." or "..")
        {
            throw new InvalidVaultPathException("Path traversal segments are not allowed.");
        }
        if (segment.StartsWith(' ') || segment.EndsWith(' ') || segment.EndsWith('.'))
        {
            // Windows trims these silently, leading to surprising behaviour.
            throw new InvalidVaultPathException("Path segment cannot start with space or end with space/period.");
        }

        // Disallowed on Windows file names regardless of NTFS: < > : " / \ | ? *
        // Plus all control chars (0-31).
        foreach (var ch in segment)
        {
            if (ch < 32) throw new InvalidVaultPathException("Path segment contains a control character.");
            if ("<>:\"/\\|?*".Contains(ch))
            {
                throw new InvalidVaultPathException($"Path segment contains an illegal character: '{ch}'.");
            }
        }

        // Reserved device names on Windows. These can never be used as file
        // or folder names regardless of extension.
        var bare = segment;
        var dot = bare.IndexOf('.');
        if (dot > 0)
        {
            bare = bare[..dot];
        }
        if (ReservedNames.Contains(bare))
        {
            throw new InvalidVaultPathException($"'{segment}' is a reserved Windows name.");
        }
    }

    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    /// <summary>
    /// Case-insensitive (Windows) check that <paramref name="candidate"/> is
    /// the same path as <paramref name="root"/> or strictly inside it.
    /// </summary>
    private static bool IsUnder(string candidate, string root)
    {
        var normalizedRoot = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                                 + Path.DirectorySeparatorChar;
        var normalizedCandidate = candidate;

        // The candidate IS the root (creating the root itself) — disallow.
        // Vaults must be at least one level deeper.
        if (string.Equals(candidate.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                          root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                          StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return normalizedCandidate.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase);
    }
}
