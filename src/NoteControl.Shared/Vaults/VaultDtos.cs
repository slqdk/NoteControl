namespace NoteControl.Shared.Vaults;

/// <summary>
/// Public projection of a vault for list / detail responses.
/// </summary>
public sealed record VaultDto(
    Guid Id,
    string Path,
    string Name,
    string Scope,        // "personal" | "shared"
    Guid OwnerId,
    string OwnerUsername,
    string MyRole,       // "owner" | "editor" | "viewer"
    DateTimeOffset CreatedAt);

/// <summary>
/// POST /api/vaults — create a new vault. The Path must start with
/// "users/&lt;username&gt;/" or "shared/" and the rest must be a valid folder
/// name segment. The server creates the on-disk folder, the .notesapp/
/// subfolder, and the owner permission row in one transaction.
///
/// <para>
/// <see cref="OwnerUserId"/>: optional. When null or equal to the caller's
/// own user id, the caller becomes owner (the historical default). When
/// set to a DIFFERENT user's id, the caller must be an admin; the named
/// user becomes owner instead. This supports the admin "create a vault
/// for another user" workflow used by the tray's Vaults window.
/// </para>
/// <para>
/// For personal-scope vaults, the path's <c>users/&lt;username&gt;/</c>
/// segment must match the chosen owner's username. The tray builds the
/// path that way when the admin picks a different owner; the server
/// re-validates.
/// </para>
/// </summary>
public sealed record CreateVaultRequest(
    string Path,
    string? Name = null,
    Guid? OwnerUserId = null);

/// <summary>
/// POST /api/vaults/register — adopt an existing on-disk folder as
/// a vault. The folder must already exist under the data root at
/// <paramref name="Path"/> (using the same forward-slash relative path
/// convention as <see cref="CreateVaultRequest"/>). The endpoint:
///
///   - validates the folder exists and matches a personal/shared scope
///   - creates <c>.notesapp/</c> if missing
///   - inserts the Vault row + owner permission row
///   - rebuilds the search index from the markdown on disk
///
/// Use this for "format Windows, copy NotesData back, register vaults"
/// and for adopting markdown folders made elsewhere (e.g. another
/// notes app or a manual download).
///
/// <see cref="OwnerUserId"/> follows the same admin-only-when-different
/// rule as Create. For personal scope the path encodes the owner's
/// username, so OwnerUserId (when provided) must match the user
/// referenced in the path's second segment.
/// </summary>
public sealed record RegisterVaultRequest(
    string Path,
    string? Name = null,
    Guid? OwnerUserId = null);

/// <summary>
/// A user who has access to a vault, returned by the share-list endpoint.
/// </summary>
public sealed record VaultMemberDto(
    Guid UserId,
    string Username,
    string Role,                       // "owner" | "editor" | "viewer"
    DateTimeOffset GrantedAt,
    Guid? GrantedByUserId);

/// <summary>
/// POST /api/vaults/{id}/permissions — share a vault with another user.
/// </summary>
public sealed record ShareVaultRequest(
    string Username,
    string Role);                      // "editor" | "viewer" — owner cannot be granted via this endpoint

/// <summary>
/// Ship 52: response from POST /api/vaults/{id}/install-sample-data.
/// Returns the counts so the tray can show "wrote N notes, created K
/// folders" in its status bar / message box. Both numbers are
/// post-install totals; on a re-install over an existing sample set
/// the FoldersCreated will typically be 0 while FilesWritten stays
/// at the full file count (we always overwrite).
/// </summary>
public sealed record InstallSampleDataResponse(int FilesWritten, int FoldersCreated);
