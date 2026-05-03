using System;
using System.IO;

namespace NoteControl.Tray.Settings;

/// <summary>
/// Tray-local path resolution for the data folder and things inside
/// it. The tray runs on the same machine as the server (single-machine
/// deployment is the only deployment story), so it can compute
/// absolute on-disk paths without having to ask the server.
///
/// Resolution rules mirror what the server does on startup:
///   1. NC_DATA_ROOT environment variable, if set
///   2. %ProgramData%\NoteControl\NotesData (the production default)
///
/// If you change the server's resolution rules, change this too --
/// they MUST stay in lockstep or "Open in Explorer" buttons will
/// open the wrong folder.
/// </summary>
public static class TrayPaths
{
    private const string DefaultDataRootSubpath = @"NoteControl\NotesData";

    /// <summary>
    /// Returns the absolute path of the data folder, or null if it
    /// can't be resolved (in practice this only happens on a system
    /// without %ProgramData% defined, which is exotic).
    /// </summary>
    public static string? ResolveDataRoot()
    {
        var env = Environment.GetEnvironmentVariable("NC_DATA_ROOT");
        if (!string.IsNullOrWhiteSpace(env)) return env;

        var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        if (string.IsNullOrEmpty(programData)) return null;
        return Path.Combine(programData, DefaultDataRootSubpath);
    }

    /// <summary>
    /// Translate a vault's API-relative path (e.g. "users/alice/Plans"
    /// with forward slashes, as returned by VaultDto.Path) into the
    /// absolute Windows path on this machine. Returns null if the
    /// data root can't be resolved.
    /// </summary>
    public static string? ResolveVaultFolder(string vaultRelativePath)
    {
        var dataRoot = ResolveDataRoot();
        if (dataRoot is null) return null;
        // The API uses forward slashes; Path.Combine on Windows
        // is happy with either, but we normalise to backslash so
        // the resulting string looks like a real Windows path
        // (matters for display in error messages).
        var windowsRel = vaultRelativePath.Replace('/', Path.DirectorySeparatorChar);
        return Path.Combine(dataRoot, windowsRel);
    }
}
