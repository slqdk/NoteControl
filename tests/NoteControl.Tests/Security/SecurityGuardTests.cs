using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using NoteControl.Server.Startpage.Services;
using NoteControl.Shared.Vaults;
using NoteControl.Tests.Auth;
using Xunit;

namespace NoteControl.Tests.Security;

public sealed class OutboundAddressGuardTests
{
    [Theory]
    [InlineData("127.0.0.1", true)]
    [InlineData("127.8.9.10", true)]
    [InlineData("10.1.2.3", true)]
    [InlineData("172.16.0.1", true)]
    [InlineData("172.31.255.255", true)]
    [InlineData("172.32.0.1", false)]
    [InlineData("192.168.1.10", true)]
    [InlineData("169.254.169.254", true)]
    [InlineData("100.64.0.1", true)]
    [InlineData("0.0.0.0", true)]
    [InlineData("224.0.0.1", true)]
    [InlineData("255.255.255.255", true)]
    [InlineData("8.8.8.8", false)]
    [InlineData("93.184.216.34", false)]
    [InlineData("::1", true)]
    [InlineData("::", true)]
    [InlineData("fe80::1", true)]
    [InlineData("fd12:3456::1", true)]
    [InlineData("::ffff:127.0.0.1", true)]
    [InlineData("::ffff:192.168.0.5", true)]
    [InlineData("2002:c0a8:0101::1", true)]      // 6to4 of 192.168.1.1
    [InlineData("64:ff9b::a00:1", true)]         // NAT64 of 10.0.0.1
    [InlineData("2606:4700:4700::1111", false)]
    public void Classifies_addresses(string ip, bool blocked)
    {
        OutboundAddressGuard.IsBlocked(IPAddress.Parse(ip)).Should().Be(blocked);
    }

    [Theory]
    [InlineData("http://localhost/feed", true)]
    [InlineData("http://api.localhost/feed", true)]
    [InlineData("http://127.0.0.1:8080/x", true)]
    [InlineData("http://[::1]/x", true)]
    [InlineData("http://[::ffff:10.0.0.1]/x", true)]
    [InlineData("https://example.com/feed", false)]
    public void Flags_obviously_local_urls(string url, bool local)
    {
        OutboundAddressGuard.IsObviouslyLocal(new Uri(url)).Should().Be(local);
    }
}

public sealed class NestedVaultTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;
    public NestedVaultTests(TestServerFactory factory) { _factory = factory; }

    [Fact]
    public async Task Vaults_cannot_be_nested_or_case_duplicated()
    {
        var admin = await _factory.CreateAdminClientAsync();
        (await admin.PostAsJsonAsync("/api/vaults", new CreateVaultRequest("shared/Outer")))
            .StatusCode.Should().Be(HttpStatusCode.Created);

        var inner = await admin.PostAsJsonAsync("/api/vaults", new CreateVaultRequest("shared/Outer/Inner"));
        inner.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await inner.Content.ReadAsStringAsync()).Should().Contain("inside the existing vault");

        var caseTwin = await admin.PostAsJsonAsync("/api/vaults", new CreateVaultRequest("shared/outer"));
        caseTwin.StatusCode.Should().Be(HttpStatusCode.Conflict);

        (await admin.PostAsJsonAsync("/api/vaults", new CreateVaultRequest("users/admin/Deep/Child")))
            .StatusCode.Should().Be(HttpStatusCode.Created);
        var parent = await admin.PostAsJsonAsync("/api/vaults", new CreateVaultRequest("users/admin/Deep"));
        parent.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await parent.Content.ReadAsStringAsync()).Should().Contain("contains the existing vault");

        // A sibling sharing the name prefix is fine.
        (await admin.PostAsJsonAsync("/api/vaults", new CreateVaultRequest("shared/Outer-2")))
            .StatusCode.Should().Be(HttpStatusCode.Created);
    }
}
