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
}
