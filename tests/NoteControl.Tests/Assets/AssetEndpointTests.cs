using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using FluentAssertions;
using NoteControl.Shared.Assets;
using NoteControl.Shared.Notes;
using NoteControl.Shared.Vaults;
using NoteControl.Tests.Auth;
using Xunit;

namespace NoteControl.Tests.Assets;

public sealed class AssetEndpointTests : IClassFixture<TestServerFactory>
{
    private readonly TestServerFactory _factory;
    public AssetEndpointTests(TestServerFactory factory) { _factory = factory; }

    private async Task<(HttpClient Client, Guid VaultId)> AdminWithVaultAsync(string path)
    {
        var client = await _factory.CreateAdminClientAsync();
        var resp = await client.PostAsJsonAsync("/api/vaults", new CreateVaultRequest(path));
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        var dto = await resp.Content.ReadFromJsonAsync<VaultDto>();
        return (client, dto!.Id);
    }

    private static async Task CreateNoteAsync(HttpClient client, Guid vaultId, string path, string body)
    {
        var resp = await client.PostAsJsonAsync(
            $"/api/vaults/{vaultId}/note",
            new CreateNoteRequest(path, body));
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
    }

    private static async Task<HttpResponseMessage> UploadAsync(
        HttpClient client,
        Guid vaultId,
        string notePath,
        string fileName,
        string contentType,
        byte[] bytes)
    {
        using var form = new MultipartFormDataContent();
        form.Add(new StringContent(notePath), "notePath");
        var fileContent = new ByteArrayContent(bytes);
        fileContent.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        form.Add(fileContent, "file", fileName);
        return await client.PostAsync($"/api/vaults/{vaultId}/note/asset", form);
    }

    [Fact]
    public async Task Upload_creates_assets_folder_next_to_note()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/AssetA");
        await CreateNoteAsync(client, vaultId, "Plan.md", "body");

        var bytes = Encoding.UTF8.GetBytes("fake-png-content");
        var resp = await UploadAsync(client, vaultId, "Plan.md", "photo.png", "image/png", bytes);
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        var dto = await resp.Content.ReadFromJsonAsync<AssetUploadResponse>();
        dto!.RelativeMarkdownPath.Should().Be("Plan.assets/photo.png");
        dto.StoredFileName.Should().Be("photo.png");
        dto.ServeUrl.Should().Contain($"/api/vaults/{vaultId}/asset");
        dto.ServeUrl.Should().Contain("Plan.assets%2Fphoto.png");
    }

    [Fact]
    public async Task Upload_collision_appends_suffix()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/AssetB");
        await CreateNoteAsync(client, vaultId, "Plan.md", "x");

        var bytes = Encoding.UTF8.GetBytes("first");
        var first = await UploadAsync(client, vaultId, "Plan.md", "image.png", "image/png", bytes);
        first.StatusCode.Should().Be(HttpStatusCode.OK);
        var firstDto = await first.Content.ReadFromJsonAsync<AssetUploadResponse>();
        firstDto!.StoredFileName.Should().Be("image.png");

        var second = await UploadAsync(client, vaultId, "Plan.md", "image.png", "image/png", Encoding.UTF8.GetBytes("second"));
        second.StatusCode.Should().Be(HttpStatusCode.OK);
        var secondDto = await second.Content.ReadFromJsonAsync<AssetUploadResponse>();
        secondDto!.StoredFileName.Should().Be("image-2.png");

        var third = await UploadAsync(client, vaultId, "Plan.md", "image.png", "image/png", Encoding.UTF8.GetBytes("third"));
        third.StatusCode.Should().Be(HttpStatusCode.OK);
        var thirdDto = await third.Content.ReadFromJsonAsync<AssetUploadResponse>();
        thirdDto!.StoredFileName.Should().Be("image-3.png");
    }

    [Fact]
    public async Task Get_returns_uploaded_bytes()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/AssetC");
        await CreateNoteAsync(client, vaultId, "Plan.md", "x");

        var bytes = Enumerable.Range(0, 256).Select(i => (byte)i).ToArray();
        var upload = await UploadAsync(client, vaultId, "Plan.md", "data.bin", "application/octet-stream", bytes);
        upload.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await upload.Content.ReadFromJsonAsync<AssetUploadResponse>();

        var get = await client.GetAsync(dto!.ServeUrl);
        get.StatusCode.Should().Be(HttpStatusCode.OK);
        var fetched = await get.Content.ReadAsByteArrayAsync();
        fetched.Should().Equal(bytes);
    }

    [Fact]
    public async Task Get_returns_404_for_missing_asset()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/AssetD");

        var get = await client.GetAsync(
            $"/api/vaults/{vaultId}/asset?path={Uri.EscapeDataString("Ghost.assets/nope.png")}");
        get.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Get_rejects_paths_outside_assets_convention()
    {
        // The serve endpoint should refuse to read the note .md file
        // itself or any other vault file that isn't under a .assets/
        // subfolder. Defence in depth — even though canonicalisation
        // already blocks .. traversal.
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/AssetE");
        await CreateNoteAsync(client, vaultId, "Plan.md", "x");

        var get = await client.GetAsync(
            $"/api/vaults/{vaultId}/asset?path={Uri.EscapeDataString("Plan.md")}");
        get.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Upload_to_nonexistent_note_returns_404()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/AssetF");

        var resp = await UploadAsync(
            client, vaultId, "DoesNotExist.md", "x.png", "image/png",
            Encoding.UTF8.GetBytes("data"));
        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Note_rename_moves_assets_folder_with_it()
    {
        var (client, vaultId) = await AdminWithVaultAsync("users/admin/AssetG");
        await CreateNoteAsync(client, vaultId, "OldName.md", "x");

        var upload = await UploadAsync(client, vaultId, "OldName.md", "p.png", "image/png", Encoding.UTF8.GetBytes("d"));
        upload.StatusCode.Should().Be(HttpStatusCode.OK);

        // Rename note.
        var move = await client.PutAsJsonAsync(
            $"/api/vaults/{vaultId}/note/move",
            new MoveNoteRequest("OldName.md", "NewName.md"));
        move.StatusCode.Should().Be(HttpStatusCode.OK);

        // Old assets path should 404. New assets path should serve.
        var oldGet = await client.GetAsync(
            $"/api/vaults/{vaultId}/asset?path={Uri.EscapeDataString("OldName.assets/p.png")}");
        oldGet.StatusCode.Should().Be(HttpStatusCode.NotFound);

        var newGet = await client.GetAsync(
            $"/api/vaults/{vaultId}/asset?path={Uri.EscapeDataString("NewName.assets/p.png")}");
        newGet.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Anonymous_upload_returns_401()
    {
        // Get a real vault first, then try uploading from an
        // un-authenticated client.
        var (_, vaultId) = await AdminWithVaultAsync("users/admin/AssetH");
        var anon = _factory.CreateClient();

        var resp = await UploadAsync(anon, vaultId, "x.md", "y.png", "image/png", Encoding.UTF8.GetBytes("data"));
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
