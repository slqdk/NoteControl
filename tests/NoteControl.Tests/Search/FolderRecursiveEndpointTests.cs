using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using NoteControl.Shared.Folders;
using NoteControl.Shared.Notes;
using NoteControl.Shared.Vaults;
using NoteControl.Tests.Auth;
using Xunit;

namespace NoteControl.Tests.Search;

public sealed class FolderRecursiveEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;
    public FolderRecursiveEndpointTests(TestServerFactory factory) { _factory = factory; }

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
    public async Task Returns_notes_from_root_when_no_path_given()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/RecursiveA");
        await CreateNoteAsync(client, vaultId, "Top.md", "a");
        await CreateNoteAsync(client, vaultId, "Projects/Inside.md", "b");

        var notes = await client.GetFromJsonAsync<List<NoteSummaryDto>>(
            $"/api/vaults/{vaultId}/folder/recursive");

        notes!.Select(n => n.Path).Should().BeEquivalentTo(
            new[] { "Top.md", "Projects/Inside.md" },
            because: "recursive listing should include both the root note and the nested one");
    }

    [Fact]
    public async Task Restricts_to_subtree_when_path_is_given()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/RecursiveB");
        await CreateNoteAsync(client, vaultId, "Outside.md", "a");
        await CreateNoteAsync(client, vaultId, "Projects/Alpha.md", "b");
        await CreateNoteAsync(client, vaultId, "Projects/Beta.md", "c");

        var notes = await client.GetFromJsonAsync<List<NoteSummaryDto>>(
            $"/api/vaults/{vaultId}/folder/recursive?path=Projects");

        notes!.Select(n => n.Path).Should().BeEquivalentTo(
            new[] { "Projects/Alpha.md", "Projects/Beta.md" });
    }

    [Fact]
    public async Task Recurses_into_descendants_at_arbitrary_depth()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/RecursiveC");
        await CreateNoteAsync(client, vaultId, "A/B/C/Deep.md", "x");
        await CreateNoteAsync(client, vaultId, "A/Mid.md", "y");

        var notes = await client.GetFromJsonAsync<List<NoteSummaryDto>>(
            $"/api/vaults/{vaultId}/folder/recursive?path=A");

        notes!.Select(n => n.Path).Should().BeEquivalentTo(
            new[] { "A/B/C/Deep.md", "A/Mid.md" });
    }

    [Fact]
    public async Task Orders_by_most_recently_updated_first()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/RecursiveD");

        // Three notes; we update them in a specific order so the
        // last one written should appear first in the listing.
        await CreateNoteAsync(client, vaultId, "First.md", "1");
        await Task.Delay(20);
        await CreateNoteAsync(client, vaultId, "Second.md", "2");
        await Task.Delay(20);
        await CreateNoteAsync(client, vaultId, "Third.md", "3");

        var notes = await client.GetFromJsonAsync<List<NoteSummaryDto>>(
            $"/api/vaults/{vaultId}/folder/recursive");

        notes!.Should().HaveCount(3);
        notes![0].Path.Should().Be("Third.md");
        notes![2].Path.Should().Be("First.md");
    }

    [Fact]
    public async Task Returns_empty_list_for_empty_subtree()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/RecursiveE");
        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/folder",
            new CreateFolderRequest("Empty"));

        var notes = await client.GetFromJsonAsync<List<NoteSummaryDto>>(
            $"/api/vaults/{vaultId}/folder/recursive?path=Empty");
        notes!.Should().BeEmpty();
    }

    [Fact]
    public async Task Listing_uses_index_so_freshly_created_notes_show_up()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/RecursiveF");

        // Empty initially.
        var before = await client.GetFromJsonAsync<List<NoteSummaryDto>>(
            $"/api/vaults/{vaultId}/folder/recursive");
        before!.Should().BeEmpty();

        await CreateNoteAsync(client, vaultId, "Fresh.md", "x");

        var after = await client.GetFromJsonAsync<List<NoteSummaryDto>>(
            $"/api/vaults/{vaultId}/folder/recursive");
        after!.Should().HaveCount(1);
        after![0].Path.Should().Be("Fresh.md");
    }

    [Fact]
    public async Task Path_filter_does_not_match_partial_segments()
    {
        // /folder/recursive?path=Pro should NOT match Projects/Foo.md.
        // (We append "/" to the prefix internally; this test guards
        // against a regression where someone removes that.)
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/RecursiveG");
        await CreateNoteAsync(client, vaultId, "Projects/Foo.md", "a");

        var notes = await client.GetFromJsonAsync<List<NoteSummaryDto>>(
            $"/api/vaults/{vaultId}/folder/recursive?path=Pro");
        notes!.Should().BeEmpty();
    }
}
