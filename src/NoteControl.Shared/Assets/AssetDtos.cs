namespace NoteControl.Shared.Assets;

/// <summary>
/// Response body for <c>POST /api/vaults/{id}/note/asset</c>.
///
/// The frontend uses <see cref="RelativeMarkdownPath"/> as the
/// `src` in the inserted markdown / HTML element. Markdown stays
/// portable because the path is relative to the note file, not
/// absolute under the vault. e.g. <c>MyNote.assets/photo.png</c>.
///
/// <see cref="ServeUrl"/> is what the editor actually fetches at
/// runtime — a server-route that streams the bytes back through
/// the auth-scoped API. Two URLs because they have different
/// jobs: the markdown stores the relative one (portable), the
/// editor renders via the absolute one (auth-correct).
/// </summary>
/// <param name="RelativeMarkdownPath">
/// Path from the note file's location, e.g. <c>MyNote.assets/photo.png</c>.
/// Goes into the markdown source.
/// </param>
/// <param name="ServeUrl">
/// Authenticated URL the browser uses to render the asset, e.g.
/// <c>/api/vaults/{guid}/asset?path=Folder/MyNote.assets/photo.png</c>.
/// </param>
/// <param name="OriginalFileName">Filename as the user pasted/dropped it.</param>
/// <param name="StoredFileName">
/// Final filename on disk after collision-suffix logic, e.g.
/// <c>screenshot-2.png</c>.
/// </param>
/// <param name="SizeBytes">Stored size on disk.</param>
/// <param name="ContentType">Server-detected (or accepted) MIME type.</param>
public sealed record AssetUploadResponse(
    string RelativeMarkdownPath,
    string ServeUrl,
    string OriginalFileName,
    string StoredFileName,
    long SizeBytes,
    string ContentType);
