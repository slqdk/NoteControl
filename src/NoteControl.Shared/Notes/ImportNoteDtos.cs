namespace NoteControl.Shared.Notes;

/// <summary>
/// One entry produced (or attempted) by an import operation.
/// <para>
/// The frontend uses this to show a per-file result list — what was
/// created, what got renamed because of a conflict, what failed.
/// </para>
/// <list type="bullet">
///   <item><see cref="Outcome"/> = "created" — the file was written
///     at <see cref="FinalPath"/>.</item>
///   <item><see cref="Outcome"/> = "renamed" — the requested path was
///     taken, so the file landed at <see cref="FinalPath"/> with a
///     numeric suffix (e.g. "Foo (2).md"). <see cref="RequestedPath"/>
///     holds the original path the import asked for.</item>
///   <item><see cref="Outcome"/> = "skipped" — non-`.md` non-asset
///     entry inside a zip that we don't know how to handle (kept in
///     the result list so the user can see exactly what was ignored
///     rather than guessing).</item>
///   <item><see cref="Outcome"/> = "failed" — write attempt threw.
///     <see cref="ErrorMessage"/> carries a short reason. Other
///     entries in the same import still proceed.</item>
/// </list>
/// </summary>
public sealed record ImportNoteEntry(
    string RequestedPath,
    string FinalPath,
    string Outcome,
    string? ErrorMessage);

/// <summary>
/// Result of POST /api/vaults/{id}/import.
/// <para>
/// The endpoint always returns 200 with this body unless the request
/// itself was malformed (missing file, bad target folder, etc.).
/// Per-entry failures are reflected in <see cref="Entries"/> rather
/// than failing the whole batch — partial success is the realistic
/// outcome when importing a folder of dozens of notes.
/// </para>
/// </summary>
public sealed record ImportNoteResult(
    int Created,
    int Renamed,
    int Skipped,
    int Failed,
    IReadOnlyList<ImportNoteEntry> Entries);
