using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using FluentAssertions;
using NoteControl.Shared.Vaults;
using NoteControl.Tests.Auth;
using Xunit;

namespace NoteControl.Tests.NoteWidgets;

/// <summary>
/// The "typekey" note widget: its payload (product group + order code)
/// must survive PUT → GET unchanged — including a group id this server
/// doesn't know and a code with lower-case open positions — and a sparse
/// payload must come back with the defaults the frontend seeds.
/// </summary>
public sealed class TypeKeyWidgetRoundTripTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;

    public TypeKeyWidgetRoundTripTests(TestServerFactory factory) { _factory = factory; }

    private static async Task<Guid> CreateVaultAsync(HttpClient client, string path)
    {
        var resp = await client.PostAsJsonAsync("/api/vaults", new CreateVaultRequest(path));
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        return (await resp.Content.ReadFromJsonAsync<VaultDto>())!.Id;
    }

    private static async Task<JsonArray> PutThenGetAsync(HttpClient client, Guid vaultId, string notePath, JsonArray widgets)
    {
        var body = new JsonObject
        {
            ["version"] = 1,
            ["byNote"] = new JsonObject { [notePath] = widgets },
        };
        var put = await client.PutAsync(
            $"/api/vaults/{vaultId}/note-widgets",
            new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"));
        put.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var get = await client.GetAsync($"/api/vaults/{vaultId}/note-widgets");
        get.StatusCode.Should().Be(HttpStatusCode.OK);
        var json = JsonNode.Parse(await get.Content.ReadAsStringAsync())!;
        return json["byNote"]![notePath]!.AsArray();
    }

    [Fact]
    public async Task TypeKey_payloads_round_trip_unchanged()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var vaultId = await CreateVaultAsync(admin, "users/admin/TypeKeyRoundTrip");

        var known = new JsonObject
        {
            ["id"] = "tk-1",
            ["x"] = 0,
            ["y"] = 0,
            ["width"] = 812,
            ["height"] = 600,
            ["familyId"] = "ax8000",
            ["code"] = "AX8108-0210-0000",
        };
        // A group from a newer frontend and Beckhoff's lower-case placeholders.
        var future = new JsonObject
        {
            ["id"] = "tk-2",
            ["x"] = 0,
            ["y"] = 0,
            ["width"] = 760,
            ["height"] = 560,
            ["familyId"] = "amp8000",
            ["code"] = "AMP8052-wxyz",
        };
        var widgets = new JsonArray(
            new JsonObject { ["id"] = "w-1", ["kind"] = "typekey", ["typeKey"] = known.DeepClone() },
            new JsonObject { ["id"] = "w-2", ["kind"] = "typekey", ["typeKey"] = future.DeepClone() });

        var back = await PutThenGetAsync(admin, vaultId, "Drives/AX8000.md", widgets);

        back.Should().HaveCount(2);
        foreach (var (sent, i) in new[] { (known, 0), (future, 1) })
        {
            back[i]!["kind"]!.GetValue<string>().Should().Be("typekey");
            var payload = back[i]!["typeKey"]!.AsObject();
            foreach (var (key, value) in sent)
            {
                payload[key].Should().NotBeNull($"field '{key}' should be stored");
                payload[key]!.ToJsonString().Should().Be(value!.ToJsonString(), $"field '{key}' should round-trip");
            }
        }
    }

    [Fact]
    public async Task Sparse_typekey_payload_gets_the_frontend_seed_defaults()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var vaultId = await CreateVaultAsync(admin, "users/admin/TypeKeyDefaults");

        var back = await PutThenGetAsync(admin, vaultId, "TypeKey.md", new JsonArray(
            new JsonObject
            {
                ["id"] = "w-1",
                ["kind"] = "typekey",
                ["typeKey"] = new JsonObject { ["id"] = "tk-sparse" },
            }));

        var payload = back[0]!["typeKey"]!.AsObject();
        var expected = new Dictionary<string, string>
        {
            ["width"] = "760",
            ["height"] = "560",
            ["familyId"] = "\"am8000\"",
            ["code"] = "\"\"",
        };
        foreach (var (key, json) in expected)
        {
            payload[key].Should().NotBeNull($"field '{key}' should be filled in");
            payload[key]!.ToJsonString().Should().Be(json, $"default for '{key}'");
        }
    }
}
