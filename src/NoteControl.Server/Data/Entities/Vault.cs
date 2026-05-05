namespace NoteControl.Server.Data.Entities;

/// <summary>
/// A NoteControl vault — a folder of markdown notes with its own .notesapp/
/// subfolder for indexes and metadata. The row in this table is the system-
/// of-record for "this vault exists"; the actual files live on disk under
/// {Storage.DataRoot}/{Path}.
///
/// Permissions are stored separately in <see cref="VaultPermission"/>.
/// Owner-level access is duplicated on the vault row (OwnerId) so we can
/// list a user's owned vaults without joining permissions, but it must
/// stay in sync with a corresponding VaultPermission row of role=owner.
/// </summary>
public sealed class Vault
{
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>
    /// Path under Storage.DataRoot, using forward slashes. For personal
    /// vaults this is "users/&lt;username&gt;/&lt;name&gt;"; for shared, "shared/&lt;name&gt;".
    /// Stored canonical so equality comparisons work without normalization.
    /// </summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>
    /// Display name (the leaf folder name). Kept denormalized for cheap
    /// listing; the source of truth is the Path's last segment.
    /// </summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>"personal" or "shared".</summary>
    public string Scope { get; set; } = "personal";

    /// <summary>
    /// User who created/owns this vault. Owner has full control; matches
    /// a VaultPermission row of role=owner. Cannot be null — every vault
    /// has exactly one owner.
    /// </summary>
    public Guid OwnerId { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>
    /// Ship 91: optional emoji glyph used by the topbar vault picker.
    /// One of a fixed palette of 12 (📁 📓 🛠 🔧 💼 ✏️ 📊 🏠 🎓 🎨 🔬 📐).
    /// Stored as the literal emoji character(s) — opaque to the server,
    /// validated client-side against the palette. NULL means "use the
    /// auto-derived first-letter avatar" — every vault renders cleanly
    /// without ever being configured. The picker UI lets the owner
    /// change this; it lives globally on the vault row, so co-editors
    /// see the same icon (matches the philosophy that the icon is for
    /// the vault's identity, not per-user preference).
    /// </summary>
    public string? IconKey { get; set; }

    /// <summary>
    /// Ship 91: optional colour key (one of "blue" | "green" | "orange"
    /// | "purple" | "red" | "teal" | "amber" | "pink" — the eight-swatch
    /// palette). Stored as a key, not a hex value, so we can retune the
    /// visual palette later without rewriting saved rows. NULL means
    /// "use the auto-derived hash colour from the vault name." Same
    /// global-on-vault semantics as IconKey.
    /// </summary>
    public string? ColorKey { get; set; }
}
