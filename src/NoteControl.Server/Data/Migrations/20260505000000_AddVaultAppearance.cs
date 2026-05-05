using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace NoteControl.Server.Data.Migrations;

/// <summary>
/// Ship 91: per-vault appearance — IconKey (emoji glyph from the fixed
/// 12-emoji palette) and ColorKey (one of 8 named swatches). Both NULL
/// means "use the auto-derived first-letter avatar with hashed colour"
/// — that's the fallback all existing vault rows will use until the
/// owner picks something via the new appearance picker UI.
///
/// Both columns are nullable strings with no length cap — emojis can
/// be multi-codepoint (skin-tone modifiers etc), and the colour key
/// is a short word ("teal", "blue"…). 32 chars is generous.
///
/// We rely on the EF model snapshot being kept in sync; the project's
/// startup runs Database.Migrate() which applies pending migrations
/// at boot. No manual SQL needed on existing installs.
/// </summary>
[DbContext(typeof(ServerDbContext))]
[Migration("20260505000000_AddVaultAppearance")]
public partial class AddVaultAppearance : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "IconKey",
            table: "Vaults",
            type: "TEXT",
            maxLength: 32,
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "ColorKey",
            table: "Vaults",
            type: "TEXT",
            maxLength: 32,
            nullable: true);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(name: "IconKey", table: "Vaults");
        migrationBuilder.DropColumn(name: "ColorKey", table: "Vaults");
    }
}
