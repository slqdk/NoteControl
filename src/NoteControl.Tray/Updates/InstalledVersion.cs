using System;
using System.IO;

namespace NoteControl.Tray.Updates;

/// <summary>
/// Resolves the currently-installed NoteControl version by reading
/// VERSION.txt next to the binaries.
///
/// Returns null if VERSION.txt isn't there (dev build, hand-copied
/// binaries, malformed file, etc.). The updater treats null as
/// "don't offer any update" — installing into a dev tree would
/// be confusing and probably wrong.
///
/// Format of VERSION.txt produced by publish.ps1:
///   NoteControl
///   Version:       1.2.3
///   Configuration: Release
///   Runtime:       win-x64
///   Built:         ...
///   Git SHA:       abc1234
///
/// Only the "Version:" line is parsed.
///
/// Note: the About window has its own version-display logic that
/// reads AssemblyInformationalVersion as a fallback. This class is
/// the source-of-truth for the UPDATER specifically, where we want
/// to be strict about "did this install come from a publish.ps1
/// run" before offering a remote upgrade.
/// </summary>
internal static class InstalledVersion
{
    /// <summary>
    /// Returns the parsed installed version, or null when there's
    /// no VERSION.txt (dev build) or it can't be parsed.
    /// </summary>
    public static SemanticVersion? Resolve() => TryReadVersionFile();

    private static SemanticVersion? TryReadVersionFile()
    {
        try
        {
            // AppContext.BaseDirectory points at the folder
            // containing the running .exe. tray\NoteControl.Tray.exe
            // -> AppContext.BaseDirectory == "...\\tray\\". Going
            // up one level lands at the install root where
            // VERSION.txt lives.
            var baseDir = AppContext.BaseDirectory;
            var parent = Directory.GetParent(baseDir.TrimEnd('\\', '/'));
            if (parent is null) return null;

            var versionFile = Path.Combine(parent.FullName, "VERSION.txt");
            if (!File.Exists(versionFile)) return null;

            foreach (var line in File.ReadLines(versionFile))
            {
                // "Version:       1.2.3"
                if (line.StartsWith("Version:", StringComparison.OrdinalIgnoreCase))
                {
                    var value = line["Version:".Length..].Trim();
                    return SemanticVersion.TryParseLoose(value);
                }
            }
        }
        catch
        {
            // Any IO / parsing failure means "couldn't determine
            // version". We don't want a corrupt VERSION.txt to
            // bring down the tray.
        }
        return null;
    }
}
