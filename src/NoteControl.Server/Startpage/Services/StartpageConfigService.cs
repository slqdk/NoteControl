using System.Text.Json;
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
/// Concurrency model: writes use a temp-then-rename ("atomic
/// replace") so a crash mid-write can't leave a half-written file.
/// We don't lock against concurrent writers — it's a single-user
/// product and the client debounces saves; a near-simultaneous
/// PUT from two tabs would just last-write-wins. Acceptable.
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
            // First load for a vault: empty config (no blocks).
            // Client treats this as "show the empty-state with an
            // Add-block button." We don't write an empty file
            // here; the first user save creates the file.
            return new StartpageConfigDto(
                Array.Empty<RssBlockDto>(),
                Array.Empty<TaskAreaDto>(),
                Array.Empty<LinkBlockDto>());
        }

        try
        {
            await using var stream = File.OpenRead(path);
            var dto = await JsonSerializer.DeserializeAsync<StartpageConfigDto>(
                stream, JsonOpts, ct);
            // Defensive: if the file exists but is empty / malformed,
            // present an empty config rather than 500-ing. The user
            // can then re-save and the next load will work.
            if (dto is null)
            {
                return new StartpageConfigDto(
                    Array.Empty<RssBlockDto>(),
                    Array.Empty<TaskAreaDto>(),
                    Array.Empty<LinkBlockDto>());
            }
            // Step 42 + Ship 74 back-compat: a step-40 file has no
            // "taskAreas" field; a pre-Ship-74 file has no "links"
            // field. System.Text.Json fills missing reference-typed
            // record positional params with null, even though the
            // type annotation is non-nullable. Normalise null → empty
            // so callers never have to think about it. Same thing for
            // Blocks defensively, in case some future schema change
            // ever omits it.
            return dto with
            {
                Blocks = dto.Blocks ?? Array.Empty<RssBlockDto>(),
                TaskAreas = dto.TaskAreas ?? Array.Empty<TaskAreaDto>(),
                Links = dto.Links ?? Array.Empty<LinkBlockDto>(),
            };
        }
        catch (JsonException ex)
        {
            throw new StartpageException(
                $"Could not parse startpage.json: {ex.Message}",
                statusCode: 500);
        }
    }

    public async Task SaveAsync(Guid vaultId, StartpageConfigDto config, CancellationToken ct = default)
    {
        if (config is null)
        {
            throw new StartpageException("Config is required.");
        }

        var path = await ResolveConfigPathAsync(vaultId, ct);
        var dir = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(dir);

        // Sort blocks by id for stable on-disk output. The client
        // doesn't care about order (each block has its own absolute
        // x,y) but stable JSON makes git diffs / hand-edits sane.
        // TaskAreas + Links are also sorted by id for the same
        // reason; the items WITHIN each area/block are NOT sorted
        // because their order is user-meaningful (drag-to-reorder
        // semantics).
        var sortedBlocks = (config.Blocks ?? Array.Empty<RssBlockDto>())
            .OrderBy(b => b.Id, StringComparer.Ordinal)
            .ToArray();
        var sortedAreas = (config.TaskAreas ?? Array.Empty<TaskAreaDto>())
            .OrderBy(a => a.Id, StringComparer.Ordinal)
            .ToArray();
        var sortedLinks = (config.Links ?? Array.Empty<LinkBlockDto>())
            .OrderBy(l => l.Id, StringComparer.Ordinal)
            .ToArray();
        var stable = new StartpageConfigDto(sortedBlocks, sortedAreas, sortedLinks);

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
}
