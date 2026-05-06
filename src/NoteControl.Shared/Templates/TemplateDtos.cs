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

/// <summary>
/// Body for <c>POST /templates/from-selection</c> (Ship 98b).
///
/// The user selected some content in <see cref="SourceNotePath"/>
/// and clicked "Save as template" in the bubble menu; the client
/// serialised the selection to markdown and posts it here.
///
/// The server picks an auto-name (<c>Template YYYY-MM-DD HHmm</c>,
/// suffixed if it collides) — the user renames after the fact in
/// the templates page if they want.
///
/// SourceNotePath is required because the markdown may contain
/// image refs like <c>SomeNote.assets/foo.png</c> which are
/// relative to that note's location; the server resolves and
/// copies each image into the new template's asset folder so
/// the template stays self-contained even if the source note is
/// later deleted.
/// </summary>
public sealed record TemplateFromSelectionRequest(
    string SourceNotePath,
    string Markdown);

/// <summary>
/// Response from <c>POST /templates/{name}/render</c> (Ship 98c).
///
/// The server renders a template for insertion into a specific
/// target note: it copies any images the template references from
/// <c>.notesapp/templates/&lt;name&gt;.assets/</c> into the target
/// note's <c>&lt;targetBasename&gt;.assets/</c> folder, and rewrites
/// the markdown image paths so the target note ends up self-
/// contained. The client inserts the returned <see cref="Body"/>
/// at the cursor.
///
/// Image duplication is intentional — per the Ship 98 design
/// (templates Option B), a target note carrying its own copies
/// of any template images means deleting/renaming the template
/// later doesn't break the inserted content.
/// </summary>
public sealed record TemplateRenderResponse(
    string Body);
