using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using NoteControl.Shared.Folders;
using NoteControl.Shared.Notes;
using NoteControl.Shared.Vaults;
using NoteControl.Tests.Auth;
using Xunit;

namespace NoteControl.Tests.Folders;

public sealed class FolderEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;
    public FolderEndpointTests(TestServerFactory factory) { _factory = factory; }

    private async Task<(HttpClient Client, Guid VaultId)> AdminWithVaultAsync(string path)
    {
        var client = await _factory.CreateAdminClientAsync();
        var resp = await client.PostAsJsonAsync("/api/vaults", new CreateVaultRequest(path));
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        var dto = await resp.Content.ReadFromJsonAsync<VaultDto>();
        return (client, dto!.Id);
    }

    /// <summary>
    /// Subfolders are objects (FolderSummaryDto) with Name + Path, not
    /// raw strings — these helpers express the predicates that work
    /// regardless of which property carries the segment name.
    /// </summary>
    private static bool SubfolderMatches(FolderSummaryDto s, string nameOrPath) =>
        s.Name == nameOrPath || s.Path == nameOrPath || s.Path.EndsWith("/" + nameOrPath);

    // ============================================================== Create

    [Fact]
    public async Task Create_folder_makes_it_visible_in_listing()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FolderA");

        var create = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("Projects"));
        create.StatusCode.Should().Be(HttpStatusCode.Created);

        var listing = await client.GetFromJsonAsync<FolderListingDto>(
            $"/api/vaults/{vaultId}/folder");
        listing!.Subfolders.Should().Contain(s => SubfolderMatches(s, "Projects"));
    }

    [Fact]
    public async Task Create_folder_is_idempotent()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FolderB");

        var first = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("Inbox"));
        first.StatusCode.Should().Be(HttpStatusCode.Created);

        var second = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("Inbox"));
        second.StatusCode.Should().Be(HttpStatusCode.Created);
    }

    [Fact]
    public async Task Create_nested_folder_works()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FolderC");

        var create = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("Work/Projects/Q4"));
        create.StatusCode.Should().Be(HttpStatusCode.Created);

        var listing = await client.GetFromJsonAsync<FolderListingDto>(
            $"/api/vaults/{vaultId}/folder?path=Work/Projects/Q4");
        listing!.Notes.Should().BeEmpty();
    }

    [Fact]
    public async Task Create_folder_with_path_traversal_is_rejected()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FolderD");

        var create = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("../escape"));
        create.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Create_folder_with_empty_path_is_rejected()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FolderE");

        var create = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest(""));
        create.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ============================================================== Delete

    [Fact]
    public async Task Delete_empty_folder_removes_it()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FolderF");

        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("Trash-me"));

        var del = await client.DeleteAsync(
            $"/api/vaults/{vaultId}/folder?path=Trash-me");
        del.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var listing = await client.GetFromJsonAsync<FolderListingDto>(
            $"/api/vaults/{vaultId}/folder");
        listing!.Subfolders.Should().NotContain(s => SubfolderMatches(s, "Trash-me"));
    }

    [Fact]
    public async Task Delete_folder_with_notes_is_refused()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FolderG");

        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("Hold"));
        var noteCreate = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/note",
            new CreateNoteRequest("Hold/note.md", "body"));
        noteCreate.StatusCode.Should().Be(HttpStatusCode.Created);

        var del = await client.DeleteAsync(
            $"/api/vaults/{vaultId}/folder?path=Hold");
        del.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Delete_folder_with_subfolder_is_refused()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FolderH");

        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("Parent/Child"));

        var del = await client.DeleteAsync(
            $"/api/vaults/{vaultId}/folder?path=Parent");
        del.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Delete_nonexistent_folder_returns_404()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FolderI");

        var del = await client.DeleteAsync(
            $"/api/vaults/{vaultId}/folder?path=Ghost");
        del.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ============================================================== Auth

    [Fact]
    public async Task Anonymous_create_returns_401()
    {
        var (adminClient, vaultId) = await AdminWithVaultAsync("users/admin/FolderJ");
        var anon = _factory.CreateClient();

        var create = await anon.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("Sneaky"));
        create.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        var ok = await adminClient.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("Legit"));
        ok.StatusCode.Should().Be(HttpStatusCode.Created);
    }
}
