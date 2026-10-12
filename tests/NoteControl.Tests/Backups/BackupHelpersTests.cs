using FluentAssertions;
using NoteControl.Server.Backups.Services;
using Xunit;

namespace NoteControl.Tests.Backups;

/// <summary>
/// Pure helpers behind the backup engine, restore and scheduler.
/// </summary>
public sealed class BackupHelpersTests
{
    [Theory]
    [InlineData(".server/server.db", BackupService.FileAction.SnapshotRequired)]
    [InlineData(".server/server.db-wal", BackupService.FileAction.Exclude)]
    [InlineData(".server/server.db-shm", BackupService.FileAction.Exclude)]
    [InlineData(".server/tray.token", BackupService.FileAction.Exclude)]
    [InlineData(".server/csrf.key", BackupService.FileAction.Exclude)]
    [InlineData(".server/server.url", BackupService.FileAction.Exclude)]
    [InlineData(".server/config.json", BackupService.FileAction.Copy)]
    [InlineData("users/admin/Main/.notesapp/index.db", BackupService.FileAction.SnapshotOptional)]
    [InlineData("users/admin/Main/.notesapp/index.db-wal", BackupService.FileAction.Exclude)]
    [InlineData("users/admin/Main/.notesapp/index.db-shm", BackupService.FileAction.Exclude)]
    [InlineData("users/admin/Main/.notesapp/startpage.json", BackupService.FileAction.Copy)]
    [InlineData("users/admin/Main/.notesapp/templates/Daily.md", BackupService.FileAction.Copy)]
    [InlineData("users/admin/Main/Photos.assets/Thumbs.db", BackupService.FileAction.Copy)]
    [InlineData("users/admin/Main/settings.db", BackupService.FileAction.Copy)]
    [InlineData("users/admin/Main/tray.token", BackupService.FileAction.Copy)]
    [InlineData("users/admin/Main/.Note.md.0f3c.nc-tmp", BackupService.FileAction.Exclude)]
    [InlineData("users\\admin\\Main\\.notesapp\\index.db", BackupService.FileAction.SnapshotOptional)]
    public void Classify_decides_per_file(string rel, BackupService.FileAction expected)
    {
        BackupService.Classify(rel).Should().Be(expected);
    }

    [Theory]
    [InlineData("Main/.notesapp/index.db", true)]
    [InlineData("Main/.notesapp/index.db-wal", true)]
    [InlineData(".notesapp/index.db-shm", true)]
    [InlineData(".notesapp/startpage.json", false)]
    [InlineData(".notesapp/assignments.json", false)]
    [InlineData(".notesapp/note-widgets.json", false)]
    [InlineData(".notesapp/templates/x.md", false)]
    [InlineData(".notesapp/releases/a/v1.0.md", false)]
    [InlineData("index.db", false)]
    [InlineData("Sub/.notesapp/folder-marker", false)]
    public void Restore_skips_only_the_search_index(string rel, bool skipped)
    {
        RestoreService.IsSearchIndexFile(rel.Replace('/', Path.DirectorySeparatorChar)).Should().Be(skipped);
    }

    [Fact]
    public void Target_inside_data_root_is_detected()
    {
        var root = Path.Combine(Path.GetTempPath(), "nc-root");
        BackupService.IsSameOrUnder(Path.Combine(root, "backups"), root).Should().BeTrue();
        BackupService.IsSameOrUnder(root, root).Should().BeTrue();
        BackupService.IsSameOrUnder(root + Path.DirectorySeparatorChar, root).Should().BeTrue();
        BackupService.IsSameOrUnder(root + "-backups", root).Should().BeFalse();
        BackupService.IsSameOrUnder(Path.Combine(Path.GetTempPath(), "other"), root).Should().BeFalse();
    }

    [Fact]
    public void Vault_listing_returns_vault_roots_only()
    {
        var b = Path.Combine(Path.GetTempPath(), "nc-bk-" + Guid.NewGuid().ToString("N"));
        try
        {
            void Mk(string rel) => Directory.CreateDirectory(Path.Combine(b, rel));
            Mk("users/admin/Main/.notesapp");
            Mk("users/admin/Main/Projects/.notesapp");          // UI folder marker
            Mk("users/admin/Main/Projects/2026/.notesapp");
            Mk("users/bob/Work/.notesapp");
            Mk("users/bob/Deep/Nested/Vault/.notesapp");        // deeper vault path
            Mk("shared/Team/.notesapp");
            Mk("shared/Team/Docs/.notesapp");
            Mk("users/admin/NotAVault/plain");
            Mk(".server");

            BackupService.ListVaultFolders(b).Should().Equal(
                "shared/Team",
                "users/admin/Main",
                "users/bob/Deep/Nested/Vault",
                "users/bob/Work");
        }
        finally
        {
            Directory.Delete(b, recursive: true);
        }
    }

    [Fact]
    public void Scheduler_runs_on_the_start_day_when_started_before_the_slot()
    {
        var now = new DateTime(2026, 10, 11, 3, 0, 0);
        var last = BackupScheduler.InitialLastFiredDate(now, "03:30");
        last.Should().Be(new DateOnly(2026, 10, 10));

        BackupScheduler.ShouldFire(now.AddMinutes(29), last, 3, 30).Should().BeFalse();
        BackupScheduler.ShouldFire(now.AddMinutes(30), last, 3, 30).Should().BeTrue();
        BackupScheduler.ShouldFire(now.AddMinutes(31), new DateOnly(2026, 10, 11), 3, 30).Should().BeFalse();
    }

    [Fact]
    public void Scheduler_skips_a_slot_that_passed_before_start()
    {
        var now = new DateTime(2026, 10, 11, 14, 0, 0);
        var last = BackupScheduler.InitialLastFiredDate(now, "03:30");
        last.Should().Be(new DateOnly(2026, 10, 11));
        BackupScheduler.ShouldFire(now.AddMinutes(1), last, 3, 30).Should().BeFalse();
        // Next day's slot fires.
        BackupScheduler.ShouldFire(new DateTime(2026, 10, 12, 3, 30, 0), last, 3, 30).Should().BeTrue();
    }

    [Fact]
    public void Scheduler_tolerates_an_invalid_time()
    {
        var now = new DateTime(2026, 10, 11, 1, 0, 0);
        BackupScheduler.InitialLastFiredDate(now, "nonsense").Should().Be(new DateOnly(2026, 10, 11));
    }
}
