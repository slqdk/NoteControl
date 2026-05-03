using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using NoteControl.Shared.Auth;
using Xunit;

namespace NoteControl.Tests.Auth;

public sealed class UserEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;

    public UserEndpointTests(TestServerFactory factory) { _factory = factory; }

    [Fact]
    public async Task List_users_includes_seeded_admin()
    {
        var client = await _factory.CreateAdminClientAsync();
        var response = await client.GetAsync("/api/users");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var users = await response.Content.ReadFromJsonAsync<List<UserDto>>();
        users.Should().NotBeNull();
        users!.Should().Contain(u => u.Username == _factory.AdminUsername && u.Role == "admin");
    }

    [Fact]
    public async Task Anonymous_caller_cannot_list_users()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/users");
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Non_admin_cannot_list_users()
    {
        var admin = await _factory.CreateAdminClientAsync();

        // Admin creates a normal user.
        var create = await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("regular", "regular@test.local", "RegularPassword123!", "user"));
        create.StatusCode.Should().Be(HttpStatusCode.Created);

        // That user logs in.
        var regular = _factory.CreateClient();
        var login = await regular.PostAsJsonAsync("/api/auth/login",
            new LoginRequest("regular", "RegularPassword123!"));
        login.StatusCode.Should().Be(HttpStatusCode.OK);
        var loginBody = await login.Content.ReadFromJsonAsync<LoginResponse>();
        regular.DefaultRequestHeaders.Add("X-CSRF-Token", loginBody!.CsrfToken);

        // /api/users is admin-only.
        var listResponse = await regular.GetAsync("/api/users");
        listResponse.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Create_user_rejects_short_password()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var response = await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("short", "short@test.local", "tooshort", "user"));
        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Create_user_rejects_duplicate_username()
    {
        var admin = await _factory.CreateAdminClientAsync();
        await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("dup", "dup1@test.local", "DupPassword123!", "user"));
        var second = await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("dup", "dup2@test.local", "DupPassword123!", "user"));
        second.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Cannot_delete_last_active_admin()
    {
        var admin = await _factory.CreateAdminClientAsync();

        // Find the admin's id.
        var me = await admin.GetFromJsonAsync<MeResponse>("/api/auth/me");
        var response = await admin.DeleteAsync($"/api/users/{me!.User.Id}");

        // The endpoint refuses on two grounds: (1) you can't delete yourself,
        // and (2) you can't delete the last admin. Either way, BadRequest.
        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Disabling_user_revokes_their_existing_sessions()
    {
        var admin = await _factory.CreateAdminClientAsync();

        // Create + log in as a normal user.
        var create = await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("kicker", "kicker@test.local", "KickerPassword123!", "user"));
        create.StatusCode.Should().Be(HttpStatusCode.Created);
        var created = await create.Content.ReadFromJsonAsync<UserDto>();

        var victim = _factory.CreateClient();
        var login = await victim.PostAsJsonAsync("/api/auth/login",
            new LoginRequest("kicker", "KickerPassword123!"));
        login.StatusCode.Should().Be(HttpStatusCode.OK);
        var loginBody = await login.Content.ReadFromJsonAsync<LoginResponse>();
        victim.DefaultRequestHeaders.Add("X-CSRF-Token", loginBody!.CsrfToken);

        // Sanity: victim is logged in.
        (await victim.GetAsync("/api/auth/me")).StatusCode.Should().Be(HttpStatusCode.OK);

        // Admin disables them.
        var disable = await admin.PutAsJsonAsync($"/api/users/{created!.Id}",
            new UpdateUserRequest(Email: null, Role: null, Status: "disabled"));
        disable.StatusCode.Should().Be(HttpStatusCode.OK);

        // Victim's session is gone.
        var afterMe = await victim.GetAsync("/api/auth/me");
        afterMe.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
