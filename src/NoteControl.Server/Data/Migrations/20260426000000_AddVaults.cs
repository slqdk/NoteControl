using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace NoteControl.Server.Data.Migrations;

/// <inheritdoc />
[DbContext(typeof(ServerDbContext))]
[Migration("20260426000000_AddVaults")]
public partial class AddVaults : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        // -----------------------------------------------------------------
        // VaultPermissions has no rows yet (step 1 created it; nothing has
        // written to it). Drop and recreate to swap the path column for a
        // VaultId FK. If you somehow have rows in this table, back them up
        // first — they'll be lost.
        // -----------------------------------------------------------------
        migrationBuilder.DropTable(name: "VaultPermissions");

        migrationBuilder.CreateTable(
            name: "Vaults",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "TEXT", nullable: false),
                Path = table.Column<string>(type: "TEXT", maxLength: 512, nullable: false),
                Name = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                Scope = table.Column<string>(type: "TEXT", maxLength: 32, nullable: false),
                OwnerId = table.Column<Guid>(type: "TEXT", nullable: false),
                CreatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_Vaults", x => x.Id);
                table.ForeignKey(
                    name: "FK_Vaults_Users_OwnerId",
                    column: x => x.OwnerId,
                    principalTable: "Users",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Restrict);
            });

        migrationBuilder.CreateTable(
            name: "VaultPermissions",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "TEXT", nullable: false),
                VaultId = table.Column<Guid>(type: "TEXT", nullable: false),
                UserId = table.Column<Guid>(type: "TEXT", nullable: false),
                Role = table.Column<string>(type: "TEXT", maxLength: 32, nullable: false),
                GrantedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                GrantedByUserId = table.Column<Guid>(type: "TEXT", nullable: true),
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_VaultPermissions", x => x.Id);
                table.ForeignKey(
                    name: "FK_VaultPermissions_Vaults_VaultId",
                    column: x => x.VaultId,
                    principalTable: "Vaults",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
                table.ForeignKey(
                    name: "FK_VaultPermissions_Users_UserId",
                    column: x => x.UserId,
                    principalTable: "Users",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateIndex(
            name: "IX_Vaults_Path",
            table: "Vaults",
            column: "Path",
            unique: true);

        migrationBuilder.CreateIndex(
            name: "IX_Vaults_OwnerId",
            table: "Vaults",
            column: "OwnerId");

        migrationBuilder.CreateIndex(
            name: "IX_VaultPermissions_VaultId_UserId",
            table: "VaultPermissions",
            columns: new[] { "VaultId", "UserId" },
            unique: true);

        migrationBuilder.CreateIndex(
            name: "IX_VaultPermissions_UserId",
            table: "VaultPermissions",
            column: "UserId");
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "VaultPermissions");
        migrationBuilder.DropTable(name: "Vaults");

        // Recreate the step-1 shape so Down() leaves a working schema.
        migrationBuilder.CreateTable(
            name: "VaultPermissions",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "TEXT", nullable: false),
                UserId = table.Column<Guid>(type: "TEXT", nullable: false),
                VaultPath = table.Column<string>(type: "TEXT", maxLength: 512, nullable: false),
                Role = table.Column<string>(type: "TEXT", maxLength: 32, nullable: false),
                GrantedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                GrantedByUserId = table.Column<Guid>(type: "TEXT", nullable: true),
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_VaultPermissions", x => x.Id);
                table.ForeignKey(
                    name: "FK_VaultPermissions_Users_UserId",
                    column: x => x.UserId,
                    principalTable: "Users",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateIndex(
            name: "IX_VaultPermissions_UserId_VaultPath",
            table: "VaultPermissions",
            columns: new[] { "UserId", "VaultPath" },
            unique: true);
    }
}
