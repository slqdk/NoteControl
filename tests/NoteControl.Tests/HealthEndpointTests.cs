using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace NoteControl.Tests;

/// <summary>
/// Smoke tests verifying the server starts up and the basic endpoints respond.
/// These catch the "did the whole thing build and wire up correctly?" class of
/// bug, which is disproportionately valuable at this stage.
/// </summary>
public sealed class HealthEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;

    public HealthEndpointTests(WebApplicationFactory<Program> factory)
    {
        // Override the DataRoot so tests don't touch C:\ProgramData.
        _factory = factory.WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Development");
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Storage:DataRoot"] = Path.Combine(
                        Path.GetTempPath(),
                        "NoteControlTests",
                        Guid.NewGuid().ToString())
                });
            });
        });
    }

    [Fact]
    public async Task Health_ReturnsOk()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Health_ReturnsExpectedPayload()
    {
        var client = _factory.CreateClient();

        var payload = await client.GetFromJsonAsync<HealthPayload>("/health");

        Assert.NotNull(payload);
        Assert.Equal("ok", payload!.Status);
        Assert.Equal("NoteControl", payload.Product);
    }

    [Fact]
    public async Task Root_Responds()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task SecurityHeaders_ArePresent()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/health");

        Assert.True(response.Headers.Contains("X-Content-Type-Options"));
        Assert.True(response.Headers.Contains("X-Frame-Options"));
        Assert.True(response.Headers.Contains("Content-Security-Policy"));
    }

    private sealed record HealthPayload(
        string Status,
        string Product,
        string Version,
        DateTimeOffset Timestamp);
}
