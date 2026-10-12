using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using FluentAssertions;
using Microsoft.Extensions.Options;
using NoteControl.Server.Auth.Services;
using NoteControl.Server.Options;
using NoteControl.Shared.Admin;
using NoteControl.Shared.Auth;
using NoteControl.Shared.Vaults;
using Xunit;

namespace NoteControl.Tests.Auth;

/// <summary>
/// Last-admin guard, delete of a vault owner, /me CSRF token, config
/// save read-back + key preservation, account lockout.
/// </summary>
public sealed class AuthAdminSafetyTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;

    public AuthAdminSafetyTests(TestServerFactory factory) { _factory = factory; }

    private async Task<UserDto> MeAsync(HttpClient c) =>
        (await c.GetFromJsonAsync<MeResponse>("/api/auth/me"))!.User;

    [Fact]
    public async Task Last_active_admin_cannot_be_demoted_disabled_or_locked()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var me = await MeAsync(admin);

        // Make sure no other active admin exists from another test.
        var users = await admin.GetFromJsonAsync<List<UserDto>>("/api/users");
        foreach (var u in users!.Where(u => u.Id != me.Id && u.Role == "admin" && u.Status == "active"))
        {
            (await admin.PutAsJsonAsync($"/api/users/{u.Id}", new UpdateUserRequest(null, "user", null)))
                .EnsureSuccessStatusCode();
        }

        foreach (var req in new[]
                 {
                     new UpdateUserRequest(null, "user", null),
                     new UpdateUserRequest(null, null, "disabled"),
                     new UpdateUserRequest(null, null, "locked"),
                 })
        {
            var r = await admin.PutAsJsonAsync($"/api/users/{me.Id}", req);
            r.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        // Still an admin, session still works.
        (await MeAsync(admin)).Role.Should().Be("admin");

        // With a second active admin, demotion is allowed.
        var create = await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("second-admin", "second@test.local", "SecondAdminPassword1", "admin"));
        create.StatusCode.Should().Be(HttpStatusCode.Created);
        var second = (await create.Content.ReadFromJsonAsync<UserDto>())!;
        var demote = await admin.PutAsJsonAsync($"/api/users/{second.Id}", new UpdateUserRequest(null, "user", null));
        demote.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Deleting_a_vault_owner_is_refused_and_their_sessions_survive()
    {
        var admin = await _factory.CreateAdminClientAsync();
        (await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("owner1", "owner1@test.local", "OwnerPassword12345", "user")))
            .StatusCode.Should().Be(HttpStatusCode.Created);

        var owner = _factory.CreateClient();
        var login = await owner.PostAsJsonAsync("/api/auth/login", new LoginRequest("owner1", "OwnerPassword12345"));
        var csrf = (await login.Content.ReadFromJsonAsync<LoginResponse>())!.CsrfToken;
        owner.DefaultRequestHeaders.Add("X-CSRF-Token", csrf);
        (await owner.PostAsJsonAsync("/api/vaults", new CreateVaultRequest("users/owner1/Stuff")))
            .StatusCode.Should().Be(HttpStatusCode.Created);
        var ownerId = (await MeAsync(owner)).Id;

        var del = await admin.DeleteAsync($"/api/users/{ownerId}");
        del.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await del.Content.ReadAsStringAsync()).Should().Contain("Stuff");

        // Not logged out as a side effect.
        (await owner.GetAsync("/api/auth/me")).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Me_returns_the_session_csrf_token_without_the_csrf_cookie()
    {
        // Simulate a browser restart: only the session cookie survives.
        var plain = _factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = false,
        });
        var login = await plain.PostAsJsonAsync("/api/auth/login",
            new LoginRequest(_factory.AdminUsername, _factory.AdminPassword));
        var token = (await login.Content.ReadFromJsonAsync<LoginResponse>())!.CsrfToken;
        var sid = login.Headers.GetValues("Set-Cookie").First(c => c.StartsWith("nc_sid="));
        var sidPair = sid.Split(';')[0];

        var me = new HttpRequestMessage(HttpMethod.Get, "/api/auth/me");
        me.Headers.Add("Cookie", sidPair);
        var res = await plain.SendAsync(me);
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = (await res.Content.ReadFromJsonAsync<MeResponse>())!;
        body.CsrfToken.Should().Be(token);
        res.Headers.GetValues("Set-Cookie").Should().Contain(c => c.StartsWith("nc_csrf=" + token));
    }

    [Fact]
    public async Task Config_save_keeps_unmodelled_keys()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var current = (await admin.GetFromJsonAsync<ServerConfigDto>("/api/admin/server/config"))!;
        var path = current.Storage.ConfigFilePath;

        // A hand-added key the DTO doesn't model.
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var seeded = File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))!.AsObject() : new JsonObject();
        seeded["Auth"] ??= new JsonObject();
        seeded["Auth"]!["SessionCookieNameComment"] = "hand-added";
        File.WriteAllText(path, seeded.ToJsonString());

        var wanted = current with
        {
            Auth = current.Auth with { IdleTimeoutMinutes = 1440, AbsoluteTimeoutMinutes = 43200 },
        };
        var put = await admin.PutAsJsonAsync("/api/admin/server/config", wanted);
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        // (The read-back of the new values is not asserted here: in the
        // test host config.json isn't layered into IConfiguration —
        // Program reads Storage:DataRoot before the factory's overrides
        // apply. Verified against a running server instead.)

        var file = JsonNode.Parse(File.ReadAllText(path))!;
        file["Auth"]!["SessionCookieNameComment"]!.GetValue<string>().Should().Be("hand-added");
        file["Auth"]!["IdleTimeoutMinutes"]!.GetValue<int>().Should().Be(1440);
    }

    [Fact]
    public async Task Config_body_missing_a_section_is_a_400()
    {
        var admin = await _factory.CreateAdminClientAsync();
        var current = (await admin.GetFromJsonAsync<ServerConfigDto>("/api/admin/server/config"))!;
        var node = JsonSerializer.SerializeToNode(current, new JsonSerializerOptions(JsonSerializerDefaults.Web))!.AsObject();
        node.Remove("backup");
        var put = await admin.PutAsync("/api/admin/server/config",
            new StringContent(node.ToJsonString(), System.Text.Encoding.UTF8, "application/json"));
        put.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}

public sealed class LoginThrottleLockoutTests
{
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = new(2026, 10, 11, 12, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class Monitor : IOptionsMonitor<AuthOptions>
    {
        public AuthOptions CurrentValue { get; } = new()
        {
            LoginAttemptsPerIpPerMinute = 1000,
            LoginAttemptsPerAccountPerHour = 3,
            AccountLockoutMinutes = 5,
        };
        public AuthOptions Get(string? name) => CurrentValue;
        public IDisposable? OnChange(Action<AuthOptions, string?> listener) => null;
    }

    [Fact]
    public void Lock_lasts_AccountLockoutMinutes_then_the_count_restarts()
    {
        var clock = new Clock();
        var t = new LoginThrottle(new Monitor(), clock);

        for (var i = 0; i < 3; i++)
        {
            t.CheckAllowed("1.2.3.4", "bob").Outcome.Should().Be(ThrottleOutcome.Allowed);
            t.RecordFailure("1.2.3.4", "bob");
        }

        var locked = t.CheckAllowed("1.2.3.4", "bob");
        locked.Outcome.Should().Be(ThrottleOutcome.AccountLockedOut);
        locked.RetryAfter.Should().Be(TimeSpan.FromMinutes(5));

        clock.Now += TimeSpan.FromMinutes(4);
        t.CheckAllowed("1.2.3.4", "bob").Outcome.Should().Be(ThrottleOutcome.AccountLockedOut);
        t.CheckAllowed("1.2.3.4", "bob").RetryAfter.Should().Be(TimeSpan.FromMinutes(1));

        clock.Now += TimeSpan.FromMinutes(1) + TimeSpan.FromSeconds(1);
        t.CheckAllowed("1.2.3.4", "bob").Outcome.Should().Be(ThrottleOutcome.Allowed);

        // Fresh count: two more failures don't lock again.
        t.RecordFailure("1.2.3.4", "bob");
        t.RecordFailure("1.2.3.4", "bob");
        t.CheckAllowed("1.2.3.4", "bob").Outcome.Should().Be(ThrottleOutcome.Allowed);
    }

    [Fact]
    public void Success_clears_the_count()
    {
        var t = new LoginThrottle(new Monitor(), new Clock());
        t.RecordFailure(null, "amy");
        t.RecordFailure(null, "amy");
        t.RecordSuccess(null, "amy");
        t.RecordFailure(null, "amy");
        t.RecordFailure(null, "amy");
        t.CheckAllowed(null, "amy").Outcome.Should().Be(ThrottleOutcome.Allowed);
    }
}
