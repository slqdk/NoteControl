using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using NoteControl.Shared.Auth;

namespace NoteControl.Tests.Auth;

/// <summary>
/// Spins up a real server backed by a per-test temp data directory, so each
/// test gets a clean SQLite database and a fresh bootstrap admin.
/// </summary>
public sealed class TestServerFactory : WebApplicationFactory<Program>, IDisposable
{
    private readonly string _tempRoot;

    public string AdminUsername { get; }
    public string AdminPassword { get; }

    public TestServerFactory()
    {
        _tempRoot = Path.Combine(Path.GetTempPath(), "notecontrol-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tempRoot);

        // Strong, unique per-fixture so the bootstrap admin password is known
        // to the tests but never reused across instances.
        AdminUsername = "admin";
        AdminPassword = "TestPassword!" + Guid.NewGuid().ToString("N")[..16];
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureAppConfiguration((_, cfg) =>
        {
            cfg.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Storage:DataRoot"] = _tempRoot,
                ["Auth:RequireSecureCookies"] = "false",
                ["Auth:CheckPasswordAgainstHibp"] = "false",
                // Generous limits so legitimate test traffic isn't throttled.
                ["Auth:LoginAttemptsPerIpPerMinute"] = "100",
                ["Auth:LoginAttemptsPerAccountPerHour"] = "100",
                ["Auth:BootstrapAdmin:Username"] = AdminUsername,
                ["Auth:BootstrapAdmin:Email"] = "admin@test.local",
                ["Auth:BootstrapAdmin:Password"] = AdminPassword,
            });
        });
    }

    /// <summary>
    /// Convenience: returns a logged-in HttpClient for the bootstrap admin,
    /// already carrying the session cookie and a default CSRF header.
    /// </summary>
    public async Task<HttpClient> CreateAdminClientAsync()
    {
        var client = CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/login",
            new LoginRequest(AdminUsername, AdminPassword));

        response.StatusCode.Should().Be(HttpStatusCode.OK,
            "test fixture must be able to log in as the seeded admin");

        var body = await response.Content.ReadFromJsonAsync<LoginResponse>();
        body!.CsrfToken.Should().NotBeNullOrEmpty();

        // The cookie container on the client already has nc_sid and nc_csrf
        // because WebApplicationFactory's HttpClient honours Set-Cookie.
        client.DefaultRequestHeaders.Add("X-CSRF-Token", body.CsrfToken);
        return client;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing)
        {
            try { Directory.Delete(_tempRoot, recursive: true); }
            catch { /* best-effort */ }
        }
    }
}
