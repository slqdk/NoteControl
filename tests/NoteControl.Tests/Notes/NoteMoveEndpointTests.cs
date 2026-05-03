using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using NoteControl.Shared.Folders;
using NoteControl.Shared.Notes;
using NoteControl.Shared.Search;
using NoteControl.Shared.Vaults;
using NoteControl.Tests.Auth;
using Xunit;

namespace NoteControl.Tests.Notes;

public sealed class NoteMoveEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;
    public NoteMoveEndpointTests(TestServerFactory factory) { _factory = factory; }

    private async Task<(HttpClient Client, Guid VaultId)> AdminWithVaultAsync(string path)
    {
        var client = await _factory.CreateAdminClientAsync();
        var resp = await client.PostAsJsonAsync("/api/vaults", new CreateVaultRequest(path));
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        var dto = await resp.Content.ReadFromJsonAsync<VaultDto>();
        return (client, dto!.Id);
    }

    private static async Task CreateNoteAsync(HttpClient client, Guid vaultId, string path, string body)
    {
        var resp = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/note",
            new CreateNoteRequest(path, body));
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
    }

    [Fact]
    public async Task Renames_a_note_in_place()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/MoveA");
        await CreateNoteAsync(client, vaultId, "Old.md", "body content");

        var move = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/note/move",
            new MoveNoteRequest("Old.md", "New.md"));
        move.StatusCode.Should().Be(HttpStatusCode.OK);

        var moved = await move.Content.ReadFromJsonAsync<NoteDto>();
        moved!.Path.Should().Be("New.md");
        moved.Body.Should().Be("body content");

        // Old path is gone.
        var getOld = await client.GetAsync($"/api/vaults/{vaultId}/note?path=Old.md");
        getOld.StatusCode.Should().Be(HttpStatusCode.NotFound);

        // New path is reachable.
        var getNew = await client.GetAsync($"/api/vaults/{vaultId}/note?path=New.md");
        getNew.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Relocates_a_note_into_a_subfolder()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/MoveB");
        await CreateNoteAsync(client, vaultId, "Top.md", "x");

        var move = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/note/move",
            new MoveNoteRequest("Top.md", "Archive/Top.md"));
        move.StatusCode.Should().Be(HttpStatusCode.OK);

        var get = await client.GetAsync($"/api/vaults/{vaultId}/note?path=Archive/Top.md");
        get.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Refuses_to_overwrite_existing_destination()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/MoveC");
        await CreateNoteAsync(client, vaultId, "A.md", "a");
        await CreateNoteAsync(client, vaultId, "B.md", "b");

        var move = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/note/move",
            new MoveNoteRequest("A.md", "B.md"));
        move.StatusCode.Should().Be(HttpStatusCode.Conflict);

        // Both originals untouched.
        (await client.GetAsync($"/api/vaults/{vaultId}/note?path=A.md")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await client.GetAsync($"/api/vaults/{vaultId}/note?path=B.md")).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Returns_404_when_source_missing()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/MoveD");

        var move = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/note/move",
            new MoveNoteRequest("Ghost.md", "Other.md"));
        move.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Same_source_and_destination_is_a_noop()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/MoveE");
        await CreateNoteAsync(client, vaultId, "Same.md", "x");

        var move = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/note/move",
            new MoveNoteRequest("Same.md", "Same.md"));
        move.StatusCode.Should().Be(HttpStatusCode.OK);

        var get = await client.GetAsync($"/api/vaults/{vaultId}/note?path=Same.md");
        get.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Move_updates_search_index()
    {
        // After moving, searching should find the note at its new path,
        // not the old one. This is the integration test that catches
        // index-sync regressions.
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/MoveF");
        await CreateNoteAsync(client, vaultId, "OldName.md", "uniquetokenABC");

        await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/note/move",
            new MoveNoteRequest("OldName.md", "NewName.md"));

        var search = await client.GetFromJsonAsync<SearchResponseDto>(
            $"/api/vaults/{vaultId}/search?q=uniquetokenABC");

        search!.Results.Should().HaveCount(1);
        search.Results[0].Path.Should().Be("NewName.md");
    }
}
