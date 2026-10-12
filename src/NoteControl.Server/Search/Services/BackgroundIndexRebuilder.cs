namespace NoteControl.Server.Search.Services;

/// <summary>
/// Fire-and-forget index rebuilds that outlive the HTTP request that
/// asked for them (vault register, sample-data install, restore).
/// <para>
/// Why this exists: those call sites used to capture the request's
/// scoped <see cref="IIndexService"/> inside <c>Task.Run</c>. The
/// IndexService holds the request's <c>ServerDbContext</c>, which is
/// disposed when the response completes (or is still in use by the
/// endpoint's own audit write) — so the rebuild died with
/// <c>ObjectDisposedException</c> / "a second operation was started on
/// this context" and the vault stayed unindexed while the status read
/// "idle, 0 notes, no error".
/// </para>
/// <para>
/// Now each rebuild runs in its own DI scope. The vault is marked
/// "indexing" immediately (so a status poll right after the response
/// sees it), and any failure — including one before
/// <see cref="IIndexService.RebuildAsync"/> gets far enough to record
/// it — lands in <see cref="IIndexBuildState"/> where the search UI
/// shows it.
/// </para>
/// </summary>
public interface IBackgroundIndexRebuilder
{
    /// <summary>
    /// Start a rebuild of <paramref name="vaultId"/> in the background.
    /// Returns the background task (callers normally discard it; tests
    /// await it). The task never faults — failures are logged and
    /// recorded in the build state.
    /// </summary>
    Task Queue(Guid vaultId, string reason);
}

public sealed class BackgroundIndexRebuilder : IBackgroundIndexRebuilder
{
    private readonly IServiceScopeFactory _scopes;
    private readonly IIndexBuildState _state;
    private readonly ILogger<BackgroundIndexRebuilder> _log;

    public BackgroundIndexRebuilder(
        IServiceScopeFactory scopes,
        IIndexBuildState state,
        ILogger<BackgroundIndexRebuilder> log)
    {
        _scopes = scopes;
        _state = state;
        _log = log;
    }

    public Task Queue(Guid vaultId, string reason)
    {
        _state.MarkBuilding(vaultId);
        return Task.Run(async () =>
        {
            try
            {
                await using var scope = _scopes.CreateAsyncScope();
                var index = scope.ServiceProvider.GetRequiredService<IIndexService>();
                var count = await index.RebuildAsync(vaultId, CancellationToken.None);
                _log.LogInformation(
                    "Background index rebuild ({Reason}) for {VaultId} indexed {Count} notes.",
                    reason, vaultId, count);
            }
            catch (Exception ex)
            {
                _state.MarkError(vaultId, ex.Message);
                _log.LogWarning(ex,
                    "Background index rebuild ({Reason}) failed for {VaultId}.",
                    reason, vaultId);
            }
        });
    }
}
