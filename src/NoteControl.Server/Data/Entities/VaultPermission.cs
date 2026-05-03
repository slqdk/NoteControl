namespace NoteControl.Server.Data.Entities;

/// <summary>
/// Grants a user access to a specific vault. There is exactly one row per
/// (vault, user) pair; the unique index on the table enforces that.
///
/// Updated in step 3: this previously stored a free-form VaultPath string
/// keyed only by user; it now references a row in the Vaults table by
/// foreign key, which lets the database guarantee consistency between
/// permissions and the vaults they reference.
/// </summary>
public sealed class VaultPermission
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid VaultId { get; set; }
    public Guid UserId { get; set; }

    /// <summary>"owner", "editor", or "viewer".</summary>
    public string Role { get; set; } = "viewer";

    public DateTimeOffset GrantedAt { get; set; } = DateTimeOffset.UtcNow;
    public Guid? GrantedByUserId { get; set; }
}
