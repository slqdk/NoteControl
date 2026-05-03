using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using NoteControl.Shared.Auth;
using Xunit;

namespace NoteControl.Tests.Auth;

public sealed class AuthFlowTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;

    public AuthFlowTests(TestServerFactory factory) { _factory = factory; }

    [Fact]
    public async Task Login_with_correct_credentials_returns_user_and_csrf_token()
    {
        var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/login",
            new LoginRequest(_factory.AdminUsername, _factory.AdminPassword));

        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await response.Content.ReadFromJsonAsync<LoginResponse>();
        body.Should().NotBeNull();
        body!.User.Username.Should().Be(_factory.AdminUsername);
        body.User.Role.Should().Be("admin");
        body.CsrfToken.Should().NotBeNullOrEmpty();

        // Server should have set both cookies.
        response.Headers.TryGetValues("Set-Cookie", out var cookies).Should().BeTrue();
        var cookieList = cookies!.ToList();
        cookieList.Should().Contain(s => s.StartsWith("nc_sid=", StringComparison.Ordinal));
        cookieList.Should().Contain(s => s.StartsWith("nc_csrf=", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Login_with_wrong_password_returns_401()
    {
        var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/login",
            new LoginRequest(_factory.AdminUsername, "obviously wrong"));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Login_with_unknown_user_returns_401()
    {
        var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/login",
            new LoginRequest("ghost", "anything12345678"));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Me_without_session_returns_401()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/auth/me");
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Me_with_session_returns_current_user()
    {
        var client = await _factory.CreateAdminClientAsync();
        var response = await client.GetAsync("/api/auth/me");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadFromJsonAsync<MeResponse>();
        body!.User.Username.Should().Be(_factory.AdminUsername);
    }

    [Fact]
    public async Task Logout_invalidates_the_session()
    {
        var client = await _factory.CreateAdminClientAsync();

        var logout = await client.PostAsync("/api/auth/logout", content: null);
        logout.StatusCode.Should().Be(HttpStatusCode.OK);

        // Same client, same cookies — but the session has been revoked
        // server-side. /me must now refuse.
        var me = await client.GetAsync("/api/auth/me");
        me.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task State_changing_request_without_csrf_header_is_rejected()
    {
        var client = _factory.CreateClient();
        // Log in but DON'T set the CSRF header on the client.
        var login = await client.PostAsJsonAsync("/api/auth/login",
            new LoginRequest(_factory.AdminUsername, _factory.AdminPassword));
        login.StatusCode.Should().Be(HttpStatusCode.OK);

        // Logout is a state-changing request (POST) protected by RequireAuth +
        // CSRF. Without the X-CSRF-Token header it must fail.
        var logout = await client.PostAsync("/api/auth/logout", content: null);
        logout.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }
}
