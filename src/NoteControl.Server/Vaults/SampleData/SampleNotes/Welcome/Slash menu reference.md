---
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
tags: [welcome, reference]
locked: false
---
# Slash menu reference

Press `/` in the editor to open the menu. Type to filter. ↑/↓ arrows or mouse to choose.

## Headings

# Heading 1
## Heading 2
### Heading 3

## Lists

Bullet list:

- Frigate
- Karavel
- Slæbebåd

Numbered list:

1. Quark
2. Lepton
3. Boson

## Quote

> Måske var det aldrig vejen.
> Måske var det rejsen.

## Divider

The `/divider` command inserts a horizontal line:

---

## Tables

| Service | Type | Notes |
|---|---|---|
| auth-api | ASP.NET Core | Issues session cookies + CSRF tokens |
| notes-api | ASP.NET Core | Reads/writes markdown via the file system |
| ui-spa   | React + Vite | Talks to both APIs over `/api/*` |

## Callouts (5 variants)

<div class="nc-callout nc-callout-error" data-variant="error">

**Error.** Red. For things that went wrong, exceptions, broken behaviour worth shouting about.

</div>

<div class="nc-callout nc-callout-warning" data-variant="warning">

**Warning.** Yellow. For things that might go wrong, footguns, "be careful here".

</div>

<div class="nc-callout nc-callout-info" data-variant="info">

**Info.** Blue. Neutral context — explanation, supporting detail.

</div>

<div class="nc-callout nc-callout-tip" data-variant="tip">

**Tip.** Green. Solutions, best practices, "the trick is".

</div>

<div class="nc-callout nc-callout-note" data-variant="note">

**Note.** Gray. General observations, follow-ups, side remarks.

</div>

## Inline formatting

You can have **bold**, *italic*, `inline code`, [links to other notes](Start%20here.md), and ==highlighted text== inside any paragraph.

## Code blocks

See **Examples → Code blocks** for full examples in C#, TypeScript, Python, and Structured Text.

## Images

Paste a screenshot directly into the editor with **Ctrl+V**, or use `/image` from the slash menu to pick a file. Pasted images get saved next to the note in `{note-name}.assets/` automatically.

## Templates

If your vault has templates configured (see Templates… in the right rail), they show up at the bottom of the slash menu under "Templates". Picking one inserts its content at the cursor.
