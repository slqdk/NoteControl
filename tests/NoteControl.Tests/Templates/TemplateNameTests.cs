using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using NoteControl.Server.Vaults.Services;
using NoteControl.Shared.Notes;
using NoteControl.Shared.Templates;
using NoteControl.Shared.Vaults;
using NoteControl.Tests.Auth;
using Xunit;

namespace NoteControl.Tests.Templates;

/// <summary>
/// Audit SV-13: names the server itself produces ("Template … (2)")
/// or that arrive on disk by other routes ("Møde.md") must stay
/// openable, editable, insertable and deletable.
/// </summary>
public sealed class TemplateNameTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;
    public TemplateNameTests(TestServerFactory factory) { _factory = factory; }

    private async Task<(HttpClient Client, Guid VaultId, string Root)> AdminWithVaultAsync(string path)
    {
        var client = await _factory.CreateAdminClientAsync();
        var resp = await client.PostAsJsonAsync("/api/vaults", new CreateVaultRequest(path));
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        var dto = await resp.Content.ReadFromJsonAsync<VaultDto>();
        var root = _factory.Services.GetRequiredService<IVaultPathResolver>().Resolve(path);
        return (client, dto!.Id, root);
    }

    private static string Url(Guid vaultId, string name) =>
        $"/api/vaults/{vaultId}/templates/{Uri.EscapeDataString(name)}";

    [Fact]
    public async Task Second_save_as_template_gets_a_usable_suffixed_name()
    {
        var (client, vaultId, root) = await AdminWithVaultAsync("users/admin/TplName1");
        (await client.PostAsJsonAsync($"/api/vaults/{vaultId}/note",
            new CreateNoteRequest("Src.md", "x"))).EnsureSuccessStatusCode();
        Directory.CreateDirectory(Path.Combine(root, "Src.assets"));
        await File.WriteAllBytesAsync(Path.Combine(root, "Src.assets", "pic.png"), new byte[] { 1, 2, 3 });
        (await client.PostAsJsonAsync($"/api/vaults/{vaultId}/note",
            new CreateNoteRequest("Target.md", "t"))).EnsureSuccessStatusCode();

        // Two saves in the same minute collide on the auto-name; retry
        // once if the pair happened to straddle a minute boundary.
        string? suffixed = null;
        for (var attempt = 0; attempt < 2 && suffixed is null; attempt++)
        {
            var first = await FromSelectionAsync(client, vaultId);
            var second = await FromSelectionAsync(client, vaultId);
            if (second.Name == first.Name + " (2)") suffixed = second.Name;
        }
        suffixed.Should().NotBeNull("two saves within one minute must collide and be suffixed");

        // Get
        var get = await client.GetAsync(Url(vaultId, suffixed!));
        get.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await get.Content.ReadFromJsonAsync<TemplateDto>();
        dto!.Body.Should().Contain("%282%29.assets/pic.png", "parentheses are percent-encoded in the image link");

        // Insert (render) into a note: image copied and relinked.
        var render = await client.PostAsync(
            $"{Url(vaultId, suffixed!)}/render?targetNotePath=Target.md", null);
        render.StatusCode.Should().Be(HttpStatusCode.OK);
        var rendered = await render.Content.ReadFromJsonAsync<TemplateRenderResponse>();
        rendered!.Body.Should().Contain("Target.assets/pic.png");
        File.Exists(Path.Combine(root, "Target.assets", "pic.png")).Should().BeTrue();

        // Save body (same name)
        var put = await client.PutAsJsonAsync(Url(vaultId, suffixed!),
            new TemplateUpsertRequest(suffixed!, dto.Body + "\nmore"));
        put.StatusCode.Should().Be(HttpStatusCode.OK);

        // Rename to another parenthesised name: asset folder follows.
        var put2 = await client.PutAsJsonAsync(Url(vaultId, suffixed!),
            new TemplateUpsertRequest("Meeting (copy)", dto.Body));
        put2.StatusCode.Should().Be(HttpStatusCode.OK);
        Directory.Exists(Path.Combine(root, ".notesapp", "templates", "Meeting (copy).assets")).Should().BeTrue();

        // Delete
        var del = await client.DeleteAsync(Url(vaultId, "Meeting (copy)"));
        del.StatusCode.Should().Be(HttpStatusCode.NoContent);
        File.Exists(Path.Combine(root, ".notesapp", "templates", "Meeting (copy).md")).Should().BeFalse();
    }

    private static async Task<TemplateDto> FromSelectionAsync(HttpClient client, Guid vaultId)
    {
        var resp = await client.PostAsJsonAsync($"/api/vaults/{vaultId}/templates/from-selection",
            new TemplateFromSelectionRequest("Src.md", "Hello ![p](Src.assets/pic.png)"));
        resp.IsSuccessStatusCode.Should().BeTrue(await resp.Content.ReadAsStringAsync());
        return (await resp.Content.ReadFromJsonAsync<TemplateDto>())!;
    }

    [Theory]
    [InlineData("Møde")]
    [InlineData("Ærø 2026")]
    [InlineData("Report (draft)")]
    [InlineData("v1.2 notes")]
    public async Task Create_accepts_unicode_letters_and_parentheses(string name)
    {
        var (client, vaultId, _) = await AdminWithVaultAsync("users/admin/TplName2-" + Guid.NewGuid().ToString("N")[..6]);
        var create = await client.PostAsJsonAsync($"/api/vaults/{vaultId}/templates",
            new TemplateUpsertRequest(name, "b"));
        create.StatusCode.Should().Be(HttpStatusCode.Created);
        (await client.GetAsync(Url(vaultId, name))).StatusCode.Should().Be(HttpStatusCode.OK);
        (await client.DeleteAsync(Url(vaultId, name))).StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Theory]
    [InlineData("a:b")]
    [InlineData("a*b")]
    [InlineData("a\\b")]
    [InlineData(".hidden")]
    [InlineData("a#b")]
    public async Task Create_still_rejects_unsafe_names(string name)
    {
        var (client, vaultId, _) = await AdminWithVaultAsync("users/admin/TplName3-" + Guid.NewGuid().ToString("N")[..6]);
        var create = await client.PostAsJsonAsync($"/api/vaults/{vaultId}/templates",
            new TemplateUpsertRequest(name, "b"));
        create.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Hand_made_template_outside_the_creation_rule_is_still_usable()
    {
        var (client, vaultId, root) = await AdminWithVaultAsync("users/admin/TplName4");
        var folder = Path.Combine(root, ".notesapp", "templates");
        Directory.CreateDirectory(folder);
        await File.WriteAllTextAsync(Path.Combine(folder, "Q&A #1.md"), "body");

        var list = await client.GetFromJsonAsync<List<TemplateSummaryDto>>($"/api/vaults/{vaultId}/templates");
        list!.Select(t => t.Name).Should().Contain("Q&A #1");

        (await client.GetAsync(Url(vaultId, "Q&A #1"))).StatusCode.Should().Be(HttpStatusCode.OK);

        // Saving the body under its existing name works...
        (await client.PutAsJsonAsync(Url(vaultId, "Q&A #1"),
            new TemplateUpsertRequest("Q&A #1", "new body"))).StatusCode.Should().Be(HttpStatusCode.OK);
        // ...renaming TO such a name doesn't...
        (await client.PutAsJsonAsync(Url(vaultId, "Q&A #1"),
            new TemplateUpsertRequest("Other #2", "x"))).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        // ...renaming away from it does, and delete works.
        (await client.PutAsJsonAsync(Url(vaultId, "Q&A #1"),
            new TemplateUpsertRequest("QA 1", "x"))).StatusCode.Should().Be(HttpStatusCode.OK);
        (await client.DeleteAsync(Url(vaultId, "QA 1"))).StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    // ".." and "../x" aren't listed: HttpClient collapses dot segments
    // in the URL before sending, so they never reach this endpoint.
    [Theory]
    [InlineData("..\\x")]
    [InlineData("..\\..\\..\\x")]
    [InlineData(".notesapp")]
    [InlineData("a/b")]
    public async Task Existing_name_lookups_reject_traversal(string name)
    {
        var (client, vaultId, _) = await AdminWithVaultAsync("users/admin/TplName5-" + Guid.NewGuid().ToString("N")[..6]);
        var get = await client.GetAsync(Url(vaultId, name));
        get.StatusCode.Should().BeOneOf(HttpStatusCode.BadRequest, HttpStatusCode.NotFound);
        var del = await client.DeleteAsync(Url(vaultId, name));
        del.StatusCode.Should().BeOneOf(HttpStatusCode.BadRequest, HttpStatusCode.NotFound);
    }
}
