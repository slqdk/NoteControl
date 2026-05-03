namespace NoteControl.Shared.Templates;

/// <summary>
/// One template surfaced to the client. The <see cref="Name"/> is the
/// filename minus <c>.md</c> — that's also the slug the slash menu
/// uses to filter, and the on-disk identity. Renaming a template is
/// done by saving with a new name + deleting the old (the server
/// doesn't expose a separate rename endpoint to keep the surface
/// small).
/// </summary>
public sealed record TemplateSummaryDto(
    string Name,
    DateTimeOffset LastModified);

/// <summary>
/// Full template content. Body is the markdown that will be inserted
/// at the cursor when the user picks this template from the slash
/// menu. Inserted verbatim — no placeholder substitution per spec.
/// </summary>
public sealed record TemplateDto(
    string Name,
    string Body,
    DateTimeOffset LastModified);

/// <summary>
/// Body for <c>POST /templates</c> and <c>PUT /templates/{name}</c>.
/// </summary>
public sealed record TemplateUpsertRequest(
    string Name,
    string Body);
