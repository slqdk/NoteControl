using NoteControl.Shared.Startpage;

namespace NoteControl.Server.Startpage.Services;

/// <summary>
/// Reads and writes the per-vault startpage configuration file.
/// Pure file I/O — no database, no caching here. The config is
/// small (a few KB even with 16 blocks), JSON-serialized so users
/// can hand-edit if anything goes pear-shaped.
/// </summary>
public interface IStartpageConfigService
{
    Task<StartpageConfigDto> GetAsync(Guid vaultId, CancellationToken ct = default);
    Task SaveAsync(Guid vaultId, StartpageConfigDto config, CancellationToken ct = default);
}

/// <summary>
/// Fetches and parses an RSS or Atom feed. Caches results in
/// memory for a short TTL so rapid successive requests for the
/// same URL don't hammer upstream feeds.
/// </summary>
public interface IFeedFetcher
{
    Task<FeedDto> FetchAsync(string url, CancellationToken ct = default);
}

/// <summary>
/// Caller-fixable startpage errors. Status code maps to HTTP.
/// </summary>
public sealed class StartpageException : Exception
{
    public int StatusCode { get; }
    public StartpageException(string message, int statusCode = 400) : base(message)
    {
        StatusCode = statusCode;
    }
}
