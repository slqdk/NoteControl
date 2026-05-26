using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using NoteControl.Server.Options;

namespace NoteControl.Server.Configuration;

/// <summary>
/// Persists server configuration to <c>{DataRoot}/.server/config.json</c>
/// — the file that travels with the data folder. The portability
/// promise is built around this: copy the data folder to a new
/// machine and the new server picks up its config from inside.
/// <para>
/// The store is intentionally low-level: it reads and writes the
/// JSON file directly. The options binding pipeline in Program.cs
/// uses the same file via a regular AddJsonFile registration with
/// reloadOnChange=true. After we save here, Microsoft.Extensions.
/// Configuration's file-watcher fires and the IOptionsMonitor&lt;T&gt;
/// consumers see the new values within ~1s.
/// </para>
/// </summary>
public interface IServerConfigStore
{
    /// <summary>Absolute path to the config.json on disk.</summary>
    string ConfigFilePath { get; }

    /// <summary>
    /// Read the file as a JsonNode. Returns an empty object if the
    /// file doesn't exist or is malformed (caller decides what to
    /// do — usually return defaults from IOptions).
    /// </summary>
    Task<JsonObject> ReadAsync(CancellationToken ct = default);

    /// <summary>
    /// Replace the section under <paramref name="sectionName"/>
    /// with <paramref name="value"/> and persist. Other sections
    /// are preserved verbatim. Atomic via temp-file + rename.
    /// </summary>
    Task UpdateSectionAsync(
        string sectionName,
        JsonNode value,
        CancellationToken ct = default);

    /// <summary>
    /// Replace multiple sections in one transaction. Useful for
    /// the Settings window's "Save" which posts the whole config
    /// at once.
    /// </summary>
    Task UpdateSectionsAsync(
        IReadOnlyDictionary<string, JsonNode> sections,
        CancellationToken ct = default);
}

public sealed class ServerConfigStore : IServerConfigStore
{
    private const string AppFolder = ".server";
    private const string ConfigFileName = "config.json";

    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        WriteIndented = true,
    };

    // Serialise concurrent writes within a single process. Different
    // processes editing the same file would still race, but the only
    // writer is the admin endpoint inside the server process so this
    // is sufficient.
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    public string ConfigFilePath { get; }

    public ServerConfigStore(IOptions<StorageOptions> storage)
    {
        var dataRoot = storage.Value.DataRoot;
        if (string.IsNullOrWhiteSpace(dataRoot))
        {
            throw new InvalidOperationException(
                "Storage:DataRoot is not configured; cannot resolve config.json path.");
        }

        ConfigFilePath = Path.Combine(dataRoot, AppFolder, ConfigFileName);
    }

    public async Task<JsonObject> ReadAsync(CancellationToken ct = default)
    {
        if (!File.Exists(ConfigFilePath))
        {
            return new JsonObject();
        }

        try
        {
            await using var stream = File.OpenRead(ConfigFilePath);
            var node = await JsonNode.ParseAsync(stream, cancellationToken: ct);
            return node as JsonObject ?? new JsonObject();
        }
        catch (JsonException)
        {
            // Malformed file — return empty so the consumer falls
            // back to appsettings.json defaults. The admin can fix
            // it via the Settings window save (which atomic-writes
            // a known-good shape).
            return new JsonObject();
        }
    }

    public async Task UpdateSectionAsync(
        string sectionName,
        JsonNode value,
        CancellationToken ct = default)
    {
        await UpdateSectionsAsync(
            new Dictionary<string, JsonNode> { [sectionName] = value },
            ct);
    }

    public async Task UpdateSectionsAsync(
        IReadOnlyDictionary<string, JsonNode> sections,
        CancellationToken ct = default)
    {
        await _writeLock.WaitAsync(ct);
        try
        {
            // Read current state, mutate, write atomically.
            var root = await ReadAsync(ct);

            foreach (var (name, value) in sections)
            {
                // Overwrite the whole section — partial merging
                // would surprise the user (e.g. clearing a field in
                // the UI but having the old value linger on disk).
                // Reassigning a JsonNode that already has a parent
                // throws, so deep-clone first.
                root[name] = value.DeepClone();
            }

            // Make sure the .server folder exists. On a fresh data
            // root this is the first time anything writes there.
            var dir = Path.GetDirectoryName(ConfigFilePath)!;
            Directory.CreateDirectory(dir);

            // Temp-file + rename so a partially-written file can
            // never be observed by the file-watching config layer.
            var tempPath = ConfigFilePath + ".tmp";
            await using (var fs = File.Create(tempPath))
            {
                await JsonSerializer.SerializeAsync(fs, root, WriteOptions, ct);
            }

            // File.Move with overwrite=true is atomic on the same
            // volume. Cross-volume is not a concern: ConfigFilePath
            // and tempPath share a parent directory.
            File.Move(tempPath, ConfigFilePath, overwrite: true);
        }
        finally
        {
            _writeLock.Release();
        }
    }
}
