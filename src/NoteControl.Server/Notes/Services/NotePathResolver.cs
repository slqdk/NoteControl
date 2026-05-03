namespace NoteControl.Server.Notes.Services;

/// <summary>
/// Resolves note paths within a single vault to absolute filesystem paths.
/// Mirrors the role of <see cref="Vaults.Services.VaultPathResolver"/> but
/// operates inside a vault root rather than the data root.
///
/// Every note-touching code path must go through this. The same threat
/// model applies: traversal, Windows reserved names, illegal characters,
/// trailing dots/spaces. Plus two vault-specific rules:
///   1. Paths cannot reach into the .notesapp/ folder.
///   2. Note paths must end in .md (case-insensitive).
/// </summary>
public interface INotePathResolver
{
    /// <summary>Validate a relative note path and resolve to an absolute path under the vault root.</summary>
    string Resolve(string vaultRoot, string relativeNotePath);

    /// <summary>Validate a folder path (does NOT need to end in .md). Empty string allowed for vault root.</summary>
    string ResolveFolder(string vaultRoot, string relativeFolderPath);

    /// <summary>Canonical form (forward slashes, no leading/trailing slash). Throws if invalid.</summary>
    string CanonicalizeNote(string relativeNotePath);

    /// <summary>Same but for folders; allows empty string for the root.</summary>
    string CanonicalizeFolder(string relativeFolderPath);
}

public sealed class InvalidNotePathException : Exception
{
    public InvalidNotePathException(string message) : base(message) { }
}

public sealed class NotePathResolver : INotePathResolver
{
    private const string AppFolder = ".notesapp";

    public string CanonicalizeNote(string relativeNotePath)
    {
        var canonical = CanonicalizeFolder(relativeNotePath);
        if (canonical.Length == 0)
        {
            throw new InvalidNotePathException("Note path is required.");
        }
        if (!canonical.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidNotePathException("Note path must end with .md.");
        }
        return canonical;
    }

    public string CanonicalizeFolder(string relativeFolderPath)
    {
        if (relativeFolderPath is null)
        {
            return string.Empty;
        }

        var normalized = relativeFolderPath.Replace('\\', '/').Trim('/');
        while (normalized.Contains("//", StringComparison.Ordinal))
        {
            normalized = normalized.Replace("//", "/", StringComparison.Ordinal);
        }

        if (normalized.Length == 0)
        {
            // Empty path is the vault root — valid for folder operations,
            // rejected by CanonicalizeNote.
            return string.Empty;
        }

        var segments = normalized.Split('/');
        foreach (var segment in segments)
        {
            ValidateSegment(segment);
        }

        // First segment must not be .notesapp — that folder is app-internal
        // and shouldn't be reachable through the notes API.
        if (string.Equals(segments[0], AppFolder, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidNotePathException(
                "Paths under .notesapp are reserved for app metadata.");
        }

        return normalized;
    }

    public string Resolve(string vaultRoot, string relativeNotePath)
    {
        var canonical = CanonicalizeNote(relativeNotePath);
        return ResolveCanonical(vaultRoot, canonical);
    }

    public string ResolveFolder(string vaultRoot, string relativeFolderPath)
    {
        var canonical = CanonicalizeFolder(relativeFolderPath);
        return ResolveCanonical(vaultRoot, canonical);
    }

    private static string ResolveCanonical(string vaultRoot, string canonicalRelative)
    {
        var rootFull = Path.GetFullPath(vaultRoot);

        if (canonicalRelative.Length == 0)
        {
            return rootFull;
        }

        var combined = Path.Combine(rootFull, canonicalRelative.Replace('/', Path.DirectorySeparatorChar));
        var fullPath = Path.GetFullPath(combined);

        if (!IsUnder(fullPath, rootFull))
        {
            throw new InvalidNotePathException("Resolved note path escapes the vault root.");
        }

        return fullPath;
    }

    private static void ValidateSegment(string segment)
    {
        if (string.IsNullOrEmpty(segment))
        {
            throw new InvalidNotePathException("Empty path segment.");
        }
        if (segment is "." or "..")
        {
            throw new InvalidNotePathException("Path traversal segments are not allowed.");
        }
        if (segment.StartsWith(' ') || segment.EndsWith(' ') || segment.EndsWith('.'))
        {
            // Windows trims these silently; reject at the door. Note: this
            // also rejects ".md" by itself (segment ending in dot before md
            // would be e.g. "foo." which fails here), but a real ".md" file
            // has segment "foo.md" which ends in 'd', fine.
            // Special exception: a segment ending in ".md" is fine because
            // it ends with 'd', not '.'. The test above is "ends with '.'".
            throw new InvalidNotePathException(
                "Path segment cannot start with space or end with space/period.");
        }
        foreach (var ch in segment)
        {
            if (ch < 32) throw new InvalidNotePathException("Path segment contains a control character.");
            if ("<>:\"/\\|?*".Contains(ch))
            {
                throw new InvalidNotePathException($"Path segment contains an illegal character: '{ch}'.");
            }
        }

        var bare = segment;
        var dot = bare.IndexOf('.');
        if (dot > 0) bare = bare[..dot];
        if (ReservedNames.Contains(bare))
        {
            throw new InvalidNotePathException($"'{segment}' is a reserved Windows name.");
        }
    }

    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    private static bool IsUnder(string candidate, string root)
    {
        var normalizedRoot = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                                 + Path.DirectorySeparatorChar;
        // Allow candidate == root for folder resolves (the vault root itself).
        if (string.Equals(candidate.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                          root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                          StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        return candidate.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase);
    }
}
