using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using NoteControl.Shared.Auth;
using Xunit;

namespace NoteControl.Tests.Auth;

/// <summary>
/// POST /api/auth/password — self-service password change for any
/// signed-in user. Requires the current password; revokes the user's
/// OTHER sessions and keeps the calling one alive.
/// </summary>
public sealed class OwnPasswordEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;

    public OwnPasswordEndpointTests(TestServerFactory factory) { _factory = factory; }

    private async Task<HttpClient> LoginAsync(string username, string password)
    {
        var client = _factory.CreateClient();
        var login = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(username, password));
        login.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        client.DefaultRequestHeaders.Add("X-CSRF-Token", body!.CsrfToken);
        return client;
    }

    private async Task CreateUserAsync(string username, string password)
    {
        var admin = await _factory.CreateAdminClientAsync();
        var create = await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest(username, $"{username}@test.local", password, "user"));
        create.StatusCode.Should().Be(HttpStatusCode.Created);
    }

    [Fact]
    public async Task Regular_user_can_change_own_password_and_keeps_current_session()
    {
        await CreateUserAsync("selfpw1", "OriginalPassword123!");
        var tabA = await LoginAsync("selfpw1", "OriginalPassword123!");
        var tabB = await LoginAsync("selfpw1", "OriginalPassword123!");

        var change = await tabA.PostAsJsonAsync("/api/auth/password",
            new ChangePasswordRequest("OriginalPassword123!", "BrandNewPassword456!"));
        change.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Calling session survives, the other one is revoked.
        (await tabA.GetAsync("/api/auth/me")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await tabB.GetAsync("/api/auth/me")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // Old password no longer works, new one does.
        var oldLogin = await _factory.CreateClient().PostAsJsonAsync("/api/auth/login",
            new LoginRequest("selfpw1", "OriginalPassword123!"));
        oldLogin.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        await LoginAsync("selfpw1", "BrandNewPassword456!");
    }

    [Fact]
    public async Task Wrong_current_password_is_rejected()
    {
        await CreateUserAsync("selfpw2", "OriginalPassword123!");
        var client = await LoginAsync("selfpw2", "OriginalPassword123!");

        var change = await client.PostAsJsonAsync("/api/auth/password",
            new ChangePasswordRequest("NotMyPassword999!", "BrandNewPassword456!"));
        change.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var missing = await client.PostAsJsonAsync("/api/auth/password",
            new ChangePasswordRequest(null, "BrandNewPassword456!"));
        missing.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task New_password_must_pass_policy_and_differ()
    {
        await CreateUserAsync("selfpw3", "OriginalPassword123!");
        var client = await LoginAsync("selfpw3", "OriginalPassword123!");

        var tooShort = await client.PostAsJsonAsync("/api/auth/password",
            new ChangePasswordRequest("OriginalPassword123!", "short"));
        tooShort.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var same = await client.PostAsJsonAsync("/api/auth/password",
            new ChangePasswordRequest("OriginalPassword123!", "OriginalPassword123!"));
        same.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Requires_csrf_and_session()
    {
        var anon = _factory.CreateClient();
        var r = await anon.PostAsJsonAsync("/api/auth/password",
            new ChangePasswordRequest("x", "BrandNewPassword456!"));
        r.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        await CreateUserAsync("selfpw4", "OriginalPassword123!");
        var noCsrf = _factory.CreateClient();
        (await noCsrf.PostAsJsonAsync("/api/auth/login",
            new LoginRequest("selfpw4", "OriginalPassword123!"))).EnsureSuccessStatusCode();
        var r2 = await noCsrf.PostAsJsonAsync("/api/auth/password",
            new ChangePasswordRequest("OriginalPassword123!", "BrandNewPassword456!"));
        r2.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }
}
