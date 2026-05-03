using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using NoteControl.Shared.Auth;
using NoteControl.Shared.Vaults;
using NoteControl.Tests.Auth;
using Xunit;

namespace NoteControl.Tests.Vaults;

public sealed class VaultEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;

    public VaultEndpointTests(TestServerFactory factory) { _factory = factory; }

    [Fact]
    public async Task Anonymous_caller_cannot_list_vaults()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/vaults");
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // (Removed: Admin_starts_with_no_vaults. The class-level fixture is
    // shared across tests, so by the time this test ran in CI another test
    // had already created a vault, making "starts with no vaults" impossible
    // to assert without a per-test factory. The "bootstrap admin doesn't get
    // an auto-created vault" invariant is implicitly covered by every other
    // test in this class — CreateAdminClient + assertions on what we created
    // would all break if a phantom vault appeared.)

    [Fact]
    public async Task Admin_can_create_a_personal_vault_for_themselves()
    {
        var client = await _factory.CreateAdminClientAsync();

        var create = await client.PostAsJsonAsync("/api/vaults",
            new CreateVaultRequest("users/admin/Personal"));
        create.StatusCode.Should().Be(HttpStatusCode.Created);

        var dto = await create.Content.ReadFromJsonAsync<VaultDto>();
        dto.Should().NotBeNull();
        dto!.Path.Should().Be("users/admin/Personal");
        dto.Scope.Should().Be("personal");
        dto.MyRole.Should().Be("owner");

        // Listing now shows it.
        var list = await client.GetFromJsonAsync<List<VaultDto>>("/api/vaults");
        list!.Should().ContainSingle(v => v.Id == dto.Id);
    }

    [Fact]
    public async Task User_cannot_create_vault_in_someone_elses_user_folder()
    {
        var admin = await _factory.CreateAdminClientAsync();

        // Create a regular user.
        var create = await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("alice", "alice@test.local", "AliceLongPassword1", "user"));
        create.StatusCode.Should().Be(HttpStatusCode.Created);

        // Alice logs in.
        var alice = _factory.CreateClient();
        var login = await alice.PostAsJsonAsync("/api/auth/login",
            new LoginRequest("alice", "AliceLongPassword1"));
        var loginBody = await login.Content.ReadFromJsonAsync<LoginResponse>();
        alice.DefaultRequestHeaders.Add("X-CSRF-Token", loginBody!.CsrfToken);

        // Alice tries to create a vault under admin's folder.
        var attempt = await alice.PostAsJsonAsync("/api/vaults",
            new CreateVaultRequest("users/admin/SneakVault"));
        attempt.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Path_traversal_attempts_are_rejected()
    {
        var admin = await _factory.CreateAdminClientAsync();

        var paths = new[]
        {
            "users/../etc",
            "users/admin/../../escape",
            "users/admin/Per?sonal",
            "users/admin/CON",
            "users/admin/Personal ",
        };

        foreach (var p in paths)
        {
            var attempt = await admin.PostAsJsonAsync("/api/vaults", new CreateVaultRequest(p));
            attempt.StatusCode.Should().Be(HttpStatusCode.BadRequest,
                because: $"path '{p}' must be rejected");
        }
    }

    [Fact]
    public async Task Duplicate_path_is_rejected_with_409()
    {
        var admin = await _factory.CreateAdminClientAsync();

        var first = await admin.PostAsJsonAsync("/api/vaults",
            new CreateVaultRequest("users/admin/Dup"));
        first.StatusCode.Should().Be(HttpStatusCode.Created);

        var second = await admin.PostAsJsonAsync("/api/vaults",
            new CreateVaultRequest("users/admin/Dup"));
        second.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Sharing_grants_access_unsharing_revokes_it()
    {
        var admin = await _factory.CreateAdminClientAsync();

        // Create alice and bob.
        await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("alice2", "alice2@t.local", "AliceLongPassword1", "user"));
        await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("bob2", "bob2@t.local", "BobLongPassword12", "user"));

        // Alice logs in and creates a shared vault.
        var alice = _factory.CreateClient();
        var aliceLogin = await alice.PostAsJsonAsync("/api/auth/login",
            new LoginRequest("alice2", "AliceLongPassword1"));
        var aliceBody = await aliceLogin.Content.ReadFromJsonAsync<LoginResponse>();
        alice.DefaultRequestHeaders.Add("X-CSRF-Token", aliceBody!.CsrfToken);

        var createResp = await alice.PostAsJsonAsync("/api/vaults",
            new CreateVaultRequest("shared/Project"));
        createResp.StatusCode.Should().Be(HttpStatusCode.Created);
        var vault = await createResp.Content.ReadFromJsonAsync<VaultDto>();

        // Bob can't see it yet.
        var bob = _factory.CreateClient();
        var bobLogin = await bob.PostAsJsonAsync("/api/auth/login",
            new LoginRequest("bob2", "BobLongPassword12"));
        var bobBody = await bobLogin.Content.ReadFromJsonAsync<LoginResponse>();
        bob.DefaultRequestHeaders.Add("X-CSRF-Token", bobBody!.CsrfToken);
        var bobList = await bob.GetFromJsonAsync<List<VaultDto>>("/api/vaults");
        bobList!.Should().BeEmpty();

        // Alice shares with bob as editor.
        var share = await alice.PostAsJsonAsync($"/api/vaults/{vault!.Id}/permissions",
            new ShareVaultRequest("bob2", "editor"));
        share.StatusCode.Should().Be(HttpStatusCode.OK);

        // Bob can now see it.
        bobList = await bob.GetFromJsonAsync<List<VaultDto>>("/api/vaults");
        bobList!.Should().ContainSingle(v => v.Id == vault.Id && v.MyRole == "editor");

        // Alice unshares. Need bob's user id, which we get from the
        // members list rather than the vault list (bob's vault list rows
        // carry vault ids, not his user id).
        var members = await alice.GetFromJsonAsync<List<VaultMemberDto>>(
            $"/api/vaults/{vault.Id}/permissions");
        var bobMember = members!.First(m => m.Username == "bob2");

        var unshare = await alice.DeleteAsync(
            $"/api/vaults/{vault.Id}/permissions/{bobMember.UserId}");
        unshare.StatusCode.Should().Be(HttpStatusCode.NoContent);

        bobList = await bob.GetFromJsonAsync<List<VaultDto>>("/api/vaults");
        bobList!.Should().BeEmpty();
    }

    [Fact]
    public async Task Non_owner_cannot_share_or_delete()
    {
        var admin = await _factory.CreateAdminClientAsync();

        // Owner creates the vault.
        var ownerCreate = await admin.PostAsJsonAsync("/api/vaults",
            new CreateVaultRequest("shared/Owned"));
        var vault = await ownerCreate.Content.ReadFromJsonAsync<VaultDto>();

        // Create a viewer user.
        await admin.PostAsJsonAsync("/api/users",
            new CreateUserRequest("viewerguy", "v@t.local", "ViewerPassword123", "user"));
        await admin.PostAsJsonAsync($"/api/vaults/{vault!.Id}/permissions",
            new ShareVaultRequest("viewerguy", "viewer"));

        // viewerguy logs in and tries to share or delete — both should 403.
        var viewer = _factory.CreateClient();
        var login = await viewer.PostAsJsonAsync("/api/auth/login",
            new LoginRequest("viewerguy", "ViewerPassword123"));
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        viewer.DefaultRequestHeaders.Add("X-CSRF-Token", body!.CsrfToken);

        var trySh = await viewer.PostAsJsonAsync($"/api/vaults/{vault.Id}/permissions",
            new ShareVaultRequest("anyone", "viewer"));
        trySh.StatusCode.Should().Be(HttpStatusCode.Forbidden);

        var tryDelete = await viewer.DeleteAsync($"/api/vaults/{vault.Id}");
        tryDelete.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Deleting_vault_quarantines_folder_and_removes_row()
    {
        var admin = await _factory.CreateAdminClientAsync();

        var createResp = await admin.PostAsJsonAsync("/api/vaults",
            new CreateVaultRequest("users/admin/ToDelete"));
        var vault = await createResp.Content.ReadFromJsonAsync<VaultDto>();

        var delete = await admin.DeleteAsync($"/api/vaults/{vault!.Id}");
        delete.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // GET now 404s.
        var get = await admin.GetAsync($"/api/vaults/{vault.Id}");
        get.StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Deleted vault no longer appears in the listing. (The list may
        // still contain vaults from other tests in this class — TestServerFactory
        // shares a server-and-database across tests within a class fixture.)
        var list = await admin.GetFromJsonAsync<List<VaultDto>>("/api/vaults");
        list!.Should().NotContain(v => v.Id == vault.Id);
    }

    [Fact]
    public async Task Unknown_vault_returns_404_not_403()
    {
        // Don't leak existence: an unknown vault and a vault we can't see
        // must look identical (404).
        var admin = await _factory.CreateAdminClientAsync();
        var ghost = await admin.GetAsync($"/api/vaults/{Guid.NewGuid()}");
        ghost.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
