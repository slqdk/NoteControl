using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Data.Entities;

namespace NoteControl.Server.Data;

/// <summary>
/// EF Core context for the server-wide database (`server.db`).
///
/// This is the only database in NoteControl that is *not* disposable; the
/// per-vault index.db caches alongside the markdown files can be rebuilt
/// from disk at any time, but this one holds identity and access control.
/// </summary>
public sealed class ServerDbContext : DbContext
{
    public ServerDbContext(DbContextOptions<ServerDbContext> options) : base(options) { }

    public DbSet<User> Users => Set<User>();
    public DbSet<Session> Sessions => Set<Session>();
    public DbSet<Vault> Vaults => Set<Vault>();
    public DbSet<VaultPermission> VaultPermissions => Set<VaultPermission>();
    public DbSet<AuditEvent> AuditEvents => Set<AuditEvent>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.Entity<User>(b =>
        {
            b.HasKey(x => x.Id);
            b.HasIndex(x => x.Username).IsUnique();
            b.HasIndex(x => x.Email).IsUnique();
            b.Property(x => x.Username).HasMaxLength(64).IsRequired();
            b.Property(x => x.Email).HasMaxLength(256).IsRequired();
            b.Property(x => x.PasswordHash).HasMaxLength(512).IsRequired();
            b.Property(x => x.Role).HasMaxLength(32).IsRequired();
            b.Property(x => x.Status).HasMaxLength(32).IsRequired();
        });

        modelBuilder.Entity<Session>(b =>
        {
            b.HasKey(x => x.Id);
            b.HasIndex(x => x.UserId);
            b.HasIndex(x => x.ExpiresAt);
            b.Property(x => x.TokenHash).HasMaxLength(128).IsRequired();
            b.Property(x => x.IpAddress).HasMaxLength(64);
            b.Property(x => x.UserAgent).HasMaxLength(512);
            b.HasOne<User>()
                .WithMany()
                .HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<Vault>(b =>
        {
            b.HasKey(x => x.Id);
            // Path must be globally unique — two vaults can't sit on the
            // same on-disk folder.
            b.HasIndex(x => x.Path).IsUnique();
            b.HasIndex(x => x.OwnerId);
            b.Property(x => x.Path).HasMaxLength(512).IsRequired();
            b.Property(x => x.Name).HasMaxLength(128).IsRequired();
            b.Property(x => x.Scope).HasMaxLength(32).IsRequired();
            b.HasOne<User>()
                .WithMany()
                .HasForeignKey(x => x.OwnerId)
                // If the owner is deleted we deliberately *block* the delete
                // rather than cascade-removing the vault, because deleting a
                // vault row would orphan the on-disk folder. Admin must
                // re-assign or hand-delete the vault first.
                .OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<VaultPermission>(b =>
        {
            b.HasKey(x => x.Id);
            b.HasIndex(x => new { x.VaultId, x.UserId }).IsUnique();
            b.HasIndex(x => x.UserId);
            b.Property(x => x.Role).HasMaxLength(32).IsRequired();
            b.HasOne<Vault>()
                .WithMany()
                .HasForeignKey(x => x.VaultId)
                .OnDelete(DeleteBehavior.Cascade);
            b.HasOne<User>()
                .WithMany()
                .HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<AuditEvent>(b =>
        {
            b.HasKey(x => x.Id);
            b.HasIndex(x => x.Timestamp);
            b.HasIndex(x => x.EventType);
            b.Property(x => x.EventType).HasMaxLength(64).IsRequired();
            b.Property(x => x.IpAddress).HasMaxLength(64);
            b.Property(x => x.Details).HasMaxLength(2048);
        });
    }
}
