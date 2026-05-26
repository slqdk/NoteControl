using FluentAssertions;
using NoteControl.Server.Notes.Frontmatter;
using Xunit;

namespace NoteControl.Tests.Notes;

public sealed class FrontmatterCodecTests
{
    [Fact]
    public void Split_handles_file_without_frontmatter()
    {
        var (fm, body) = FrontmatterCodec.Split("# Just a heading\n\nSome body text.");
        fm.Tags.Should().BeEmpty();
        fm.Created.Should().BeNull();
        body.Should().StartWith("# Just a heading");
    }

    [Fact]
    public void Split_extracts_known_fields()
    {
        const string input = """
            ---
            created: 2026-04-20T10:30:00Z
            updated: 2026-04-24T14:15:00Z
            tags: [planning, work]
            locked: false
            ---

            # Q2 Planning

            Some body text.
            """;

        var (fm, body) = FrontmatterCodec.Split(input);
        fm.Created!.Value.Should().Be(new DateTimeOffset(2026, 4, 20, 10, 30, 0, TimeSpan.Zero));
        fm.Updated!.Value.Should().Be(new DateTimeOffset(2026, 4, 24, 14, 15, 0, TimeSpan.Zero));
        fm.Tags.Should().Equal("planning", "work");
        fm.Locked.Should().BeFalse();
        body.Should().StartWith("# Q2 Planning");
    }

    [Fact]
    public void Split_preserves_unknown_fields_in_extra()
    {
        const string input = """
            ---
            tags: []
            locked: false
            author: Jane Smith
            status: draft
            ---

            Body.
            """;

        var (fm, _) = FrontmatterCodec.Split(input);
        fm.Extra.Should().ContainKey("author");
        fm.Extra.Should().ContainKey("status");
        fm.Extra["author"].Should().Be("Jane Smith");
        fm.Extra["status"].Should().Be("draft");
    }

    [Fact]
    public void Combine_emits_canonical_frontmatter_block()
    {
        var fm = new ParsedFrontmatter
        {
            Created = new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.Zero),
            Updated = new DateTimeOffset(2026, 4, 26, 12, 0, 0, TimeSpan.Zero),
            Tags = new List<string> { "alpha", "beta" },
            Locked = true,
        };
        var output = FrontmatterCodec.Combine(fm, "Some body.");
        output.Should().StartWith("---\n");
        output.Should().Contain("created: 2026-01-02T03:04:05Z");
        output.Should().Contain("updated: 2026-04-26T12:00:00Z");
        output.Should().Contain("locked: true");
        output.Should().Contain("Some body.");
    }

    [Fact]
    public void Roundtrip_preserves_known_fields()
    {
        var original = new ParsedFrontmatter
        {
            Created = new DateTimeOffset(2026, 4, 1, 9, 0, 0, TimeSpan.Zero),
            Updated = new DateTimeOffset(2026, 4, 2, 9, 0, 0, TimeSpan.Zero),
            Tags = new List<string> { "x", "y" },
            Locked = true,
        };
        var combined = FrontmatterCodec.Combine(original, "Body content.");
        var (parsed, body) = FrontmatterCodec.Split(combined);

        parsed.Created.Should().Be(original.Created);
        parsed.Updated.Should().Be(original.Updated);
        parsed.Tags.Should().Equal(original.Tags);
        parsed.Locked.Should().BeTrue();
        body.Trim().Should().Be("Body content.");
    }

    [Fact]
    public void Roundtrip_preserves_unknown_string_field()
    {
        const string input = """
            ---
            tags: []
            locked: false
            author: Jane
            ---

            Body.
            """;
        var (fm, body) = FrontmatterCodec.Split(input);
        var combined = FrontmatterCodec.Combine(fm, body);
        var (reparsed, _) = FrontmatterCodec.Split(combined);

        reparsed.Extra.Should().ContainKey("author");
        reparsed.Extra["author"].Should().NotBeNull();
    }

    [Fact]
    public void Malformed_yaml_yields_empty_frontmatter_but_keeps_body()
    {
        const string input = """
            ---
            this: is
              broken yaml: [unclosed
            ---

            But the body should survive.
            """;
        var (fm, body) = FrontmatterCodec.Split(input);
        fm.Tags.Should().BeEmpty();
        body.Should().Contain("But the body should survive.");
    }

    [Fact]
    public void ApplyUpdate_sets_created_only_if_missing_and_always_bumps_updated()
    {
        var fm = new ParsedFrontmatter();
        var t1 = new DateTimeOffset(2026, 4, 1, 0, 0, 0, TimeSpan.Zero);
        var t2 = new DateTimeOffset(2026, 4, 2, 0, 0, 0, TimeSpan.Zero);

        FrontmatterCodec.ApplyUpdate(fm, t1, newTags: null, newLocked: null);
        fm.Created.Should().Be(t1);
        fm.Updated.Should().Be(t1);

        FrontmatterCodec.ApplyUpdate(fm, t2, newTags: null, newLocked: null);
        fm.Created.Should().Be(t1, "Created must not be overwritten");
        fm.Updated.Should().Be(t2);
    }

    [Fact]
    public void Body_uses_LF_line_endings_after_combine()
    {
        var fm = new ParsedFrontmatter { Tags = new List<string> { "x" } };
        var body = "line1\r\nline2\r\nline3";
        var combined = FrontmatterCodec.Combine(fm, body);
        combined.Should().NotContain("\r");
    }

    // -------------------------------------------------------------
    // Versioning: major.minor + lifecycle state
    // -------------------------------------------------------------

    [Fact]
    public void Split_defaults_to_zero_and_not_versioned_without_version_key()
    {
        const string input = """
            ---
            tags: []
            locked: false
            ---

            Body.
            """;
        var (fm, _) = FrontmatterCodec.Split(input);
        fm.VersionMajor.Should().Be(0);
        fm.VersionMinor.Should().Be(0);
        fm.State.Should().Be(FrontmatterCodec.StateNotVersioned);
        fm.Version.Should().Be("0.0");
    }

    [Fact]
    public void Split_parses_bare_major_minor_and_defaults_state_to_development()
    {
        const string input = """
            ---
            tags: []
            locked: false
            version: 1.2
            ---

            Body.
            """;
        var (fm, _) = FrontmatterCodec.Split(input);
        fm.VersionMajor.Should().Be(1);
        fm.VersionMinor.Should().Be(2);
        // No `state` key, but version > 0.0 -> development.
        fm.State.Should().Be(FrontmatterCodec.StateDevelopment);
    }

    [Theory]
    [InlineData("v0.1", 0, 1)]   // legacy Ship-68 prefix form
    [InlineData("1", 1, 0)]      // missing minor
    [InlineData("1.2.3-rc1", 1, 2)] // extra components ignored
    [InlineData("draft", 0, 0)]  // junk -> zero
    public void Split_parses_legacy_and_messy_versions(string raw, int major, int minor)
    {
        var input = $"---\ntags: []\nlocked: false\nversion: {raw}\n---\n\nBody.\n";
        var (fm, _) = FrontmatterCodec.Split(input);
        fm.VersionMajor.Should().Be(major);
        fm.VersionMinor.Should().Be(minor);
    }

    [Fact]
    public void Split_reads_released_state_at_one_zero()
    {
        const string input = """
            ---
            tags: []
            locked: false
            version: 1.0
            state: released
            ---

            Body.
            """;
        var (fm, _) = FrontmatterCodec.Split(input);
        fm.State.Should().Be(FrontmatterCodec.StateReleased);
    }

    [Fact]
    public void Split_clamps_released_below_one_zero_to_development()
    {
        // Inconsistent on-disk data: released at 0.5 is impossible.
        const string input = """
            ---
            tags: []
            locked: false
            version: 0.5
            state: released
            ---

            Body.
            """;
        var (fm, _) = FrontmatterCodec.Split(input);
        fm.State.Should().Be(FrontmatterCodec.StateDevelopment);
    }

    [Fact]
    public void Combine_emits_bare_version_and_no_state_when_unversioned()
    {
        var fm = new ParsedFrontmatter { Tags = new List<string>(), Locked = false };
        var output = FrontmatterCodec.Combine(fm, "Body.");
        output.Should().Contain("version: 0.0");
        output.Should().NotContain("state:");
    }

    [Fact]
    public void Combine_emits_state_when_versioned()
    {
        var fm = new ParsedFrontmatter
        {
            Tags = new List<string>(),
            Locked = false,
            VersionMajor = 2,
            VersionMinor = 0,
            State = FrontmatterCodec.StateReleased,
        };
        var output = FrontmatterCodec.Combine(fm, "Body.");
        output.Should().Contain("version: 2.0");
        output.Should().Contain("state: released");
    }

    [Fact]
    public void ApplyUpdate_sets_version_and_defaults_state_to_development()
    {
        var fm = new ParsedFrontmatter();
        var now = DateTimeOffset.UtcNow;

        FrontmatterCodec.ApplyUpdate(
            fm, now, newTags: null, newLocked: null, newMajor: 2, newMinor: 0);
        fm.VersionMajor.Should().Be(2);
        fm.VersionMinor.Should().Be(0);
        fm.State.Should().Be(FrontmatterCodec.StateDevelopment);
    }

    [Fact]
    public void ApplyUpdate_leaves_version_alone_when_null()
    {
        var fm = new ParsedFrontmatter
        {
            VersionMajor = 3, VersionMinor = 5, State = FrontmatterCodec.StateDevelopment,
        };
        var now = DateTimeOffset.UtcNow;

        FrontmatterCodec.ApplyUpdate(fm, now, newTags: null, newLocked: null);
        fm.VersionMajor.Should().Be(3);
        fm.VersionMinor.Should().Be(5);
    }

    [Fact]
    public void ApplyUpdate_rejects_lowering_version()
    {
        var fm = new ParsedFrontmatter
        {
            VersionMajor = 2, VersionMinor = 0, State = FrontmatterCodec.StateDevelopment,
        };
        var now = DateTimeOffset.UtcNow;

        var act = () => FrontmatterCodec.ApplyUpdate(
            fm, now, newTags: null, newLocked: null, newMajor: 1, newMinor: 9);
        act.Should().Throw<FrontmatterValidationException>();
    }

    [Fact]
    public void ApplyUpdate_allows_equal_version_for_pure_state_change()
    {
        var fm = new ParsedFrontmatter
        {
            VersionMajor = 1, VersionMinor = 0, State = FrontmatterCodec.StateDevelopment,
        };
        var now = DateTimeOffset.UtcNow;

        FrontmatterCodec.ApplyUpdate(
            fm, now, newTags: null, newLocked: null,
            newMajor: 1, newMinor: 0, newState: FrontmatterCodec.StateReleased);
        fm.State.Should().Be(FrontmatterCodec.StateReleased);
    }

    [Fact]
    public void ApplyUpdate_rejects_release_below_one_zero()
    {
        var fm = new ParsedFrontmatter
        {
            VersionMajor = 0, VersionMinor = 5, State = FrontmatterCodec.StateDevelopment,
        };
        var now = DateTimeOffset.UtcNow;

        var act = () => FrontmatterCodec.ApplyUpdate(
            fm, now, newTags: null, newLocked: null, newState: FrontmatterCodec.StateReleased);
        act.Should().Throw<FrontmatterValidationException>();
    }

    [Fact]
    public void ApplyUpdate_rejects_setting_state_at_zero_zero()
    {
        var fm = new ParsedFrontmatter();
        var now = DateTimeOffset.UtcNow;

        var act = () => FrontmatterCodec.ApplyUpdate(
            fm, now, newTags: null, newLocked: null, newState: FrontmatterCodec.StateDevelopment);
        act.Should().Throw<FrontmatterValidationException>();
    }

    [Fact]
    public void ApplyUpdate_rejects_unknown_state()
    {
        var fm = new ParsedFrontmatter
        {
            VersionMajor = 1, VersionMinor = 0, State = FrontmatterCodec.StateDevelopment,
        };
        var now = DateTimeOffset.UtcNow;

        var act = () => FrontmatterCodec.ApplyUpdate(
            fm, now, newTags: null, newLocked: null, newState: "frozen");
        act.Should().Throw<FrontmatterValidationException>();
    }
}
