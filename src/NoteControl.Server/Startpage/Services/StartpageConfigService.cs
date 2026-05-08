using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Data;
using NoteControl.Server.Vaults.Services;
using NoteControl.Shared.Startpage;

namespace NoteControl.Server.Startpage.Services;

/// <summary>
/// File-backed startpage config store. Path is
/// <c>{vault}/.notesapp/startpage.json</c>. Mirrors the templates
/// pattern: per-vault, hidden under .notesapp, hand-editable JSON.
///
/// Multi-dashboard schema (v2): the file holds a list of named
/// dashboards. Each dashboard owns its own free-floating canvas
/// of blocks (RSS feeds, task areas, link blocks). The legacy
/// pre-dashboards shape (v1, implicit — no version field, blocks
/// at the root) is read-tolerated: on first load we lift the root
/// blocks/taskAreas/links into one dashboard named "Dashboard"
/// and return that. We do NOT auto-write the upgraded shape; the
/// next user save flushes v2 to disk and the v1 shape disappears.
/// (Auto-write on read would be silently destructive on a
/// read-only mount or a permission glitch.)
///
/// Concurrency model: writes use a temp-then-rename ("atomic
/// replace") so a crash mid-write can't leave a half-written file.
/// We don't lock against concurrent writers — it's a single-user
/// product and the client debounces saves; a near-simultaneous
/// PUT from two tabs would just last-write-wins. Acceptable.
///
/// Empty-vault behaviour: if the file doesn't exist yet, we
/// return one default dashboard with a deterministic id derived
/// from the vault id (so two reads of an empty vault don't
/// produce two different "default" ids on disk if both happen
/// to save). The id is stable across server restarts.
///
/// Why JSON not YAML: file size doesn't matter (a few KB), human
/// readability is fine either way, and we already use JSON
/// elsewhere for API DTOs. One serializer in this codebase, not
/// two.
/// </summary>
public sealed class StartpageConfigService : IStartpageConfigService
{
    private const string ConfigSubfolder = ".notesapp";
    private const string ConfigFileName = "startpage.json";

    /// <summary>Current on-disk schema version. Bump on any breaking change.</summary>
    private const int CurrentSchemaVersion = 2;

    /// <summary>
    /// JSON options: indented for human-readability when hand-
    /// editing, camelCase to match the wire format the client
    /// uses everywhere else (so an admin who edits the file
    /// sees the same property names as the API).
    /// </summary>
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        // Tolerate hand-edits that use PascalCase / mixed case. We
        // always WRITE camelCase, but a user fixing something in a
        // text editor may not match exactly; PropertyNameCaseInsensitive
        // means we accept both.
        PropertyNameCaseInsensitive = true,
    };

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;

    public StartpageConfigService(ServerDbContext db, IVaultPathResolver vaultPaths)
    {
        _db = db;
        _vaultPaths = vaultPaths;
    }

    public async Task<StartpageConfigDto> GetAsync(Guid vaultId, CancellationToken ct = default)
    {
        var path = await ResolveConfigPathAsync(vaultId, ct);
        if (!File.Exists(path))
        {
            // First load for a vault: synthesise one default
            // dashboard. The id is deterministic-from-vault so two
            // reads of an empty vault see the same id even before
            // anything was saved — keeps the client's React keys
            // stable across reloads of an empty vault.
            return new StartpageConfigDto(
                CurrentSchemaVersion,
                new[] { CreateDefaultDashboard(vaultId) });
        }

        string raw;
        try
        {
            raw = await File.ReadAllTextAsync(path, ct);
        }
        catch (IOException ex)
        {
            throw new StartpageException(
                $"Could not read startpage.json: {ex.Message}",
                statusCode: 500);
        }

        // Empty file → treat as missing. Same default-dashboard
        // path; gives the user something to land on after a
        // botched hand-edit that left the file empty.
        if (string.IsNullOrWhiteSpace(raw))
        {
            return new StartpageConfigDto(
                CurrentSchemaVersion,
                new[] { CreateDefaultDashboard(vaultId) });
        }

        // Detect schema by sniffing the parsed JsonNode. We don't
        // commit to a strongly-typed deserialise yet — a v1 file
        // would lose its data through StartpageConfigDto's shape
        // because the legacy fields aren't on the type. JsonNode
        // is the seam where we make the v1→v2 lift.
        JsonNode? root;
        try
        {
            root = JsonNode.Parse(raw);
        }
        catch (JsonException ex)
        {
            throw new StartpageException(
                $"Could not parse startpage.json: {ex.Message}",
                statusCode: 500);
        }
        if (root is not JsonObject obj)
        {
            throw new StartpageException(
                "startpage.json: expected a JSON object at the root.",
                statusCode: 500);
        }

        // Case-insensitive root-key probe. JsonOpts has
        // PropertyNameCaseInsensitive=true for the typed deserialise
        // path, but JsonObject.ContainsKey is always case-sensitive
        // — a hand-edit using "Dashboards" (Pascal) would otherwise
        // mis-route into the v1 branch and overwrite the user's
        // multi-dashboard layout. Walk the property names ourselves.
        var hasDashboards = obj.Any(kv =>
            string.Equals(kv.Key, "dashboards", StringComparison.OrdinalIgnoreCase));
        if (!hasDashboards)
        {
            // Legacy v1 shape: the file is one flat dashboard's
            // worth of blocks. Lift it into a single named
            // dashboard. Use a deterministic id (per-vault) so the
            // synthesised dashboard has a stable identity across
            // re-reads — useful in case the user navigates between
            // dashboards and back before the first save lands.
            var legacy = obj.Deserialize<LegacyConfig>(JsonOpts)
                         ?? new LegacyConfig(null, null, null, null);
            var lifted = new DashboardDto(
                Id: DeterministicDashboardId(vaultId),
                Name: "Dashboard",
                Blocks: legacy.Blocks ?? Array.Empty<RssBlockDto>(),
                TaskAreas: legacy.TaskAreas ?? Array.Empty<TaskAreaDto>(),
                Links: legacy.Links ?? Array.Empty<LinkBlockDto>(),
                MotionBlocks: legacy.MotionBlocks ?? Array.Empty<MotionBlockDto>());
            return new StartpageConfigDto(
                CurrentSchemaVersion,
                new[] { lifted });
        }

        // v2 (current). Strongly-typed deserialise; tolerate null
        // arrays the same way the v1 path did so future schema
        // additions stay resilient.
        StartpageConfigDto? dto;
        try
        {
            dto = obj.Deserialize<StartpageConfigDto>(JsonOpts);
        }
        catch (JsonException ex)
        {
            throw new StartpageException(
                $"Could not parse startpage.json: {ex.Message}",
                statusCode: 500);
        }
        if (dto is null)
        {
            // Defensive: malformed-but-valid-JSON file. Fall back
            // to a single default dashboard rather than 500-ing.
            return new StartpageConfigDto(
                CurrentSchemaVersion,
                new[] { CreateDefaultDashboard(vaultId) });
        }

        // Normalise: every dashboard always has the four arrays
        // present (never null), and the dashboards list is never
        // empty — re-seed the default if a hand-edit emptied it.
        var dashboards = (dto.Dashboards ?? Array.Empty<DashboardDto>())
            .Select(d => d with
            {
                Blocks = d.Blocks ?? Array.Empty<RssBlockDto>(),
                TaskAreas = d.TaskAreas ?? Array.Empty<TaskAreaDto>(),
                Links = d.Links ?? Array.Empty<LinkBlockDto>(),
                MotionBlocks = d.MotionBlocks ?? Array.Empty<MotionBlockDto>(),
            })
            .ToArray();
        if (dashboards.Length == 0)
        {
            dashboards = new[] { CreateDefaultDashboard(vaultId) };
        }
        return new StartpageConfigDto(CurrentSchemaVersion, dashboards);
    }

    public async Task SaveAsync(Guid vaultId, StartpageConfigDto config, CancellationToken ct = default)
    {
        if (config is null)
        {
            throw new StartpageException("Config is required.");
        }

        // Defensive normalisation of the incoming payload before
        // we touch disk: refuse to write a config with zero
        // dashboards (the UI prevents this, but we don't trust the
        // wire — a future client bug could otherwise nuke the
        // user's data). Replace with a fresh default in that case;
        // last-write-wins still applies, but at least the file
        // stays usable.
        var inboundDashboards = (config.Dashboards ?? Array.Empty<DashboardDto>())
            .Select(d => new DashboardDto(
                Id: d.Id,
                Name: d.Name ?? string.Empty,
                Blocks: SortById(d.Blocks, b => b.Id),
                TaskAreas: SortById(d.TaskAreas, a => a.Id),
                Links: SortById(d.Links, l => l.Id),
                MotionBlocks: SortById(d.MotionBlocks, m => m.Id)))
            .ToArray();
        if (inboundDashboards.Length == 0)
        {
            inboundDashboards = new[] { CreateDefaultDashboard(vaultId) };
        }

        // Always stamp the current version on write — clients
        // don't need to send it correctly; the server is the
        // authority on what version the file is.
        var stable = new StartpageConfigDto(CurrentSchemaVersion, inboundDashboards);

        var path = await ResolveConfigPathAsync(vaultId, ct);
        var dir = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(dir);

        // Atomic write: serialize to a temp file in the same
        // directory, then File.Move with overwrite. Same-volume
        // moves are atomic on NTFS / ReFS, so a crash leaves
        // either the old file or the new file — never a torn
        // half-write.
        var tmpPath = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            await using (var stream = File.Create(tmpPath))
            {
                await JsonSerializer.SerializeAsync(stream, stable, JsonOpts, ct);
            }
            File.Move(tmpPath, path, overwrite: true);
        }
        catch
        {
            // Best-effort cleanup of the temp file if we got far
            // enough to create it. Swallow secondary errors here
            // so the original failure surfaces.
            try { if (File.Exists(tmpPath)) File.Delete(tmpPath); }
            catch { /* ignore */ }
            throw;
        }
    }

    private async Task<string> ResolveConfigPathAsync(Guid vaultId, CancellationToken ct)
    {
        var vault = await _db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Path })
            .FirstOrDefaultAsync(ct)
            ?? throw new StartpageException("Vault not found.", statusCode: 404);

        var vaultRoot = _vaultPaths.Resolve(vault.Path);
        return Path.Combine(vaultRoot, ConfigSubfolder, ConfigFileName);
    }

    /// <summary>
    /// Build a fresh default dashboard for an empty vault.
    /// Deterministic id-from-vault so multiple reads of an empty
    /// file (before any save) produce identical configs.
    /// </summary>
    private static DashboardDto CreateDefaultDashboard(Guid vaultId)
    {
        return new DashboardDto(
            Id: DeterministicDashboardId(vaultId),
            Name: "Dashboard",
            Blocks: Array.Empty<RssBlockDto>(),
            TaskAreas: Array.Empty<TaskAreaDto>(),
            Links: Array.Empty<LinkBlockDto>(),
            MotionBlocks: Array.Empty<MotionBlockDto>());
    }

    /// <summary>
    /// Derive a deterministic dashboard id from a vault id. Used
    /// for the synthesised default dashboard so its identity is
    /// stable across re-reads of an empty/legacy file. Format is a
    /// standard GUID string (lowercase) — same shape the client
    /// would have produced with crypto.randomUUID(), so callers
    /// don't need to special-case it.
    /// </summary>
    private static string DeterministicDashboardId(Guid vaultId)
    {
        // Just reuse the vault GUID's bytes as the dashboard GUID.
        // Cheap, stable, no extra hash dependency.
        return vaultId.ToString("D");
    }

    /// <summary>
    /// Sort blocks/areas/links by id for stable on-disk output.
    /// Items WITHIN each area/block are NOT sorted by their
    /// container — their order is user-meaningful (drag-to-reorder).
    /// </summary>
    private static T[] SortById<T>(IReadOnlyList<T>? items, Func<T, string> idOf)
    {
        if (items is null || items.Count == 0) return Array.Empty<T>();
        return items.OrderBy(idOf, StringComparer.Ordinal).ToArray();
    }

    /// <summary>
    /// Shape of a v1 (legacy) startpage.json — the pre-dashboards
    /// flat layout. Kept inside this file because nothing else
    /// reads v1: the GetAsync path lifts it to v2 immediately.
    /// MotionBlocks is added defensively — v1 files never had this
    /// field, but a future hand-edit of a v1-shaped file might.
    /// </summary>
    private sealed record LegacyConfig(
        IReadOnlyList<RssBlockDto>? Blocks,
        IReadOnlyList<TaskAreaDto>? TaskAreas,
        IReadOnlyList<LinkBlockDto>? Links,
        IReadOnlyList<MotionBlockDto>? MotionBlocks);
}
