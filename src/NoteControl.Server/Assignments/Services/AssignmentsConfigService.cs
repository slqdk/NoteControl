using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Data;
using NoteControl.Server.Vaults.Services;
using NoteControl.Shared.Assignments;

namespace NoteControl.Server.Assignments.Services;

/// <summary>
/// File-backed assignments store. Path is
/// <c>{vault}/.notesapp/assignments.json</c>.
///
/// Mirrors the StartpageConfigService pattern:
///   - Per-vault, hidden under <c>.notesapp/</c>, hand-editable JSON.
///   - Atomic temp-then-rename writes so a crash mid-write can't
///     leave a torn file.
///   - Empty-file / missing-file tolerated — both return an empty
///     config (no assignments yet). Different from the startpage
///     service, we don't seed a default placeholder; an empty list
///     is a valid steady state ("user has no assignments today").
///
/// Concurrency: same single-user assumption as the startpage. The
/// client debounces saves; two near-simultaneous PUTs from two tabs
/// fall back to last-write-wins. The cost of getting that wrong is
/// losing one of two concurrent edits — acceptable for a hobby /
/// solo-dev tool.
///
/// JSON formatting: indented, camelCase. Same options
/// StartpageConfigService uses, so a sysadmin who's already had to
/// hand-edit startpage.json doesn't have to learn a second
/// convention for this file.
/// </summary>
public sealed class AssignmentsConfigService : IAssignmentsConfigService
{
    private const string ConfigSubfolder = ".notesapp";
    private const string ConfigFileName = "assignments.json";

    /// <summary>Current on-disk schema version. Bump on any breaking change.</summary>
    private const int CurrentSchemaVersion = 1;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        // Tolerate hand-edits using PascalCase / mixed case. We
        // always WRITE camelCase, but a user fixing something in a
        // text editor may not match exactly.
        PropertyNameCaseInsensitive = true,
    };

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;

    public AssignmentsConfigService(ServerDbContext db, IVaultPathResolver vaultPaths)
    {
        _db = db;
        _vaultPaths = vaultPaths;
    }

    public async Task<AssignmentsConfigDto> GetAsync(Guid vaultId, CancellationToken ct = default)
    {
        var path = await ResolveConfigPathAsync(vaultId, ct);
        if (!File.Exists(path))
        {
            // First load for a vault. Return an empty list rather
            // than seeding a placeholder assignment — an empty
            // assignments page is a meaningful steady state, and
            // a placeholder would just be noise the user has to
            // delete on every fresh vault.
            return new AssignmentsConfigDto(
                CurrentSchemaVersion,
                Array.Empty<AssignmentDto>());
        }

        string raw;
        try
        {
            raw = await File.ReadAllTextAsync(path, ct);
        }
        catch (IOException ex)
        {
            throw new AssignmentsException(
                $"Could not read assignments.json: {ex.Message}",
                statusCode: 500);
        }

        // Empty file → same as missing. Gives the user something
        // sensible after a botched hand-edit that emptied the file.
        if (string.IsNullOrWhiteSpace(raw))
        {
            return new AssignmentsConfigDto(
                CurrentSchemaVersion,
                Array.Empty<AssignmentDto>());
        }

        AssignmentsConfigDto? dto;
        try
        {
            dto = JsonSerializer.Deserialize<AssignmentsConfigDto>(raw, JsonOpts);
        }
        catch (JsonException ex)
        {
            throw new AssignmentsException(
                $"Could not parse assignments.json: {ex.Message}",
                statusCode: 500);
        }
        if (dto is null)
        {
            // Defensive: malformed-but-valid-JSON file (e.g. file
            // body is `null`). Fall back to an empty list rather
            // than 500-ing.
            return new AssignmentsConfigDto(
                CurrentSchemaVersion,
                Array.Empty<AssignmentDto>());
        }

        // Normalise: always non-null list, version always stamped to
        // the current one (clients don't have to send it right).
        var assignments = (dto.Assignments ?? Array.Empty<AssignmentDto>())
            .Select(a => new AssignmentDto(
                Id: a.Id ?? string.Empty,
                Category: a.Category ?? "short",
                Subject: a.Subject ?? string.Empty,
                Details: a.Details ?? string.Empty))
            .ToArray();

        return new AssignmentsConfigDto(CurrentSchemaVersion, assignments);
    }

    public async Task SaveAsync(Guid vaultId, AssignmentsConfigDto config, CancellationToken ct = default)
    {
        if (config is null)
        {
            throw new AssignmentsException("Config is required.");
        }

        // Normalise the payload. Null lists → empty, null strings →
        // empty. This keeps the JSON output clean (no "null" fields
        // in a hand-readable file) and means the read path doesn't
        // have to repeat the same defensive checks.
        var inbound = (config.Assignments ?? Array.Empty<AssignmentDto>())
            .Select(a => new AssignmentDto(
                Id: a.Id ?? string.Empty,
                Category: a.Category ?? "short",
                Subject: a.Subject ?? string.Empty,
                Details: a.Details ?? string.Empty))
            .ToArray();

        // Server is the authority on schema version.
        var stable = new AssignmentsConfigDto(CurrentSchemaVersion, inbound);

        var path = await ResolveConfigPathAsync(vaultId, ct);
        var dir = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(dir);

        // Atomic write — same pattern as StartpageConfigService.
        // Temp file in the same directory, then File.Move with
        // overwrite. Same-volume moves are atomic on NTFS/ReFS.
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
            // Best-effort cleanup of the temp file. Swallow secondary
            // errors so the original failure surfaces unchanged.
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
            ?? throw new AssignmentsException("Vault not found.", statusCode: 404);

        var vaultRoot = _vaultPaths.Resolve(vault.Path);
        return Path.Combine(vaultRoot, ConfigSubfolder, ConfigFileName);
    }
}
