using System.Collections.Concurrent;

namespace NoteControl.Server.Backups;

/// <summary>
/// Process-wide registry of "which vaults are currently locked for
/// a destructive operation (today: vault restore)." When a vault is
/// locked, the <see cref="VaultLockMiddleware"/> rejects write
/// requests against that vault with HTTP 503 + Retry-After.
/// <para>
/// Reads are deliberately NOT blocked — a user reading a note
/// during the half-second the restore takes is harmless. The risk
/// we're protecting against is a write-during-restore race where
/// an editor save lands in the moved-aside folder OR the new one
/// unpredictably (see step 18 README for the exact failure mode).
/// </para>
/// <para>
/// In-memory only. If the process crashes mid-restore the lock is
/// gone — but the vault's {name}.pre-restore-{timestamp}/ folder
/// is the durable safety net for that case anyway. Locks across
/// multiple servers aren't a concern: NoteControl is single-node.
/// </para>
/// </summary>
public interface IVaultLockService
{
    /// <summary>
    /// Acquire an exclusive lock on <paramref name="vaultId"/>.
    /// Throws <see cref="VaultLockException"/> if the vault is
    /// already locked.
    /// <para>
    /// Returns an <see cref="IDisposable"/>; disposing releases.
    /// Pattern: <c>using var _ = locks.Acquire(id); ...</c>
    /// </para>
    /// </summary>
    IDisposable Acquire(Guid vaultId, string reason);

    /// <summary>Returns true if the vault is currently locked.</summary>
    bool IsLocked(Guid vaultId, out string? reason);
}

public sealed class VaultLockException : Exception
{
    public VaultLockException(string message) : base(message) { }
}

public sealed class VaultLockService : IVaultLockService
{
    // Concurrent so the middleware (which reads on every write request)
    // doesn't contend with the restore service (which writes once
    // per restore). The reason string is informational — surfaced to
    // the client in the Retry-After response so the user knows
    // *why* their save was rejected.
    private readonly ConcurrentDictionary<Guid, string> _locks = new();

    public IDisposable Acquire(Guid vaultId, string reason)
    {
        // TryAdd: returns false if a lock already exists. We don't
        // wait — the operations that take this lock (restore) are
        // user-initiated and "already in progress" should bubble up
        // as a clear error rather than queuing.
        if (!_locks.TryAdd(vaultId, reason))
        {
            _locks.TryGetValue(vaultId, out var existing);
            throw new VaultLockException(
                $"Vault {vaultId} is already locked: {existing ?? "(unknown reason)"}.");
        }
        return new Releaser(this, vaultId);
    }

    public bool IsLocked(Guid vaultId, out string? reason)
    {
        if (_locks.TryGetValue(vaultId, out var r))
        {
            reason = r;
            return true;
        }
        reason = null;
        return false;
    }

    private void Release(Guid vaultId) => _locks.TryRemove(vaultId, out _);

    private sealed class Releaser : IDisposable
    {
        private readonly VaultLockService _owner;
        private readonly Guid _vaultId;
        private bool _released;

        public Releaser(VaultLockService owner, Guid vaultId)
        {
            _owner = owner;
            _vaultId = vaultId;
        }

        public void Dispose()
        {
            if (_released) return;
            _owner.Release(_vaultId);
            _released = true;
        }
    }
}
