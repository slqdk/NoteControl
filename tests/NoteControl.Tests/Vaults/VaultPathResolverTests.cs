using FluentAssertions;
using Microsoft.Extensions.Options;
using NoteControl.Server.Options;
using NoteControl.Server.Vaults.Services;
using Xunit;

namespace NoteControl.Tests.Vaults;

public sealed class VaultPathResolverTests : IDisposable
{
    private readonly string _dataRoot;
    private readonly VaultPathResolver _resolver;

    public VaultPathResolverTests()
    {
        // Use a real temp folder so Path.GetFullPath actually has something
        // to canonicalize against. The folder doesn't need to exist for
        // resolution; we only create it so cleanup is hygienic.
        _dataRoot = Path.Combine(Path.GetTempPath(), "ncl-vptests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dataRoot);

        _resolver = new VaultPathResolver(Options.Create(new StorageOptions { DataRoot = _dataRoot }));
    }

    // -------------------------------------------------------------
    // Canonicalize
    // -------------------------------------------------------------

    [Theory]
    [InlineData("users/alice/Personal", "users/alice/Personal")]
    [InlineData("/users/alice/Personal/", "users/alice/Personal")]
    [InlineData("users\\alice\\Personal", "users/alice/Personal")]
    [InlineData("users//alice///Personal", "users/alice/Personal")]
    [InlineData("shared/Household", "shared/Household")]
    public void Canonicalize_normalizes_well_formed_paths(string input, string expected)
    {
        _resolver.Canonicalize(input).Should().Be(expected);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("/")]
    [InlineData("///")]
    [InlineData("users")]              // single segment — not enough
    [InlineData("shared")]
    public void Canonicalize_rejects_empty_or_too_short(string input)
    {
        Assert.Throws<InvalidVaultPathException>(() => _resolver.Canonicalize(input));
    }

    [Theory]
    [InlineData("users/../etc")]
    [InlineData("users/alice/../bob")]
    [InlineData("../escape")]
    [InlineData("./hidden/Personal")]
    [InlineData("users/./Personal")]
    public void Canonicalize_rejects_traversal_segments(string input)
    {
        Assert.Throws<InvalidVaultPathException>(() => _resolver.Canonicalize(input));
    }

    [Theory]
    [InlineData("users/alice/Pers<onal")]
    [InlineData("users/alice/Per\"sonal")]
    [InlineData("users/alice/Per|sonal")]
    [InlineData("users/alice/Per?sonal")]
    [InlineData("users/alice/Per*sonal")]
    [InlineData("users/alice/Per:sonal")]
    public void Canonicalize_rejects_invalid_windows_chars(string input)
    {
        Assert.Throws<InvalidVaultPathException>(() => _resolver.Canonicalize(input));
    }

    [Theory]
    [InlineData("users/alice/CON")]
    [InlineData("users/alice/AUX")]
    [InlineData("users/alice/COM1")]
    [InlineData("users/alice/LPT9")]
    [InlineData("users/alice/con")]   // case-insensitive
    [InlineData("users/alice/Aux.txt")]   // bare name still reserved
    public void Canonicalize_rejects_windows_reserved_names(string input)
    {
        Assert.Throws<InvalidVaultPathException>(() => _resolver.Canonicalize(input));
    }

    [Theory]
    [InlineData("users/alice/Personal ")]   // trailing space
    [InlineData("users/alice/Personal.")]   // trailing dot
    [InlineData("users/alice/ Personal")]   // leading space
    public void Canonicalize_rejects_trailing_space_or_dot_and_leading_space(string input)
    {
        Assert.Throws<InvalidVaultPathException>(() => _resolver.Canonicalize(input));
    }

    // -------------------------------------------------------------
    // Resolve
    // -------------------------------------------------------------

    [Fact]
    public void Resolve_produces_path_under_data_root()
    {
        var resolved = _resolver.Resolve("users/alice/Personal");
        resolved.Should().StartWith(_dataRoot);
        resolved.Should().EndWith(Path.Combine("users", "alice", "Personal"));
    }

    [Fact]
    public void Resolve_rejects_traversal_attempts_robustly()
    {
        // Even if Canonicalize were bypassed, the under-root re-check should
        // catch escape attempts. Construct a path that *only* via the
        // raw form would escape.
        Assert.Throws<InvalidVaultPathException>(
            () => _resolver.Resolve("users/../../etc/passwd"));
    }

    // -------------------------------------------------------------
    // ResolveForCreate
    // -------------------------------------------------------------

    [Fact]
    public void ResolveForCreate_personal_accepts_own_user_folder()
    {
        var resolved = _resolver.ResolveForCreate("users/alice/Personal", "alice", "personal");
        resolved.Should().StartWith(_dataRoot);
    }

    [Fact]
    public void ResolveForCreate_personal_is_case_insensitive_on_username()
    {
        // Username comparison is OrdinalIgnoreCase to match the user table.
        var resolved = _resolver.ResolveForCreate("users/Alice/Personal", "alice", "personal");
        resolved.Should().StartWith(_dataRoot);
    }

    [Fact]
    public void ResolveForCreate_personal_rejects_other_users_folder()
    {
        Assert.Throws<InvalidVaultPathException>(
            () => _resolver.ResolveForCreate("users/bob/Personal", "alice", "personal"));
    }

    [Fact]
    public void ResolveForCreate_personal_rejects_shared_path()
    {
        Assert.Throws<InvalidVaultPathException>(
            () => _resolver.ResolveForCreate("shared/Household", "alice", "personal"));
    }

    [Fact]
    public void ResolveForCreate_shared_accepts_shared_path()
    {
        var resolved = _resolver.ResolveForCreate("shared/Household", "alice", "shared");
        resolved.Should().StartWith(_dataRoot);
    }

    [Fact]
    public void ResolveForCreate_shared_rejects_personal_path()
    {
        Assert.Throws<InvalidVaultPathException>(
            () => _resolver.ResolveForCreate("users/alice/Personal", "alice", "shared"));
    }

    [Fact]
    public void ResolveForCreate_unknown_scope_is_rejected()
    {
        Assert.Throws<InvalidVaultPathException>(
            () => _resolver.ResolveForCreate("users/alice/Personal", "alice", "invalid"));
    }

    public void Dispose()
    {
        try { Directory.Delete(_dataRoot, recursive: true); }
        catch { /* best-effort */ }
    }
}
