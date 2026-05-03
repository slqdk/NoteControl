using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using NoteControl.Shared.DailyNotes;
using NoteControl.Shared.Notes;
using NoteControl.Shared.Templates;
using NoteControl.Shared.Vaults;
using NoteControl.Tests.Auth;
using Xunit;

namespace NoteControl.Tests.DailyNotes;

public sealed class DailyNoteEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;
    public DailyNoteEndpointTests(TestServerFactory factory) { _factory = factory; }

    private async Task<(HttpClient Client, Guid VaultId)> AdminWithVaultAsync(string path)
    {
        var client = await _factory.CreateAdminClientAsync();
        var resp = await client.PostAsJsonAsync("/api/vaults", new CreateVaultRequest(path));
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        var dto = await resp.Content.ReadFromJsonAsync<VaultDto>();
        return (client, dto!.Id);
    }

    [Fact]
    public async Task First_call_creates_note_with_today_path()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/DailyA");

        var resp = await client.PostAsync($"/api/vaults/{vaultId}/daily/today", null);
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await resp.Content.ReadFromJsonAsync<DailyNoteResponse>();
        body!.Created.Should().BeTrue();
        body.AppliedTemplate.Should().BeNull();

        // Path matches today on the server clock. We can't assert
        // the exact value without timing assumptions, but we can
        // verify shape: "Daily Notes/YYYY/MM-Month/YYYY-MM-DD.md".
        var today = DateTime.Now.Date;
        var expectedPath = $"Daily Notes/{today:yyyy}/{today:MM}-{today.ToString("MMMM", CultureInfo.InvariantCulture)}/{today:yyyy-MM-dd}.md";
        body.Path.Should().Be(expectedPath);
    }

    [Fact]
    public async Task Second_call_same_day_returns_existing()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/DailyB");

        var first = await client.PostAsync($"/api/vaults/{vaultId}/daily/today", null);
        var firstBody = await first.Content.ReadFromJsonAsync<DailyNoteResponse>();

        var second = await client.PostAsync($"/api/vaults/{vaultId}/daily/today", null);
        var secondBody = await second.Content.ReadFromJsonAsync<DailyNoteResponse>();

        secondBody!.Path.Should().Be(firstBody!.Path);
        secondBody.Created.Should().BeFalse();
        secondBody.AppliedTemplate.Should().BeNull();   // doesn't re-seed
    }

    [Fact]
    public async Task Daily_template_seeds_note_body()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/DailyC");

        // Create the daily template first.
        var templateBody = "## Today\n\n- [ ] Standup\n- [ ] Email\n";
        var createTpl = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/templates",
            new TemplateUpsertRequest("daily", templateBody));
        createTpl.StatusCode.Should().Be(HttpStatusCode.Created);

        var resp = await client.PostAsync($"/api/vaults/{vaultId}/daily/today", null);
        var body = await resp.Content.ReadFromJsonAsync<DailyNoteResponse>();
        body!.Created.Should().BeTrue();
        body.AppliedTemplate.Should().Be("daily");

        // Verify the note body actually contains the seed.
        var note = await client.GetFromJsonAsync<NoteDto>(
            $"/api/vaults/{vaultId}/note?path={Uri.EscapeDataString(body.Path)}");
        note!.Body.Should().Contain("Standup");
    }

    [Fact]
    public async Task Anonymous_returns_401()
    {
        var (_, vaultId) = await AdminWithVaultAsync("users/admin/DailyD");
        var anon = _factory.CreateClient();
        var resp = await anon.PostAsync($"/api/vaults/{vaultId}/daily/today", null);
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
