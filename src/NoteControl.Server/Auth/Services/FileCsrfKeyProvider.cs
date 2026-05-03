using System.Security.Cryptography;
using Microsoft.Extensions.Options;
using NoteControl.Server.Options;

namespace NoteControl.Server.Auth.Services;

/// <summary>
/// Provides the server-side secret used to derive CSRF tokens from session
/// tokens. Persisted to a file under the data root so it survives restarts.
/// Never logged or returned over the wire.
/// </summary>
public interface ICsrfKeyProvider
{
    byte[] GetKey();
}

/// <summary>
/// File-backed CSRF key. Generates a fresh 32-byte key on first run and
/// persists it under {DataRoot}/.server/csrf.key. If the file is deleted
/// (e.g. for key rotation), all existing sessions become unable to produce
/// valid CSRF tokens — clients will get 403s and the user will need to log
/// in again. This is the desired behaviour.
/// </summary>
public sealed class FileCsrfKeyProvider : ICsrfKeyProvider
{
    private readonly Lazy<byte[]> _key;

    public FileCsrfKeyProvider(IOptions<StorageOptions> storage)
    {
        var dataRoot = storage.Value.DataRoot;
        var keyDirectory = Path.Combine(dataRoot, ".server");
        var keyFile = Path.Combine(keyDirectory, "csrf.key");

        _key = new Lazy<byte[]>(() => LoadOrCreate(keyDirectory, keyFile), isThreadSafe: true);
    }

    public byte[] GetKey() => _key.Value;

    private static byte[] LoadOrCreate(string directory, string file)
    {
        Directory.CreateDirectory(directory);

        if (File.Exists(file))
        {
            var existing = File.ReadAllBytes(file);
            if (existing.Length >= 32)
            {
                return existing;
            }
            // Corrupt or truncated — fall through and regenerate.
        }

        var fresh = RandomNumberGenerator.GetBytes(32);
        // Write atomically so a crash mid-write can't leave a half file.
        var temp = file + ".tmp";
        File.WriteAllBytes(temp, fresh);
        File.Move(temp, file, overwrite: true);

        // Best-effort: tighten ACLs on Windows so only the service account
        // can read the key. We don't fail startup if this doesn't take.
        try
        {
            if (OperatingSystem.IsWindows())
            {
                var info = new FileInfo(file);
                info.Attributes |= FileAttributes.Hidden;
            }
        }
        catch
        {
            // Non-fatal.
        }

        return fresh;
    }
}
