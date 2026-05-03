using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using NoteControl.Shared.Templates;
using NoteControl.Shared.Vaults;
using NoteControl.Tests.Auth;
using Xunit;

namespace NoteControl.Tests.Templates;

public sealed class TemplateEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;
    public TemplateEndpointTests(TestServerFactory factory) { _factory = factory; }

    private async Task<(HttpClient Client, Guid VaultId)> AdminWithVaultAsync(string path)
    {
        var client = await _factory.CreateAdminClientAsync();
        var resp = await client.PostAsJsonAsync("/api/vaults", new CreateVaultRequest(path));
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        var dto = await resp.Content.ReadFromJsonAsync<VaultDto>();
        return (client, dto!.Id);
    }

    [Fact]
    public async Task Empty_vault_lists_no_templates()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/TplA");
        var list = await client.GetFromJsonAsync<List<TemplateSummaryDto>>(
            $"/api/vaults/{vaultId}/templates");
        list.Should().NotBeNull();
        list!.Should().BeEmpty();
    }

    [Fact]
    public async Task Create_then_get_returns_body()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/TplB");
        var body = "## Daily\n\n- [ ] Standup\n- [ ] Email\n";

        var create = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/templates",
            new TemplateUpsertRequest("Daily", body));
        create.StatusCode.Should().Be(HttpStatusCode.Created);

        var get = await client.GetFromJsonAsync<TemplateDto>(
            $"/api/vaults/{vaultId}/templates/Daily");
        get!.Name.Should().Be("Daily");
        get.Body.Should().Be(body);
    }

    [Fact]
    public async Task Create_collision_returns_409()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/TplC");
        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/templates",
            new TemplateUpsertRequest("Same", "x"));

        var second = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/templates",
            new TemplateUpsertRequest("Same", "y"));
        second.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Update_can_rename_and_change_body()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/TplD");
        await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/templates",
            new TemplateUpsertRequest("OldName", "v1"));

        var update = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/templates/OldName",
            new TemplateUpsertRequest("NewName", "v2"));
        update.StatusCode.Should().Be(HttpStatusCode.OK);

        var oldGet = await client.GetAsync($"/api/vaults/{vaultId}/templates/OldName");
        oldGet.StatusCode.Should().Be(HttpStatusCode.NotFound);

        var newGet = await client.GetFromJsonAsync<TemplateDto>(
            $"/api/vaults/{vaultId}/templates/NewName");
        newGet!.Body.Should().Be("v2");
    }

    [Fact]
    public async Task Update_rename_to_existing_returns_409()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/TplE");
        await client.PostAsJsonAsync($"/api/vaults/{vaultId}/templates",
            new TemplateUpsertRequest("A", "a"));
        await client.PostAsJsonAsync($"/api/vaults/{vaultId}/templates",
            new TemplateUpsertRequest("B", "b"));

        var update = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/templates/A",
            new TemplateUpsertRequest("B", "x"));
        update.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Delete_removes_template()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/TplF");
        await client.PostAsJsonAsync($"/api/vaults/{vaultId}/templates",
            new TemplateUpsertRequest("Goodbye", "x"));

        var delete = await client.DeleteAsync($"/api/vaults/{vaultId}/templates/Goodbye");
        delete.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var get = await client.GetAsync($"/api/vaults/{vaultId}/templates/Goodbye");
        get.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Name_with_slash_rejected()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/TplG");
        var create = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/templates",
            new TemplateUpsertRequest("evil/name", "x"));
        create.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Name_starting_with_dot_rejected()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/TplH");
        var create = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/templates",
            new TemplateUpsertRequest(".hidden", "x"));
        create.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Anonymous_list_returns_401()
    {
        var (_, vaultId) = await AdminWithVaultAsync("users/admin/TplI");
        var anon = _factory.CreateClient();
        var list = await anon.GetAsync($"/api/vaults/{vaultId}/templates");
        list.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
