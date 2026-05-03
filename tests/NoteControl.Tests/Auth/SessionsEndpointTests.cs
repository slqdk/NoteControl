using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using NoteControl.Shared.Auth;
using Xunit;

namespace NoteControl.Tests.Auth;

public sealed class SessionsEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;

    public SessionsEndpointTests(TestServerFactory factory) { _factory = factory; }

    [Fact]
    public async Task Admin_can_list_their_own_sessions()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var me = await admin.GetFromJsonAsync<MeResponse>("/api/auth/me");

        var response = await admin.GetAsync($"/api/users/{me!.User.Id}/sessions");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var list = await response.Content.ReadFromJsonAsync<List<SessionDto>>();
        list.Should().NotBeNull();
        list!.Should().Contain(s => s.IsCurrent);
    }

    [Fact]
    public async Task Anonymous_cannot_list_sessions()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync($"/api/users/{Guid.NewGuid()}/sessions");
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Listing_sessions_for_unknown_user_returns_404()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var response = await admin.GetAsync($"/api/users/{Guid.NewGuid()}/sessions");
        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Revoking_session_invalidates_it()
    {
        var admin = await _factory.CreateAdminClientAsync();

        // Create a regular user and log them in to get a session.
        var create = await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("victim", "victim@test.local", "VictimPassword123!", "user"));
        create.StatusCode.Should().Be(HttpStatusCode.Created);
        var victim = await create.Content.ReadFromJsonAsync<UserDto>();

        var victimClient = _factory.CreateClient();
        var login = await victimClient.PostAsJsonAsync("/api/auth/login",
            new LoginRequest("victim", "VictimPassword123!"));
        login.StatusCode.Should().Be(HttpStatusCode.OK);
        var loginBody = await login.Content.ReadFromJsonAsync<LoginResponse>();
        victimClient.DefaultRequestHeaders.Add("X-CSRF-Token", loginBody!.CsrfToken);

        // Confirm victim is logged in.
        (await victimClient.GetAsync("/api/auth/me")).StatusCode.Should().Be(HttpStatusCode.OK);

        // Admin lists the victim's sessions and revokes the first one.
        var sessionsResp = await admin.GetAsync($"/api/users/{victim!.Id}/sessions");
        var sessions = await sessionsResp.Content.ReadFromJsonAsync<List<SessionDto>>();
        sessions.Should().NotBeEmpty();
        var sessionId = sessions![0].Id;

        var revoke = await admin.DeleteAsync($"/api/sessions/{sessionId}");
        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Victim's /me must now refuse.
        var afterMe = await victimClient.GetAsync("/api/auth/me");
        afterMe.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
