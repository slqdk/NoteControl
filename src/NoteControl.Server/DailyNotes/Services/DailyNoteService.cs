using System.Globalization;
using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Data;
using NoteControl.Server.Notes.Services;
using NoteControl.Server.Templates.Services;
using NoteControl.Server.Vaults.Services;
using NoteControl.Shared.DailyNotes;
using NoteControl.Shared.Notes;

namespace NoteControl.Server.DailyNotes.Services;

/// <summary>
/// Filesystem-backed daily note service. Builds today's path,
/// checks if it exists, creates if not (optionally seeded from a
/// "daily" template), and returns where the client should
/// navigate.
///
/// We layer on top of <see cref="INoteService"/> rather than
/// poking the filesystem directly so all the existing safeguards
/// (path canonicalisation, FTS index updates, etc.) come for free.
/// </summary>
public sealed class DailyNoteService : IDailyNoteService
{
    /// <summary>
    /// The conventional template name we look for when seeding a
    /// new daily note. Lowercase to match the user's likely
    /// naming convention. If absent, the note starts empty.
    /// </summary>
    private const string DailyTemplateName = "daily";

    /// <summary>
    /// Top-level folder under which daily notes live. Hard-coded
    /// for v1; could be made vault-configurable later.
    /// </summary>
    private const string DailyNotesRoot = "Daily Notes";

    private readonly ServerDbContext _db;
    private readonly INoteService _notes;
    private readonly ITemplateService _templates;
    private readonly IVaultPathResolver _vaultPaths;

    public DailyNoteService(
        ServerDbContext db,
        INoteService notes,
        ITemplateService templates,
        IVaultPathResolver vaultPaths)
    {
        _db = db;
        _notes = notes;
        _templates = templates;
        _vaultPaths = vaultPaths;
    }

    public async Task<DailyNoteResponse> OpenOrCreateTodayAsync(
        Guid vaultId,
        CancellationToken ct = default)
    {
        // Verify the vault exists. The endpoint layer also enforces
        // membership via RequireVault("editor"); this is just to
        // produce a meaningful error if something's wrong.
        var vault = await _db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Id, v.Path })
            .FirstOrDefaultAsync(ct)
            ?? throw new DailyNoteException("Vault not found.", statusCode: 404);

        // Today, on the server clock. For a self-hosted single-user
        // deploy this is fine. Multi-user across timezones would
        // want client-supplied date, but that's out of scope for v1.
        var today = DateTime.Now.Date;
        var path = BuildDailyPath(today);

        // Check if the note already exists. INoteService.GetAsync
        // returns null when not present.
        var existing = await _notes.GetAsync(vaultId, path, ct);
        if (existing != null)
        {
            return new DailyNoteResponse(
                Path: path,
                Created: false,
                AppliedTemplate: null);
        }

        // Doesn't exist — create it. First check for a "daily"
        // template; if present, seed the body from it. Templates
        // not found just means no seeding.
        string body = string.Empty;
        string? appliedTemplate = null;
        try
        {
            var tpl = await _templates.GetAsync(vaultId, DailyTemplateName, ct);
            if (tpl != null)
            {
                body = tpl.Body;
                appliedTemplate = tpl.Name;
            }
        }
        catch (TemplateException)
        {
            // Template name validation failure shouldn't happen
            // for our hard-coded "daily" name, but if it does we
            // just create an empty note.
        }

        // Create via INoteService — this handles folder marker
        // creation, index update, etc.
        var createReq = new CreateNoteRequest(Path: path, Body: body);
        try
        {
            await _notes.CreateAsync(vaultId, createReq, ct);
        }
        catch (NoteException ex)
        {
            // If creation failed because the note got created
            // between our existence check and our create call (a
            // narrow race window — unlikely in single-user use)
            // we fall through and return the existing path.
            if (ex.StatusCode != 409)
            {
                throw new DailyNoteException(
                    $"Could not create today's note: {ex.Message}",
                    statusCode: ex.StatusCode);
            }
        }

        return new DailyNoteResponse(
            Path: path,
            Created: true,
            AppliedTemplate: appliedTemplate);
    }

    /// <summary>
    /// Build the canonical path for a given date.
    /// Format: <c>Daily Notes/YYYY/MM-MonthName/YYYY-MM-DD.md</c>.
    /// Month name is in English regardless of server locale —
    /// keeps the tree predictable across machines.
    /// </summary>
    internal static string BuildDailyPath(DateTime date)
    {
        var year = date.Year.ToString(CultureInfo.InvariantCulture);
        var monthNumber = date.Month.ToString("00", CultureInfo.InvariantCulture);
        // English month names — the InvariantCulture's month names
        // are English. Using CurrentCulture would localise to e.g.
        // Danish "April"/"Apr" which would split per-machine.
        var monthName = date.ToString("MMMM", CultureInfo.InvariantCulture);
        var fileName = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        return $"{DailyNotesRoot}/{year}/{monthNumber}-{monthName}/{fileName}.md";
    }
}

/// <summary>
/// Caller-fixable errors. Status code maps to HTTP.
/// </summary>
public sealed class DailyNoteException : Exception
{
    public int StatusCode { get; }
    public DailyNoteException(string message, int statusCode = 400) : base(message)
    {
        StatusCode = statusCode;
    }
}
