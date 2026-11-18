using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Data.Sqlite;
using NoteControl.Shared.Admin;
using NoteControl.Shared.Auth;
using NoteControl.Shared.Notes;
using NoteControl.Shared.Vaults;
using NoteControl.Tests.Auth;
using Xunit;

namespace NoteControl.Tests.Backups;

/// <summary>
/// Linux-4 zip exports: GET /api/admin/export (admin, whole DataRoot,
/// import.sh format) and GET /api/vaults/{id}/export (vault owner).
/// Plus the backup target validation added in the same ship.
/// </summary>
public sealed class ExportEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;

    public ExportEndpointTests(TestServerFactory factory) { _factory = factory; }

    private static async Task<Guid> CreateVaultAsync(HttpClient client, string path)
    {
        var resp = await client.PostAsJsonAsync("/api/vaults", new CreateVaultRequest(path));
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        return (await resp.Content.ReadFromJsonAsync<VaultDto>())!.Id;
    }

    private static async Task CreateNoteAsync(HttpClient client, Guid vaultId, string path, string body)
    {
        var resp = await client.PostAsJsonAsync($"/api/vaults/{vaultId}/note", new CreateNoteRequest(path, body));
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
    }

    private async Task<HttpClient> RegularUserAsync(string username)
    {
        var admin = await _factory.CreateAdminClientAsync();
        (await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest(username, $"{username}@test.local", "RegularPassword123!", "user")))
            .StatusCode.Should().Be(HttpStatusCode.Created);
        var client = _factory.CreateClient();
        var login = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(username, "RegularPassword123!"));
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Add("X-CSRF-Token", body!.CsrfToken);
        return client;
    }

    private static async Task<ZipArchive> ReadZipAsync(HttpResponseMessage resp)
    {
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        resp.Content.Headers.ContentType!.MediaType.Should().Be("application/zip");
        var ms = new MemoryStream(await resp.Content.ReadAsByteArrayAsync());
        return new ZipArchive(ms, ZipArchiveMode.Read);
    }

    [Fact]
    public async Task Full_export_is_an_importable_snapshot_without_secrets()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var vaultId = await CreateVaultAsync(admin, "users/admin/ExportFull");
        await CreateNoteAsync(admin, vaultId, "Mappe/Første note.md", "Hej æøå");

        var resp = await admin.GetAsync("/api/admin/export");
        resp.Content.Headers.ContentDisposition!.DispositionType.Should().Be("attachment");
        using var zip = await ReadZipAsync(resp);
        var names = zip.Entries.Select(e => e.FullName).ToList();

        names.Should().Contain(".server/server.db");
        names.Should().Contain("export-manifest.json");
        names.Should().Contain("users/admin/ExportFull/Mappe/Første note.md");
        names.Should().NotContain(n => n.EndsWith("tray.token") || n.EndsWith("csrf.key") || n.EndsWith("server.url"));
        names.Should().NotContain(n => n.EndsWith("-wal") || n.EndsWith("-shm"));
        names.Should().NotContain(n => n.Contains('\\'));

        // server.db is a real, consistent SQLite snapshot with the users in it.
        var tmp = Path.Combine(Path.GetTempPath(), $"nc-export-test-{Guid.NewGuid():N}.db");
        try
        {
            zip.GetEntry(".server/server.db")!.ExtractToFile(tmp);
            using var conn = new SqliteConnection($"Data Source={tmp};Pooling=False");
            conn.Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT COUNT(*) FROM Users WHERE Username = 'admin';";
            Convert.ToInt32(cmd.ExecuteScalar()).Should().Be(1);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            File.Delete(tmp);
        }

        using var manifestStream = zip.GetEntry("export-manifest.json")!.Open();
        using var manifest = await JsonDocument.ParseAsync(manifestStream);
        manifest.RootElement.GetProperty("format").GetString().Should().Be("notecontrol-export");
        manifest.RootElement.GetProperty("vaultFolders").EnumerateArray()
            .Select(e => e.GetString()).Should().Contain("users/admin/ExportFull");
    }

    [Fact]
    public async Task Vault_export_contains_the_vault_relative_to_its_root()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var vaultId = await CreateVaultAsync(admin, "users/admin/ExportOne");
        await CreateNoteAsync(admin, vaultId, "A.md", "alpha");
        await CreateNoteAsync(admin, vaultId, "Sub/B.md", "bravo");

        using var zip = await ReadZipAsync(await admin.GetAsync($"/api/vaults/{vaultId}/export"));
        var names = zip.Entries.Select(e => e.FullName).ToList();

        names.Should().Contain("A.md");
        names.Should().Contain("Sub/B.md");
        names.Should().Contain(n => n.StartsWith(".notesapp/"));
        names.Should().NotContain(n => n.StartsWith("users/"));
        names.Should().NotContain(n => n.EndsWith("-wal") || n.EndsWith("-shm"));
    }

    [Fact]
    public async Task Full_export_is_admin_only()
    {
        var regular = await RegularUserAsync("exportnonadmin");
        (await regular.GetAsync("/api/admin/export")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await _factory.CreateClient().GetAsync("/api/admin/export")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Vault_export_is_owner_only()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var vaultId = await CreateVaultAsync(admin, "users/admin/ExportPrivate");

        // Someone with no role on it.
        var stranger = await RegularUserAsync("exportstranger");
        (await stranger.GetAsync($"/api/vaults/{vaultId}/export")).StatusCode
            .Should().BeOneOf(HttpStatusCode.Forbidden, HttpStatusCode.NotFound);

        // An editor is not enough either.
        var editor = await RegularUserAsync("exporteditor");
        (await admin.PostAsJsonAsync($"/api/vaults/{vaultId}/permissions",
            new ShareVaultRequest("exporteditor", "editor"))).EnsureSuccessStatusCode();
        (await editor.GetAsync($"/api/vaults/{vaultId}/export")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Backup_target_must_be_absolute_and_writable()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var current = (await admin.GetFromJsonAsync<ServerConfigDto>("/api/admin/server/config"))!;

        var relative = current with { Backup = current.Backup with { Enabled = true, TargetPath = "backups/here" } };
        var r1 = await admin.PutAsJsonAsync("/api/admin/server/config", relative);
        r1.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await r1.Content.ReadAsStringAsync()).Should().Contain("Backup.TargetPath");

        var good = Path.Combine(Path.GetTempPath(), "nc-backup-target-" + Guid.NewGuid().ToString("N"));
        try
        {
            var ok = current with { Backup = current.Backup with { Enabled = false, TargetPath = good } };
            var r2 = await admin.PutAsJsonAsync("/api/admin/server/config", ok);
            r2.StatusCode.Should().Be(HttpStatusCode.OK);
            Directory.Exists(good).Should().BeTrue("the save probes the folder by creating it");
            Directory.EnumerateFileSystemEntries(good).Should().BeEmpty("the probe file is removed again");
        }
        finally
        {
            try { Directory.Delete(good, recursive: true); } catch { /* ignored */ }
            // Put the original backup settings back for other tests in this fixture.
            await admin.PutAsJsonAsync("/api/admin/server/config", current);
        }
    }
}
