using System;

namespace NoteControl.Tray.Updates;

/// <summary>
/// Tiny semver-ish version type for comparing the tray's installed
/// version against the latest GitHub release tag. We can't use
/// System.Version because it doesn't handle pre-release suffixes
/// like "1.2.3-rc1" — Version.Parse would throw.
///
/// What we support:
///   - "1.2.3"            -> 1.2.3 release
///   - "1.2.3-rc1"        -> 1.2.3 prerelease
///   - "v1.2.3"           -> leading "v" stripped before parsing
///   - "1.2.3+sha.abc"    -> build metadata stripped (semver rule:
///                            build metadata is ignored for ordering)
///
/// What we ignore vs full semver:
///   - Numeric vs alphanumeric prerelease comparison rules. We do
///     a plain string compare on the prerelease part. Good enough
///     for typical "rc1 < rc2 < release" cases; might surprise on
///     weird tags, but we control the tagging.
///   - Multi-segment major.minor.patch is required; "1.0" rejected.
///     publish.ps1 takes whatever string the user passes for -Version,
///     so be consistent: always tag releases as MAJOR.MINOR.PATCH or
///     MAJOR.MINOR.PATCH-PRE.
/// </summary>
internal sealed class SemanticVersion : IComparable<SemanticVersion>, IEquatable<SemanticVersion>
{
    public int Major { get; }
    public int Minor { get; }
    public int Patch { get; }
    public string Prerelease { get; } // empty for stable releases

    public SemanticVersion(int major, int minor, int patch, string prerelease)
    {
        Major = major;
        Minor = minor;
        Patch = patch;
        Prerelease = prerelease ?? string.Empty;
    }

    public bool IsPrerelease => Prerelease.Length > 0;

    /// <summary>
    /// Forgiving parser: accepts "v" prefix and ignores +build
    /// metadata. Returns null if the input can't be parsed —
    /// callers treat null as "unknown version", which makes the
    /// updater silently skip rather than throw.
    /// </summary>
    public static SemanticVersion? TryParseLoose(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var s = raw.Trim();

        // Strip leading "v" so "v1.2.3" parses.
        if (s.StartsWith('v') || s.StartsWith('V')) s = s[1..];

        // Strip semver build metadata (everything after first '+').
        var plus = s.IndexOf('+');
        if (plus >= 0) s = s[..plus];

        // Split into core + prerelease at the first '-'.
        // Anything beyond that is part of the prerelease label.
        string core, pre;
        var dash = s.IndexOf('-');
        if (dash >= 0)
        {
            core = s[..dash];
            pre = s[(dash + 1)..];
        }
        else
        {
            core = s;
            pre = string.Empty;
        }

        // Core must be exactly major.minor.patch with non-negative ints.
        var parts = core.Split('.');
        if (parts.Length != 3) return null;
        if (!int.TryParse(parts[0], out var maj) || maj < 0) return null;
        if (!int.TryParse(parts[1], out var min) || min < 0) return null;
        if (!int.TryParse(parts[2], out var pat) || pat < 0) return null;

        return new SemanticVersion(maj, min, pat, pre);
    }

    public int CompareTo(SemanticVersion? other)
    {
        if (other is null) return 1;
        var c = Major.CompareTo(other.Major);
        if (c != 0) return c;
        c = Minor.CompareTo(other.Minor);
        if (c != 0) return c;
        c = Patch.CompareTo(other.Patch);
        if (c != 0) return c;

        // Semver: a prerelease has LOWER precedence than the same
        // version without a prerelease. So "1.2.3-rc1" < "1.2.3".
        if (Prerelease.Length == 0 && other.Prerelease.Length > 0) return 1;
        if (Prerelease.Length > 0 && other.Prerelease.Length == 0) return -1;

        // Both have prereleases (or both are stable). Plain string
        // compare. Not strictly semver-correct (semver does
        // dot-separated identifier comparison with numeric handling)
        // but we control the tag scheme so simpler is fine.
        return string.CompareOrdinal(Prerelease, other.Prerelease);
    }

    public bool Equals(SemanticVersion? other) =>
        other is not null && CompareTo(other) == 0;

    public override bool Equals(object? obj) => obj is SemanticVersion v && Equals(v);

    public override int GetHashCode() =>
        HashCode.Combine(Major, Minor, Patch, Prerelease);

    public override string ToString() =>
        Prerelease.Length > 0
            ? $"{Major}.{Minor}.{Patch}-{Prerelease}"
            : $"{Major}.{Minor}.{Patch}";
}
