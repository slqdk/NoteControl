using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using NoteControl.Shared.Folders;
using NoteControl.Shared.Notes;
using NoteControl.Shared.Search;
using NoteControl.Shared.Vaults;
using NoteControl.Tests.Auth;
using Xunit;

namespace NoteControl.Tests.Folders;

public sealed class FolderMoveEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;
    public FolderMoveEndpointTests(TestServerFactory factory) { _factory = factory; }

    private async Task<(HttpClient Client, Guid VaultId)> AdminWithVaultAsync(string path)
    {
        var client = await _factory.CreateAdminClientAsync();
        var resp = await client.PostAsJsonAsync("/api/vaults", new CreateVaultRequest(path));
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        var dto = await resp.Content.ReadFromJsonAsync<VaultDto>();
        return (client, dto!.Id);
    }

    [Fact]
    public async Task Renames_an_empty_folder()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FmoveA");
        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("OldName"));

        var move = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/folder/move",
            new MoveFolderRequest("OldName", "NewName"));
        move.StatusCode.Should().Be(HttpStatusCode.OK);

        var listing = await client.GetFromJsonAsync<FolderListingDto>(
            $"/api/vaults/{vaultId}/folder");
        listing!.Subfolders.Should().Contain(s => s.Name == "NewName");
        listing.Subfolders.Should().NotContain(s => s.Name == "OldName");
    }

    [Fact]
    public async Task Moves_folder_with_notes_inside()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FmoveB");
        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("Source"));
        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/note",
            new CreateNoteRequest("Source/note.md", "the body"));

        var move = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/folder/move",
            new MoveFolderRequest("Source", "Destination"));
        move.StatusCode.Should().Be(HttpStatusCode.OK);

        // Note exists at the new path.
        var getNew = await client.GetAsync(
            $"/api/vaults/{vaultId}/note?path=Destination/note.md");
        getNew.StatusCode.Should().Be(HttpStatusCode.OK);

        // Old path is gone.
        var getOld = await client.GetAsync(
            $"/api/vaults/{vaultId}/note?path=Source/note.md");
        getOld.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Refuses_to_move_into_existing_destination()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FmoveC");
        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("A"));
        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("B"));

        var move = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/folder/move",
            new MoveFolderRequest("A", "B"));
        move.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Refuses_to_move_folder_into_its_own_subtree()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FmoveD");
        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("Outer"));

        var move = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/folder/move",
            new MoveFolderRequest("Outer", "Outer/Inner"));
        move.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Returns_404_when_source_missing()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FmoveE");

        var move = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/folder/move",
            new MoveFolderRequest("Ghost", "Phantom"));
        move.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Move_re_indexes_contained_notes_for_search()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/FmoveF");
        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("OldHome"));
        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/note",
            new CreateNoteRequest("OldHome/findme.md", "uniquetokenXYZ"));

        await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/folder/move",
            new MoveFolderRequest("OldHome", "NewHome"));

        var search = await client.GetFromJsonAsync<SearchResponseDto>(
            $"/api/vaults/{vaultId}/search?q=uniquetokenXYZ");
        search!.Results.Should().HaveCount(1);
        search.Results[0].Path.Should().Be("NewHome/findme.md");
    }
}
