using NoteControl.Shared.NoteWidgets;

namespace NoteControl.Server.NoteWidgets.Services;

/// <summary>
/// Reads and writes the per-vault note-widgets configuration file.
/// Pure file I/O — no database beyond resolving the vault path, no
/// caching. Path is <c>{vault}/.notesapp/note-widgets.json</c>.
///
/// Mirrors <see cref="NoteControl.Server.Assignments.Services.IAssignmentsConfigService"/>'s
/// shape: a single per-vault JSON sidecar, GET reads it, PUT replaces
/// it wholesale. The difference is the payload — a map of note path →
/// widget list rather than a flat list — but the load/save/atomic-write
/// machinery is the same.
///
/// Kept separate from the startpage and assignments services even
/// though all three share the <c>.notesapp/</c> directory: the three
/// files are independent and shouldn't share a save loop, and keeping
/// the catch blocks in distinct endpoints means one feature's parse
/// error can't masquerade as another's.
/// </summary>
public interface INoteWidgetsConfigService
{
    Task<NoteWidgetsConfigDto> GetAsync(Guid vaultId, CancellationToken ct = default);
    Task SaveAsync(Guid vaultId, NoteWidgetsConfigDto config, CancellationToken ct = default);
}

/// <summary>
/// Caller-fixable note-widgets errors. Status code maps to HTTP.
/// Same shape as <see cref="NoteControl.Server.Assignments.Services.AssignmentsException"/>;
/// its own type so the endpoint catch blocks stay isolated per feature.
/// </summary>
public sealed class NoteWidgetsException : Exception
{
    public int StatusCode { get; }
    public NoteWidgetsException(string message, int statusCode = 400) : base(message)
    {
        StatusCode = statusCode;
    }
}
