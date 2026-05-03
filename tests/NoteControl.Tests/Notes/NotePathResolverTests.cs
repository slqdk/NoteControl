using FluentAssertions;
using NoteControl.Server.Notes.Services;
using Xunit;

namespace NoteControl.Tests.Notes;

public sealed class NotePathResolverTests : IDisposable
{
    private readonly string _vaultRoot;
    private readonly NotePathResolver _resolver = new();

    public NotePathResolverTests()
    {
        _vaultRoot = Path.Combine(Path.GetTempPath(), "ncl-nptests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_vaultRoot);
    }

    [Theory]
    [InlineData("note.md", "note.md")]
    [InlineData("/note.md/", "note.md")]
    [InlineData("Projects\\plan.md", "Projects/plan.md")]
    [InlineData("Projects//plan.md", "Projects/plan.md")]
    [InlineData("Daily Notes/2026/04/2026-04-26.md", "Daily Notes/2026/04/2026-04-26.md")]
    public void Canonicalize_normalizes_well_formed_paths(string input, string expected)
    {
        _resolver.CanonicalizeNote(input).Should().Be(expected);
    }

    [Theory]
    [InlineData("note.txt")]
    [InlineData("Projects/plan")]
    [InlineData("")]
    public void Canonicalize_rejects_paths_without_md_extension(string input)
    {
        Assert.Throws<InvalidNotePathException>(() => _resolver.CanonicalizeNote(input));
    }

    [Theory]
    [InlineData("../escape.md")]
    [InlineData("Projects/../../escape.md")]
    [InlineData("./hidden.md")]
    public void Canonicalize_rejects_traversal(string input)
    {
        Assert.Throws<InvalidNotePathException>(() => _resolver.CanonicalizeNote(input));
    }

    [Theory]
    [InlineData(".notesapp/index.db.md")]
    [InlineData(".notesapp/anything.md")]
    public void Canonicalize_rejects_paths_into_notesapp_folder(string input)
    {
        Assert.Throws<InvalidNotePathException>(() => _resolver.CanonicalizeNote(input));
    }

    [Theory]
    [InlineData("CON.md")]
    [InlineData("AUX.md")]
    [InlineData("COM1.md")]
    [InlineData("Projects/LPT9.md")]
    public void Canonicalize_rejects_windows_reserved_names(string input)
    {
        Assert.Throws<InvalidNotePathException>(() => _resolver.CanonicalizeNote(input));
    }

    [Theory]
    [InlineData("Projects/plan?.md")]
    [InlineData("Projects/plan|note.md")]
    [InlineData("Projects/plan\"x.md")]
    public void Canonicalize_rejects_invalid_chars(string input)
    {
        Assert.Throws<InvalidNotePathException>(() => _resolver.CanonicalizeNote(input));
    }

    [Fact]
    public void Resolve_produces_path_under_vault_root()
    {
        var resolved = _resolver.Resolve(_vaultRoot, "Projects/plan.md");
        resolved.Should().StartWith(_vaultRoot);
        resolved.Should().EndWith(Path.Combine("Projects", "plan.md"));
    }

    [Fact]
    public void Resolve_blocks_paths_escaping_the_vault_root()
    {
        Assert.Throws<InvalidNotePathException>(
            () => _resolver.Resolve(_vaultRoot, "../escape.md"));
    }

    [Fact]
    public void CanonicalizeFolder_accepts_empty_path()
    {
        _resolver.CanonicalizeFolder("").Should().Be("");
        _resolver.CanonicalizeFolder("/").Should().Be("");
        _resolver.CanonicalizeFolder(null!).Should().Be("");
    }

    [Fact]
    public void ResolveFolder_returns_vault_root_for_empty_path()
    {
        var resolved = _resolver.ResolveFolder(_vaultRoot, "");
        resolved.Should().Be(Path.GetFullPath(_vaultRoot));
    }

    public void Dispose()
    {
        try { Directory.Delete(_vaultRoot, recursive: true); } catch { }
    }
}
