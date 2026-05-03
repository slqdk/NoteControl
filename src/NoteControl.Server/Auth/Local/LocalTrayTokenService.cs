using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using NoteControl.Server.Options;

namespace NoteControl.Server.Auth.Local;

/// <summary>
/// Manages the local-only token used by the tray app to skip
/// interactive login. The token is generated fresh on every server
/// start (so a leak has bounded lifetime) and written to
/// <c>{DataRoot}/.server/tray.token</c>. Only callers running on
/// the same machine (loopback IP) may use it.
///
/// <para>
/// On Windows we set the file ACL so that only the SYSTEM account,
/// the Administrators group, and the user the server runs as can
/// read it. On non-Windows platforms (i.e. tests on Linux CI) we
/// just write the file with default perms — the test runner is
/// the only thing that can read it anyway.
/// </para>
/// </summary>
public interface ILocalTrayTokenService
{
    /// <summary>
    /// Returns true if <paramref name="presented"/> matches the
    /// in-memory token. Constant-time comparison so timing can't
    /// leak the token a byte at a time.
    /// </summary>
    bool Validate(string presented);
}

public sealed class LocalTrayTokenService : ILocalTrayTokenService
{
    private const string AppFolder = ".server";
    private const string TokenFileName = "tray.token";

    private readonly byte[] _tokenBytes;
    private readonly string _tokenString;

    public LocalTrayTokenService(IOptions<StorageOptions> storage, ILogger<LocalTrayTokenService> log)
    {
        var dataRoot = storage.Value.DataRoot;
        if (string.IsNullOrWhiteSpace(dataRoot))
        {
            // Same posture as ServerConfigStore: if DataRoot isn't
            // configured we can't write the token. Throw — Program.cs
            // resolves the service eagerly so a misconfigured server
            // fails fast rather than running half-broken.
            throw new InvalidOperationException(
                "Storage:DataRoot is not configured; cannot create tray token.");
        }

        // 32 random bytes → URL-safe base64 of ~43 chars. Plenty of
        // entropy and still copy-pasteable for debugging.
        _tokenBytes = RandomNumberGenerator.GetBytes(32);
        _tokenString = Base64Url(_tokenBytes);

        var folder = Path.Combine(dataRoot, AppFolder);
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, TokenFileName);

        try
        {
            // Write atomically via temp + rename so a torn write
            // never leaves the tray reading half a token.
            var temp = path + ".tmp";
            File.WriteAllText(temp, _tokenString);
            if (File.Exists(path)) File.Delete(path);
            File.Move(temp, path);

            // Restrict ACL on Windows. On other platforms we skip —
            // the test environment doesn't need this and the API
            // throws on Linux.
            if (OperatingSystem.IsWindows())
            {
                TryRestrictFileAcl(path, log);
            }

            log.LogInformation(
                "Local tray token generated at {Path} ({Length} chars).",
                path, _tokenString.Length);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex,
                "Failed to write local tray token to {Path}; tray auto-login will not work.",
                path);
        }
    }

    public bool Validate(string presented)
    {
        if (string.IsNullOrEmpty(presented)) return false;

        // Decode both sides to bytes and use a fixed-time compare.
        // If presented isn't valid base64-url, treat as mismatch.
        byte[] presentedBytes;
        try
        {
            presentedBytes = FromBase64Url(presented);
        }
        catch (FormatException)
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(presentedBytes, _tokenBytes);
    }

    /// <summary>
    /// On Windows: replace the file's DACL so only SYSTEM, the
    /// local Administrators group, and the current process owner
    /// can read it. The server's "Users" group access (the default
    /// inherited from %ProgramData%) is removed.
    /// </summary>
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static void TryRestrictFileAcl(string path, ILogger log)
    {
        try
        {
            var info = new FileInfo(path);
            var sec = info.GetAccessControl();

            // Disable inheritance and remove inherited rules — we
            // want this file to have ONLY the rules we set below.
            sec.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);

            // SYSTEM (well-known SID) — full control, in case a
            // service account needs it during recovery.
            var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            sec.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                system,
                System.Security.AccessControl.FileSystemRights.FullControl,
                System.Security.AccessControl.AccessControlType.Allow));

            // Administrators group — full control for break-glass.
            var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            sec.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                admins,
                System.Security.AccessControl.FileSystemRights.FullControl,
                System.Security.AccessControl.AccessControlType.Allow));

            // The user the server process is running as — read.
            // (When the server runs as LocalSystem this is the same
            // as the SYSTEM rule above; harmless duplicate.)
            using var identity = WindowsIdentity.GetCurrent();
            if (identity.User is not null)
            {
                sec.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                    identity.User,
                    System.Security.AccessControl.FileSystemRights.Read,
                    System.Security.AccessControl.AccessControlType.Allow));
            }

            info.SetAccessControl(sec);
        }
        catch (Exception ex)
        {
            // ACL hardening is defence-in-depth, not the primary
            // gate (the primary gate is the loopback check on the
            // server side). Log and continue — a less-restrictive
            // ACL still works, it just allows other local users to
            // read the file.
            log.LogWarning(ex, "Could not restrict ACL on {Path}; falling back to default permissions.", path);
        }
    }

    // -- base64url encode/decode -------------------------------------

    private static string Base64Url(byte[] bytes)
    {
        var s = Convert.ToBase64String(bytes);
        return s.Replace('+', '-').Replace('/', '_').TrimEnd('=');
    }

    private static byte[] FromBase64Url(string s)
    {
        var padded = s.Replace('-', '+').Replace('_', '/');
        switch (padded.Length % 4)
        {
            case 2: padded += "=="; break;
            case 3: padded += "="; break;
            case 0: break;
            default: throw new FormatException("Invalid base64url length.");
        }
        return Convert.FromBase64String(padded);
    }
}
