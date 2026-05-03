namespace NoteControl.Server.Auth.Services;

/// <summary>
/// Hashes and verifies passwords. The hash format is opaque to callers —
/// implementations may evolve (e.g. raise argon2id parameters) without
/// changing this contract, and existing hashes continue to verify because
/// the encoded form embeds the parameters used.
/// </summary>
public interface IPasswordHasher
{
    /// <summary>
    /// Hash a plaintext password. The returned string contains the algorithm
    /// identifier, parameters, salt, and hash, all in a self-describing
    /// encoded form suitable for storing in a database.
    /// </summary>
    string Hash(string password);

    /// <summary>
    /// Verify a plaintext password against a previously stored encoded hash.
    /// Constant-time comparison; safe to call with attacker-supplied input.
    /// Returns false on any malformed hash rather than throwing.
    /// </summary>
    bool Verify(string password, string encodedHash);

    /// <summary>
    /// Returns true if the encoded hash uses parameters weaker than the
    /// current target — caller should re-hash and update storage on next
    /// successful login.
    /// </summary>
    bool NeedsRehash(string encodedHash);
}
