using System.Security.Cryptography;
using System.Text;
using Konscious.Security.Cryptography;

namespace NoteControl.Server.Auth.Services;

/// <summary>
/// Argon2id password hasher. Produces and consumes hashes in the standard
/// PHC string format:
///
///     $argon2id$v=19$m=&lt;mem&gt;,t=&lt;iter&gt;,p=&lt;par&gt;$&lt;salt&gt;$&lt;hash&gt;
///
/// where salt and hash are unpadded base64. This format embeds every parameter
/// needed to re-verify, so changing default parameters in the future does
/// not invalidate existing hashes.
/// </summary>
public sealed class Argon2idPasswordHasher : IPasswordHasher
{
    // Parameters chosen to take ~150-300ms on modern desktop hardware.
    // Tune by measuring on the production box; OWASP minimums (m=19456 KB,
    // t=2, p=1) are a floor, not a target.
    private const int DefaultMemoryKb = 65536;   // 64 MB
    private const int DefaultIterations = 3;
    private const int DefaultParallelism = 2;
    private const int SaltLengthBytes = 16;
    private const int HashLengthBytes = 32;

    public string Hash(string password)
    {
        ArgumentNullException.ThrowIfNull(password);

        var salt = RandomNumberGenerator.GetBytes(SaltLengthBytes);
        var hash = ComputeHash(password, salt, DefaultMemoryKb, DefaultIterations, DefaultParallelism);

        return Encode(DefaultMemoryKb, DefaultIterations, DefaultParallelism, salt, hash);
    }

    public bool Verify(string password, string encodedHash)
    {
        if (string.IsNullOrEmpty(password)) return false;
        if (string.IsNullOrEmpty(encodedHash)) return false;
        if (password is null || string.IsNullOrEmpty(encodedHash))
        {
            return false;
        }

        if (!TryDecode(encodedHash, out var memoryKb, out var iterations, out var parallelism,
                out var salt, out var expected))
        {
            return false;
        }

        var actual = ComputeHash(password, salt, memoryKb, iterations, parallelism);

        // The hash lengths embedded in the PHC string and what we compute must
        // match; if they don't, treat as a mismatch rather than throwing.
        if (actual.Length != expected.Length)
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    public bool NeedsRehash(string encodedHash)
    {
        if (!TryDecode(encodedHash, out var memoryKb, out var iterations, out var parallelism, out _, out _))
        {
            // Anything we can't parse should be re-hashed on next successful login.
            return true;
        }

        return memoryKb < DefaultMemoryKb
            || iterations < DefaultIterations
            || parallelism < DefaultParallelism;
    }

    private static byte[] ComputeHash(string password, byte[] salt, int memoryKb, int iterations, int parallelism)
    {
        using var argon2 = new Argon2id(Encoding.UTF8.GetBytes(password))
        {
            Salt = salt,
            DegreeOfParallelism = parallelism,
            Iterations = iterations,
            MemorySize = memoryKb,
        };
        return argon2.GetBytes(HashLengthBytes);
    }

    private static string Encode(int memoryKb, int iterations, int parallelism, byte[] salt, byte[] hash)
    {
        // PHC format. Note: Base64 without padding, per the convention used
        // by reference implementations.
        var saltB64 = Convert.ToBase64String(salt).TrimEnd('=');
        var hashB64 = Convert.ToBase64String(hash).TrimEnd('=');
        return $"$argon2id$v=19$m={memoryKb},t={iterations},p={parallelism}${saltB64}${hashB64}";
    }

    private static bool TryDecode(
        string encoded,
        out int memoryKb,
        out int iterations,
        out int parallelism,
        out byte[] salt,
        out byte[] hash)
    {
        memoryKb = 0;
        iterations = 0;
        parallelism = 0;
        salt = Array.Empty<byte>();
        hash = Array.Empty<byte>();

        // Expected layout: ['', 'argon2id', 'v=19', 'm=...,t=...,p=...', salt, hash]
        var parts = encoded.Split('$');
        if (parts.Length != 6)
        {
            return false;
        }
        if (parts[1] != "argon2id")
        {
            return false;
        }
        if (parts[2] != "v=19")
        {
            return false;
        }

        foreach (var kv in parts[3].Split(','))
        {
            var pair = kv.Split('=');
            if (pair.Length != 2)
            {
                return false;
            }

            if (!int.TryParse(pair[1], out var value))
            {
                return false;
            }

            switch (pair[0])
            {
                case "m": memoryKb = value; break;
                case "t": iterations = value; break;
                case "p": parallelism = value; break;
                default: return false;
            }
        }

        if (memoryKb <= 0 || iterations <= 0 || parallelism <= 0)
        {
            return false;
        }

        try
        {
            salt = Convert.FromBase64String(PadBase64(parts[4]));
            hash = Convert.FromBase64String(PadBase64(parts[5]));
        }
        catch (FormatException)
        {
            return false;
        }

        return salt.Length > 0 && hash.Length > 0;
    }

    private static string PadBase64(string s)
    {
        var pad = (4 - (s.Length % 4)) % 4;
        return pad == 0 ? s : s + new string('=', pad);
    }
}
