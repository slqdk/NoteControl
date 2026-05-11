using NoteControl.Shared.Assignments;

namespace NoteControl.Server.Assignments.Services;

/// <summary>
/// Reads and writes the per-vault assignments configuration file.
/// Pure file I/O — no database, no caching. Path is
/// <c>{vault}/.notesapp/assignments.json</c>.
///
/// Mirrors <see cref="NoteControl.Server.Startpage.Services.IStartpageConfigService"/>'s
/// shape but for a much simpler file. The two are deliberately
/// separate services even though they share the per-vault
/// `.notesapp/` directory convention — the assignments list is
/// independent of the dashboards / startpage layout and shouldn't
/// share a save loop with it.
/// </summary>
public interface IAssignmentsConfigService
{
    Task<AssignmentsConfigDto> GetAsync(Guid vaultId, CancellationToken ct = default);
    Task SaveAsync(Guid vaultId, AssignmentsConfigDto config, CancellationToken ct = default);
}

/// <summary>
/// Caller-fixable assignments errors. Status code maps to HTTP.
/// Same shape as <see cref="NoteControl.Server.Startpage.Services.StartpageException"/>;
/// kept as its own type so the StartpageEndpoints / AssignmentsEndpoints
/// catch blocks don't accidentally swallow each other's failures.
/// </summary>
public sealed class AssignmentsException : Exception
{
    public int StatusCode { get; }
    public AssignmentsException(string message, int statusCode = 400) : base(message)
    {
        StatusCode = statusCode;
    }
}
