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
/// The note-widgets sidecar is stored through typed records, so a widget
/// kind only survives a save if NoteWidgetDto has a field for its
/// payload — without one, PUT silently drops it. These pin the "encoder"
/// kind: every field the frontend writes comes back unchanged from
/// PUT → GET, and a sparse payload is filled with the same defaults the
/// frontend seeds (util/noteWidgets.ts).
/// </summary>
public sealed class EncoderWidgetRoundTripTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;

    public EncoderWidgetRoundTripTests(TestServerFactory factory) { _factory = factory; }

    private static async Task<Guid> CreateVaultAsync(HttpClient client, string path)
    {
        var resp = await client.PostAsJsonAsync("/api/vaults", new CreateVaultRequest(path));
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        return (await resp.Content.ReadFromJsonAsync<VaultDto>())!.Id;
    }

    private static async Task<JsonObject> PutThenGetEncoderAsync(
        HttpClient client, Guid vaultId, string notePath, JsonObject encoder)
    {
        var body = new JsonObject
        {
            ["version"] = 1,
            ["byNote"] = new JsonObject
            {
                [notePath] = new JsonArray(new JsonObject
                {
                    ["id"] = "w-enc",
                    ["kind"] = "encoder",
                    ["encoder"] = encoder.DeepClone(),
                }),
            },
        };
        var put = await client.PutAsync(
            $"/api/vaults/{vaultId}/note-widgets",
            new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"));
        put.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var get = await client.GetAsync($"/api/vaults/{vaultId}/note-widgets");
        get.StatusCode.Should().Be(HttpStatusCode.OK);
        var json = JsonNode.Parse(await get.Content.ReadAsStringAsync())!;
        var widget = json["byNote"]![notePath]![0]!;
        widget["kind"]!.GetValue<string>().Should().Be("encoder");
        return widget["encoder"]!.AsObject();
    }

    [Fact]
    public async Task Encoder_payload_round_trips_every_field()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var vaultId = await CreateVaultAsync(admin, "users/admin/EncoderRoundTrip");

        // Everything the frontend writes, all off their defaults.
        var encoder = new JsonObject
        {
            ["id"] = "enc-1",
            ["x"] = 0,
            ["y"] = 0,
            ["width"] = 812,
            ["height"] = 700,
            ["speedRpm"] = 4500,
            ["leadMm"] = 2.5,
            ["travelMm"] = 70000,
            ["incLines"] = 5000,
            ["incSignal"] = "htl",
            ["sinCosPeriods"] = 512,
            ["sinCosInterpBits"] = 13,
            ["stVariant"] = "ext",
            ["stExtInterface"] = "ssi",
            ["stExtBits"] = 13,
            ["mtVariant"] = "J",
            ["mtExtInterface"] = "endat",
            ["mtExtBits"] = 25,
            ["mtExtTurnBits"] = 16,
            ["running"] = false,
        };

        var back = await PutThenGetEncoderAsync(admin, vaultId, "Motion/Encoders.md", encoder);

        foreach (var (key, value) in encoder)
        {
            back[key].Should().NotBeNull($"field '{key}' should be stored");
            back[key]!.ToJsonString().Should().Be(value!.ToJsonString(), $"field '{key}' should round-trip");
        }
    }

    [Fact]
    public async Task Sparse_encoder_payload_gets_the_frontend_seed_defaults()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var vaultId = await CreateVaultAsync(admin, "users/admin/EncoderDefaults");

        var back = await PutThenGetEncoderAsync(
            admin, vaultId, "Encoders.md", new JsonObject { ["id"] = "enc-sparse" });

        var expected = new Dictionary<string, string>
        {
            ["width"] = "760",
            ["height"] = "640",
            ["speedRpm"] = "3000",
            ["leadMm"] = "10",
            ["travelMm"] = "1000",
            ["incLines"] = "2048",
            ["incSignal"] = "\"ttl\"",
            ["sinCosPeriods"] = "2048",
            ["sinCosInterpBits"] = "10",
            ["stVariant"] = "\"G\"",
            ["stExtInterface"] = "\"biss\"",
            ["stExtBits"] = "17",
            ["mtVariant"] = "\"H\"",
            ["mtExtInterface"] = "\"biss\"",
            ["mtExtBits"] = "17",
            ["mtExtTurnBits"] = "12",
            ["running"] = "true",
        };
        foreach (var (key, json) in expected)
        {
            back[key].Should().NotBeNull($"field '{key}' should be filled in");
            back[key]!.ToJsonString().Should().Be(json, $"default for '{key}'");
        }
    }
}
