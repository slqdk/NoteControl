using System.Collections.Concurrent;
using NoteControl.Shared.Search;

namespace NoteControl.Server.Search.Services;

/// <summary>
/// Tracks per-vault index build status for the UI.
/// Singleton — survives across requests so a long-running rebuild can be
/// observed by the next caller.
/// <para>
/// We deliberately don't persist this anywhere. After a server restart
/// the state resets to "idle"; if the index is up to date that's correct,
/// and if it isn't the next call to <see cref="IIndexService.RebuildAsync"/>
/// will repopulate it.
/// </para>
/// </summary>
public interface IIndexBuildState
{
    /// <summary>Has a rebuild started but not yet finished/errored?</summary>
    bool IsBuilding(Guid vaultId);

    /// <summary>
    /// Read the current snapshot. <paramref name="indexedNotes"/> is
    /// supplied by the caller because only IndexService knows the live
    /// row count.
    /// </summary>
    IndexStatusDto Snapshot(Guid vaultId, int indexedNotes);

    void MarkBuilding(Guid vaultId);
    void MarkBuilt(Guid vaultId, int indexedNotes);
    void MarkError(Guid vaultId, string message);
}

public sealed class IndexBuildState : IIndexBuildState
{
    // Thread-safe; reads/writes are uncontested in the common case.
    private readonly ConcurrentDictionary<Guid, Entry> _byVault = new();

    public bool IsBuilding(Guid vaultId) =>
        _byVault.TryGetValue(vaultId, out var e) && e.State == "indexing";

    public IndexStatusDto Snapshot(Guid vaultId, int indexedNotes)
    {
        if (_byVault.TryGetValue(vaultId, out var e))
        {
            // Use the recorded note count from the last successful build
            // when state is idle/error; show the live count from the DB
            // while indexing so the UI can watch the number tick up if
            // we ever stream progress.
            return new IndexStatusDto(e.State, indexedNotes, e.LastBuildAt, e.LastError);
        }
        return new IndexStatusDto("idle", indexedNotes, null, null);
    }

    public void MarkBuilding(Guid vaultId)
    {
        _byVault[vaultId] = new Entry("indexing", null, null);
    }

    public void MarkBuilt(Guid vaultId, int indexedNotes)
    {
        _byVault[vaultId] = new Entry("idle", DateTimeOffset.UtcNow, null);
    }

    public void MarkError(Guid vaultId, string message)
    {
        _byVault[vaultId] = new Entry("error", DateTimeOffset.UtcNow, message);
    }

    private sealed record Entry(string State, DateTimeOffset? LastBuildAt, string? LastError);
}
