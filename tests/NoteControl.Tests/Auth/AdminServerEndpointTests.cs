using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using NoteControl.Shared.Auth;
using Xunit;

namespace NoteControl.Tests.Auth;

/// <summary>
/// Linux-5: GET /api/admin/server/info and POST /api/admin/server/restart.
/// The test host isn't a systemd service, so restart must refuse (409)
/// rather than stop the process.
/// </summary>
public sealed class AdminServerEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;

    public AdminServerEndpointTests(TestServerFactory factory) { _factory = factory; }

    [Fact]
    public async Task Info_reports_server_facts_for_admins()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var resp = await admin.GetAsync("/api/admin/server/info");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
        var root = doc.RootElement;
        root.GetProperty("version").GetString().Should().NotBeNullOrEmpty();
        root.GetProperty("runtime").GetString().Should().Contain(".NET");
        root.GetProperty("canRestart").GetBoolean().Should().BeFalse();
        root.GetProperty("trustedProxies").ValueKind.Should().Be(JsonValueKind.Array);
    }

    [Fact]
    public async Task Restart_refuses_outside_systemd()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var resp = await admin.PostAsync("/api/admin/server/restart", content: null);
        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);

        // The host is still serving.
        (await admin.GetAsync("/api/auth/me")).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Info_and_restart_are_admin_only()
    {
        var admin = await _factory.CreateAdminClientAsync();
        (await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("srvinfo", "srvinfo@test.local", "RegularPassword123!", "user")))
            .StatusCode.Should().Be(HttpStatusCode.Created);

        var regular = _factory.CreateClient();
        var login = await regular.PostAsJsonAsync("/api/auth/login", new LoginRequest("srvinfo", "RegularPassword123!"));
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        regular.DefaultRequestHeaders.Add("X-CSRF-Token", body!.CsrfToken);

        (await regular.GetAsync("/api/admin/server/info")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await regular.PostAsync("/api/admin/server/restart", null)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }
}
