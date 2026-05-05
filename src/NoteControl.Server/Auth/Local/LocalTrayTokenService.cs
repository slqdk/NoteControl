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
/// the Administrators group, the INTERACTIVE pseudo-group (covers
/// any signed-in user session), and the user the server runs as
/// can read it. On non-Windows platforms (i.e. tests on Linux CI)
/// we just write the file with default perms — the test runner is
/// the only thing that can read it anyway.
/// </para>
///
/// <para>
/// Ship 97: the INTERACTIVE grant fixes a long-standing bug where
/// the tray (running as the interactive user, un-elevated) couldn't
/// read the token file when the server runs as a Windows Service
/// (LocalSystem). Pre-Ship-97 the ACL only granted SYSTEM,
/// Administrators, and the SERVER process user. In service mode
/// the server's user IS SYSTEM, so the un-elevated tray user had
/// no rule applying to them and got UnauthorizedAccessException
/// trying to read the file -- which the tray silently swallowed,
/// falling through to the interactive login window every single
/// time. Adding INTERACTIVE narrows the grant to actively-signed-in
/// sessions on the local machine without widening to service
/// accounts of unrelated apps.
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
    /// local Administrators group, the INTERACTIVE pseudo-group
    /// (anyone signed in to a local session), and the server's
    /// own process user can read it. The default inherited "Users"
    /// group access is removed so service accounts of unrelated
    /// apps can't read the token.
    ///
    /// <para>
    /// Ship 97: added INTERACTIVE. See class-level remarks for why.
    /// Also added per-rule debug logging so a future investigation
    /// can confirm what the ACL actually grants without having to
    /// inspect the file via Get-Acl.
    /// </para>
    /// </summary>
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static void TryRestrictFileAcl(string path, ILogger log)
    {
        // Track which grants we successfully applied. We log them
        // at the end so a single line in the server log records
        // exactly what the file allows -- handy when troubleshooting
        // tray auto-login failures (see Ship 97 issue).
        var granted = new List<string>(capacity: 4);

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
            granted.Add("SYSTEM=FullControl");

            // Administrators group — full control for break-glass.
            var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            sec.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                admins,
                System.Security.AccessControl.FileSystemRights.FullControl,
                System.Security.AccessControl.AccessControlType.Allow));
            granted.Add("Administrators=FullControl");

            // Ship 97: INTERACTIVE pseudo-group. This is the
            // well-known SID S-1-5-4 -- it dynamically matches any
            // process running with an interactive logon token (i.e.
            // a real signed-in user, NOT services or scheduled
            // tasks running with their own service identity). The
            // un-elevated tray needs Read for auto-login to work
            // when the server runs as LocalSystem (different user
            // than the tray runs as). Read-only is sufficient: the
            // tray never writes this file.
            var interactive = new SecurityIdentifier(WellKnownSidType.InteractiveSid, null);
            sec.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                interactive,
                System.Security.AccessControl.FileSystemRights.Read,
                System.Security.AccessControl.AccessControlType.Allow));
            granted.Add("INTERACTIVE=Read");

            // The user the server process is running as — read.
            // (When the server runs as LocalSystem this duplicates
            // the SYSTEM rule above; when it runs as a regular
            // user via F5 in dev, this is the dev's account and
            // also overlaps with INTERACTIVE. Harmless duplicates,
            // and keeping the explicit rule means an audit reading
            // the ACL can tell at a glance who the server thinks
            // it is.)
            using var identity = WindowsIdentity.GetCurrent();
            if (identity.User is not null)
            {
                sec.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                    identity.User,
                    System.Security.AccessControl.FileSystemRights.Read,
                    System.Security.AccessControl.AccessControlType.Allow));
                granted.Add($"{identity.Name ?? identity.User.Value}=Read");
            }

            info.SetAccessControl(sec);

            // Ship 97: log the final grant set. INFO not DEBUG so
            // it shows up in normal server logs -- this is run-once
            // information at startup, not chatter.
            log.LogInformation(
                "Local tray token ACL set on {Path}: [{Grants}].",
                path, string.Join(", ", granted));
        }
        catch (Exception ex)
        {
            // ACL hardening is defence-in-depth, not the primary
            // gate (the primary gate is the loopback check on the
            // server side). Log and continue — a less-restrictive
            // ACL still works, it just allows other local users to
            // read the file.
            log.LogWarning(ex,
                "Could not restrict ACL on {Path}; falling back to default permissions. " +
                "Partial grants applied: [{Grants}].",
                path, string.Join(", ", granted));
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
