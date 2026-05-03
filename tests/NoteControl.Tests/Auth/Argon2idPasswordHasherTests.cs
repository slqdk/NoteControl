using FluentAssertions;
using NoteControl.Server.Auth.Services;
using Xunit;

namespace NoteControl.Tests.Auth;

public sealed class Argon2idPasswordHasherTests
{
    private readonly Argon2idPasswordHasher _hasher = new();

    [Fact]
    public void Verify_returns_true_for_correct_password()
    {
        var hash = _hasher.Hash("correct horse battery staple");
        _hasher.Verify("correct horse battery staple", hash).Should().BeTrue();
    }

    [Fact]
    public void Verify_returns_false_for_wrong_password()
    {
        var hash = _hasher.Hash("correct horse battery staple");
        _hasher.Verify("Correct Horse Battery Staple", hash).Should().BeFalse();
    }

    [Fact]
    public void Verify_returns_false_for_empty_password()
    {
        var hash = _hasher.Hash("anything");
        _hasher.Verify("", hash).Should().BeFalse();
    }

    [Fact]
    public void Verify_returns_false_for_garbage_hash()
    {
        _hasher.Verify("password", "not a valid hash").Should().BeFalse();
        _hasher.Verify("password", "$argon2id$wrong-format").Should().BeFalse();
        _hasher.Verify("password", "").Should().BeFalse();
    }

    [Fact]
    public void Hash_produces_phc_format()
    {
        var hash = _hasher.Hash("hunter2hunter2hunter2");
        hash.Should().StartWith("$argon2id$v=19$");
        hash.Split('$').Should().HaveCount(6);
    }

    [Fact]
    public void Two_hashes_of_same_password_differ()
    {
        // Different salts each time.
        var a = _hasher.Hash("samepassword");
        var b = _hasher.Hash("samepassword");
        a.Should().NotBe(b);
        _hasher.Verify("samepassword", a).Should().BeTrue();
        _hasher.Verify("samepassword", b).Should().BeTrue();
    }

    [Fact]
    public void NeedsRehash_false_for_current_parameters()
    {
        var hash = _hasher.Hash("anything goes here");
        _hasher.NeedsRehash(hash).Should().BeFalse();
    }

    [Fact]
    public void NeedsRehash_true_for_weaker_parameters()
    {
        // Hash produced with iterations=1 (below the default of 3).
        // We construct it directly so we don't depend on internals — but we
        // do need a real hash, so we use a known weak parameter set.
        var weak = "$argon2id$v=19$m=1024,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        _hasher.NeedsRehash(weak).Should().BeTrue();
    }
}
