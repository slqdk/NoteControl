using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using NoteControl.Shared.Notes;
using NoteControl.Shared.Search;
using NoteControl.Shared.Vaults;
using NoteControl.Tests.Auth;
using Xunit;

namespace NoteControl.Tests.Search;

public sealed class SearchEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;
    public SearchEndpointTests(TestServerFactory factory) { _factory = factory; }

    /// <summary>
    /// Most tests start from "admin logged in, owning a fresh empty vault".
    /// The path is parameterised so each test gets its own vault folder
    /// and the per-vault index DBs don't bleed into one another.
    /// </summary>
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

    private static async Task<SearchResponseDto> SearchAsync(HttpClient client, Guid vaultId, string queryString)
    {
        var resp = await client.GetAsync($"/api/vaults/{vaultId}/search?{queryString}");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await resp.Content.ReadFromJsonAsync<SearchResponseDto>())!;
    }

    // ----------------------------------------------------------- live indexing

    [Fact]
    public async Task Created_note_is_immediately_searchable()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/SearchA");
        await CreateNoteAsync(client, vaultId, "Inbox.md", "The quick brown fox jumps.");

        var result = await SearchAsync(client, vaultId, "q=fox");

        result.Results.Should().HaveCount(1);
        result.Results[0].Path.Should().Be("Inbox.md");
        result.Results[0].Snippet.Should().Contain("**fox**",
            because: "the configured highlight markers are double-asterisks for markdown-friendliness");
    }

    [Fact]
    public async Task Multi_term_query_uses_AND_semantics()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/SearchB");
        await CreateNoteAsync(client, vaultId, "A.md", "alpha bravo charlie");
        await CreateNoteAsync(client, vaultId, "B.md", "alpha delta");
        await CreateNoteAsync(client, vaultId, "C.md", "bravo charlie");

        // Both terms must appear; only A matches.
        var result = await SearchAsync(client, vaultId, "q=alpha bravo");
        result.Results.Select(r => r.Path).Should().BeEquivalentTo(new[] { "A.md" });
    }

    [Fact]
    public async Task Updated_body_replaces_indexed_content()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/SearchC");
        await CreateNoteAsync(client, vaultId, "Note.md", "first body says aardvark.");

        // Confirm initial index.
        (await SearchAsync(client, vaultId, "q=aardvark")).Results.Should().HaveCount(1);

        // Update — old term should be gone; new term should be searchable.
        var put = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/note?path=Note.md",
            new UpdateNoteRequest("second body says zebra.", null, null, null));
        put.StatusCode.Should().Be(HttpStatusCode.OK);

        (await SearchAsync(client, vaultId, "q=aardvark")).Results.Should().BeEmpty();
        (await SearchAsync(client, vaultId, "q=zebra")).Results.Should().HaveCount(1);
    }

    [Fact]
    public async Task Deleted_note_is_removed_from_index()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/SearchD");
        await CreateNoteAsync(client, vaultId, "Doomed.md", "this content is searchable for now.");
        (await SearchAsync(client, vaultId, "q=searchable")).Results.Should().HaveCount(1);

        var del = await client.DeleteAsync($"/api/vaults/{vaultId}/note?path=Doomed.md");
        del.StatusCode.Should().Be(HttpStatusCode.NoContent);

        (await SearchAsync(client, vaultId, "q=searchable")).Results.Should().BeEmpty();
    }

    // ----------------------------------------------------------- folder filter

    [Fact]
    public async Task Folder_path_restricts_search_to_subtree()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/SearchE");
        await CreateNoteAsync(client, vaultId, "Projects/Alpha.md", "shared keyword.");
        await CreateNoteAsync(client, vaultId, "Archive/Old.md",   "shared keyword.");

        var inProjects = await SearchAsync(client, vaultId, "q=shared&path=Projects");
        inProjects.Results.Select(r => r.Path).Should().BeEquivalentTo(new[] { "Projects/Alpha.md" });

        var wholeVault = await SearchAsync(client, vaultId, "q=shared");
        wholeVault.Results.Should().HaveCount(2);
    }

    // ----------------------------------------------------------- tag filter

    [Fact]
    public async Task Tag_only_search_finds_notes_by_frontmatter_tag()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/SearchF");
        // Create with explicit tag via UpdateNoteRequest (Create doesn't take tags).
        await CreateNoteAsync(client, vaultId, "Tagged.md", "body.");
        var put = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/note?path=Tagged.md",
            new UpdateNoteRequest("body.", new List<string> { "todo" }, null, null));
        put.StatusCode.Should().Be(HttpStatusCode.OK);

        await CreateNoteAsync(client, vaultId, "Untagged.md", "body.");

        var byTag = await SearchAsync(client, vaultId, "tag=todo");
        byTag.Results.Select(r => r.Path).Should().BeEquivalentTo(new[] { "Tagged.md" });
    }

    [Fact]
    public async Task Search_without_q_or_tag_returns_400()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/SearchG");
        var resp = await client.GetAsync($"/api/vaults/{vaultId}/search");
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ----------------------------------------------------------- rebuild

    [Fact]
    public async Task Rebuild_endpoint_indexes_files_present_on_disk()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/SearchH");
        await CreateNoteAsync(client, vaultId, "One.md", "first.");
        await CreateNoteAsync(client, vaultId, "Two.md", "second.");

        var rebuild = await client.PostAsync($"/api/vaults/{vaultId}/index/rebuild", content: null);
        rebuild.StatusCode.Should().Be(HttpStatusCode.OK);

        // After rebuild, both notes should still be searchable.
        var result = await SearchAsync(client, vaultId, "q=first");
        result.Results.Should().HaveCount(1);
        result.Results[0].Path.Should().Be("One.md");
    }

    [Fact]
    public async Task Status_endpoint_returns_indexed_count()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/SearchI");
        await CreateNoteAsync(client, vaultId, "A.md", "a");
        await CreateNoteAsync(client, vaultId, "B.md", "b");
        await CreateNoteAsync(client, vaultId, "C.md", "c");

        var resp = await client.GetAsync($"/api/vaults/{vaultId}/index/status");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var status = await resp.Content.ReadFromJsonAsync<IndexStatusDto>();
        status!.IndexedNotes.Should().Be(3);
    }

    // ----------------------------------------------------------- isolation

    [Fact]
    public async Task Searches_in_different_vaults_do_not_cross_contaminate()
    {
        var (client, vaultA) = await AdminWithVaultAsync("users/admin/IsolationA");
        await CreateNoteAsync(client, vaultA, "Only.md", "elephant in vault A.");

        // A second vault, owned by the same admin.
        var createB = await client.PostAsJsonAsync(
            "/api/vaults",
            new CreateVaultRequest("users/admin/IsolationB"));
        createB.StatusCode.Should().Be(HttpStatusCode.Created);
        var vaultB = (await createB.Content.ReadFromJsonAsync<VaultDto>())!.Id;

        var inB = await SearchAsync(client, vaultB, "q=elephant");
        inB.Results.Should().BeEmpty(because: "vault B has no notes, even though A has matches");
    }
}
