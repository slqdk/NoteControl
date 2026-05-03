using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using NoteControl.Shared.Auth;
using NoteControl.Shared.Notes;
using NoteControl.Shared.Vaults;
using NoteControl.Tests.Auth;
using Xunit;

namespace NoteControl.Tests.Notes;

public sealed class NoteEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;
    public NoteEndpointTests(TestServerFactory factory) { _factory = factory; }

    private async Task<(HttpClient Client, Guid VaultId)> AdminWithVaultAsync(string path = "users/admin/Notes1")
    {
        var client = await _factory.CreateAdminClientAsync();
        var resp = await client.PostAsJsonAsync("/api/vaults", new CreateVaultRequest(path));
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        var dto = await resp.Content.ReadFromJsonAsync<VaultDto>();
        return (client, dto!.Id);
    }

    [Fact]
    public async Task Create_then_get_round_trips_the_note()
    {
        var (client, vaultId) = await AdminWithVaultAsync();

        var create = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/note",
            new CreateNoteRequest("Inbox.md", "Hello world."));
        create.StatusCode.Should().Be(HttpStatusCode.Created);
        var created = await create.Content.ReadFromJsonAsync<NoteDto>();
        created!.Path.Should().Be("Inbox.md");
        created.Body.Should().Be("Hello world.");
        created.Frontmatter.Created.Should().NotBeNull();
        created.Frontmatter.Updated.Should().NotBeNull();
        created.Etag.Should().NotBeNullOrEmpty();

        var get = await client.GetFromJsonAsync<NoteDto>(
            $"/api/vaults/{vaultId}/note?path=Inbox.md");
        get!.Body.Should().Be("Hello world.");
        get.Etag.Should().Be(created.Etag);
    }

    [Fact]
    public async Task Update_bumps_updated_and_changes_etag()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/Notes2");

        var create = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/note",
            new CreateNoteRequest("plan.md", "first body"));
        var v1 = await create.Content.ReadFromJsonAsync<NoteDto>();

        // Force at least 1ms between create and update so Updated changes.
        await Task.Delay(50);

        var put = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/note?path=plan.md",
            new UpdateNoteRequest("second body", Tags: new[] { "planning" }));
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        var v2 = await put.Content.ReadFromJsonAsync<NoteDto>();

        v2!.Body.Should().Be("second body");
        v2.Frontmatter.Tags.Should().Equal("planning");
        v2.Frontmatter.Updated!.Value.Should().BeAfter(v1!.Frontmatter.Updated!.Value);
        v2.Etag.Should().NotBe(v1.Etag);
    }

    [Fact]
    public async Task Update_with_stale_etag_returns_412()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/Notes3");

        var create = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/note",
            new CreateNoteRequest("note.md", "v1"));
        var v1 = await create.Content.ReadFromJsonAsync<NoteDto>();

        await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/note?path=note.md",
            new UpdateNoteRequest("v2"));

        var stale = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/note?path=note.md",
            new UpdateNoteRequest("v3", Etag: v1!.Etag));
        stale.StatusCode.Should().Be(HttpStatusCode.PreconditionFailed);
    }

    [Fact]
    public async Task Delete_moves_note_to_trash_and_get_returns_404()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/Notes4");

        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/note",
            new CreateNoteRequest("temp.md", "body"));

        var del = await client.DeleteAsync($"/api/vaults/{vaultId}/note?path=temp.md");
        del.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var get = await client.GetAsync($"/api/vaults/{vaultId}/note?path=temp.md");
        get.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Folder_listing_returns_subfolders_and_notes()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/Notes5");

        await client.PostAsJsonAsync($"/api/vaults/{vaultId}/note",
            new CreateNoteRequest("Inbox.md", "a"));
        await client.PostAsJsonAsync($"/api/vaults/{vaultId}/note",
            new CreateNoteRequest("Projects/q2.md", "b"));
        await client.PostAsJsonAsync($"/api/vaults/{vaultId}/note",
            new CreateNoteRequest("Projects/q3.md", "c"));

        var listing = await client.GetFromJsonAsync<FolderListingDto>(
            $"/api/vaults/{vaultId}/folder");

        listing!.Path.Should().Be("");
        listing.Subfolders.Should().ContainSingle(f => f.Name == "Projects" && f.NoteCount == 2);
        listing.Notes.Should().ContainSingle(n => n.Name == "Inbox");
        listing.RecentlyUpdated.Should().HaveCount(3);
    }

    [Fact]
    public async Task Path_traversal_attempts_at_api_boundary_rejected()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/Notes6");

        var attempts = new[]
        {
            "../escape.md",
            "Projects/../../escape.md",
            ".notesapp/index.md",
            "CON.md",
            "x?.md",
        };

        foreach (var p in attempts)
        {
            var resp = await client.PostAsJsonAsync(
                $"/api/vaults/{vaultId}/note",
                new CreateNoteRequest(p, "x"));
            resp.StatusCode.Should().Be(HttpStatusCode.BadRequest,
                because: $"path '{p}' should be rejected");
        }
    }

    [Fact]
    public async Task Viewer_can_read_but_cannot_write()
    {
        var admin = await _factory.CreateAdminClientAsync();

        // Admin makes a shared vault and seeds a note.
        var vaultResp = await admin.PostAsJsonAsync("/api/vaults",
            new CreateVaultRequest("shared/ReadOnly"));
        var vault = await vaultResp.Content.ReadFromJsonAsync<VaultDto>();

        await admin.PostAsJsonAsync($"/api/vaults/{vault!.Id}/note",
            new CreateNoteRequest("readme.md", "shared content"));

        // Create viewer user and grant viewer on the vault.
        await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("noteviewer", "nv@t.local", "ViewerPassword123", "user"));
        await admin.PostAsJsonAsync($"/api/vaults/{vault.Id}/permissions",
            new ShareVaultRequest("noteviewer", "viewer"));

        // Viewer logs in.
        var viewer = _factory.CreateClient();
        var login = await viewer.PostAsJsonAsync("/api/auth/login",
            new LoginRequest("noteviewer", "ViewerPassword123"));
        var loginBody = await login.Content.ReadFromJsonAsync<LoginResponse>();
        viewer.DefaultRequestHeaders.Add("X-CSRF-Token", loginBody!.CsrfToken);

        // Read works.
        var read = await viewer.GetAsync($"/api/vaults/{vault.Id}/note?path=readme.md");
        read.StatusCode.Should().Be(HttpStatusCode.OK);

        // Write is forbidden.
        var write = await viewer.PutAsJsonAsync(
            $"/api/vaults/{vault.Id}/note?path=readme.md",
            new UpdateNoteRequest("tampered"));
        write.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task User_with_no_access_gets_404_not_403()
    {
        var admin = await _factory.CreateAdminClientAsync();

        var vaultResp = await admin.PostAsJsonAsync("/api/vaults",
            new CreateVaultRequest("users/admin/Private"));
        var vault = await vaultResp.Content.ReadFromJsonAsync<VaultDto>();
        await admin.PostAsJsonAsync($"/api/vaults/{vault!.Id}/note",
            new CreateNoteRequest("secret.md", "private"));

        await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("nobody", "n@t.local", "NobodyPassword12", "user"));

        var nobody = _factory.CreateClient();
        var login = await nobody.PostAsJsonAsync("/api/auth/login",
            new LoginRequest("nobody", "NobodyPassword12"));
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        nobody.DefaultRequestHeaders.Add("X-CSRF-Token", body!.CsrfToken);

        var get = await nobody.GetAsync($"/api/vaults/{vault.Id}/note?path=secret.md");
        // Per RequireVaultRoleFilter: no role row => 404 (not 403), to avoid
        // leaking which vault ids exist.
        get.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
