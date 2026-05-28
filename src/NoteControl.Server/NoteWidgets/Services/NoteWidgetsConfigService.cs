using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Data;
using NoteControl.Server.Vaults.Services;
using NoteControl.Shared.NoteWidgets;

namespace NoteControl.Server.NoteWidgets.Services;

/// <summary>
/// File-backed note-widgets store. Path is
/// <c>{vault}/.notesapp/note-widgets.json</c>.
///
/// Mirrors AssignmentsConfigService / StartpageConfigService:
///   - Per-vault, hidden under <c>.notesapp/</c>, hand-editable JSON.
///   - Atomic temp-then-rename writes so a crash mid-write can't
///     leave a torn file.
///   - Missing / empty file tolerated — both return an empty map
///     (no note has widgets yet). No default seeding; an empty map
///     is a valid steady state.
///
/// Normalisation: on both read and write, notes whose widget list is
/// null or empty are dropped from the map entirely, so the file never
/// accumulates empty arrays for notes that briefly had a widget and
/// then lost it. The server stamps the schema version on write.
///
/// Concurrency: same single-user assumption as the siblings. The
/// client debounces saves; two near-simultaneous PUTs fall back to
/// last-write-wins.
/// </summary>
public sealed class NoteWidgetsConfigService : INoteWidgetsConfigService
{
    private const string ConfigSubfolder = ".notesapp";
    private const string ConfigFileName = "note-widgets.json";

    /// <summary>Current on-disk schema version. Bump on any breaking change.</summary>
    private const int CurrentSchemaVersion = 1;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        // Tolerate hand-edits using PascalCase / mixed case. We always
        // WRITE camelCase, but a user fixing the file by hand may not
        // match exactly.
        PropertyNameCaseInsensitive = true,
    };

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;

    public NoteWidgetsConfigService(ServerDbContext db, IVaultPathResolver vaultPaths)
    {
        _db = db;
        _vaultPaths = vaultPaths;
    }

    public async Task<NoteWidgetsConfigDto> GetAsync(Guid vaultId, CancellationToken ct = default)
    {
        var path = await ResolveConfigPathAsync(vaultId, ct);
        if (!File.Exists(path))
        {
            return Empty();
        }

        string raw;
        try
        {
            raw = await File.ReadAllTextAsync(path, ct);
        }
        catch (IOException ex)
        {
            throw new NoteWidgetsException(
                $"Could not read note-widgets.json: {ex.Message}",
                statusCode: 500);
        }

        // Empty file → same as missing. Recovers gracefully from a
        // botched hand-edit that emptied the file.
        if (string.IsNullOrWhiteSpace(raw))
        {
            return Empty();
        }

        NoteWidgetsConfigDto? dto;
        try
        {
            dto = JsonSerializer.Deserialize<NoteWidgetsConfigDto>(raw, JsonOpts);
        }
        catch (JsonException ex)
        {
            throw new NoteWidgetsException(
                $"Could not parse note-widgets.json: {ex.Message}",
                statusCode: 500);
        }
        if (dto is null)
        {
            // Defensive: valid JSON whose body is literally `null`.
            return Empty();
        }

        return new NoteWidgetsConfigDto(CurrentSchemaVersion, Normalise(dto.ByNote));
    }

    public async Task SaveAsync(Guid vaultId, NoteWidgetsConfigDto config, CancellationToken ct = default)
    {
        if (config is null)
        {
            throw new NoteWidgetsException("Config is required.");
        }

        var stable = new NoteWidgetsConfigDto(CurrentSchemaVersion, Normalise(config.ByNote));

        var path = await ResolveConfigPathAsync(vaultId, ct);
        var dir = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(dir);

        // Atomic write — temp file in the same directory, then
        // File.Move with overwrite. Same-volume moves are atomic on
        // NTFS/ReFS. Identical pattern to AssignmentsConfigService.
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
            try { if (File.Exists(tmpPath)) File.Delete(tmpPath); }
            catch { /* best-effort cleanup; let the original error surface */ }
            throw;
        }
    }

    /// <summary>
    /// Drop null/empty widget lists and null widget entries, and make
    /// every list a concrete array. Keeps the on-disk file clean (no
    /// empty arrays, no null holes) and means the read path doesn't
    /// have to repeat these checks.
    /// </summary>
    private static IReadOnlyDictionary<string, IReadOnlyList<NoteWidgetDto>> Normalise(
        IReadOnlyDictionary<string, IReadOnlyList<NoteWidgetDto>>? byNote)
    {
        var result = new Dictionary<string, IReadOnlyList<NoteWidgetDto>>();
        if (byNote is null)
        {
            return result;
        }

        foreach (var (notePath, widgets) in byNote)
        {
            if (string.IsNullOrWhiteSpace(notePath) || widgets is null)
            {
                continue;
            }

            var cleaned = widgets
                .Where(w => w is not null && !string.IsNullOrWhiteSpace(w.Id) && !string.IsNullOrWhiteSpace(w.Kind))
                .ToArray();

            if (cleaned.Length == 0)
            {
                // A note with no widgets isn't stored at all.
                continue;
            }

            result[notePath] = cleaned;
        }

        return result;
    }

    private static NoteWidgetsConfigDto Empty() =>
        new(CurrentSchemaVersion, new Dictionary<string, IReadOnlyList<NoteWidgetDto>>());

    private async Task<string> ResolveConfigPathAsync(Guid vaultId, CancellationToken ct)
    {
        var vault = await _db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Path })
            .FirstOrDefaultAsync(ct)
            ?? throw new NoteWidgetsException("Vault not found.", statusCode: 404);

        var vaultRoot = _vaultPaths.Resolve(vault.Path);
        return Path.Combine(vaultRoot, ConfigSubfolder, ConfigFileName);
    }
}
