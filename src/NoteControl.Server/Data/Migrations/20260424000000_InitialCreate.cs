using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace NoteControl.Server.Data.Migrations;

/// <inheritdoc />
public partial class InitialCreate : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "Users",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "TEXT", nullable: false),
                Username = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                Email = table.Column<string>(type: "TEXT", maxLength: 256, nullable: false),
                PasswordHash = table.Column<string>(type: "TEXT", maxLength: 512, nullable: false),
                TotpSecret = table.Column<string>(type: "TEXT", nullable: true),
                Role = table.Column<string>(type: "TEXT", maxLength: 32, nullable: false),
                Status = table.Column<string>(type: "TEXT", maxLength: 32, nullable: false),
                CreatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                LastLoginAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: true),
                LastLoginIp = table.Column<string>(type: "TEXT", nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_Users", x => x.Id);
            });

        migrationBuilder.CreateTable(
            name: "AuditEvents",
            columns: table => new
            {
                Id = table.Column<long>(type: "INTEGER", nullable: false)
                    .Annotation("Sqlite:Autoincrement", true),
                Timestamp = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                EventType = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                UserId = table.Column<Guid>(type: "TEXT", nullable: true),
                IpAddress = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                Details = table.Column<string>(type: "TEXT", maxLength: 2048, nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_AuditEvents", x => x.Id);
            });

        migrationBuilder.CreateTable(
            name: "Sessions",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "TEXT", nullable: false),
                UserId = table.Column<Guid>(type: "TEXT", nullable: false),
                TokenHash = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                CreatedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                LastActivityAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                ExpiresAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                IpAddress = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                UserAgent = table.Column<string>(type: "TEXT", maxLength: 512, nullable: true),
                IsRevoked = table.Column<bool>(type: "INTEGER", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_Sessions", x => x.Id);
                table.ForeignKey(
                    name: "FK_Sessions_Users_UserId",
                    column: x => x.UserId,
                    principalTable: "Users",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateTable(
            name: "VaultPermissions",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "TEXT", nullable: false),
                UserId = table.Column<Guid>(type: "TEXT", nullable: false),
                VaultPath = table.Column<string>(type: "TEXT", maxLength: 512, nullable: false),
                Role = table.Column<string>(type: "TEXT", maxLength: 32, nullable: false),
                GrantedAt = table.Column<DateTimeOffset>(type: "TEXT", nullable: false),
                GrantedByUserId = table.Column<Guid>(type: "TEXT", nullable: true)
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
            name: "IX_AuditEvents_EventType",
            table: "AuditEvents",
            column: "EventType");

        migrationBuilder.CreateIndex(
            name: "IX_AuditEvents_Timestamp",
            table: "AuditEvents",
            column: "Timestamp");

        migrationBuilder.CreateIndex(
            name: "IX_Sessions_ExpiresAt",
            table: "Sessions",
            column: "ExpiresAt");

        migrationBuilder.CreateIndex(
            name: "IX_Sessions_UserId",
            table: "Sessions",
            column: "UserId");

        migrationBuilder.CreateIndex(
            name: "IX_Users_Email",
            table: "Users",
            column: "Email",
            unique: true);

        migrationBuilder.CreateIndex(
            name: "IX_Users_Username",
            table: "Users",
            column: "Username",
            unique: true);

        migrationBuilder.CreateIndex(
            name: "IX_VaultPermissions_UserId_VaultPath",
            table: "VaultPermissions",
            columns: new[] { "UserId", "VaultPath" },
            unique: true);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "AuditEvents");
        migrationBuilder.DropTable(name: "Sessions");
        migrationBuilder.DropTable(name: "VaultPermissions");
        migrationBuilder.DropTable(name: "Users");
    }
}
