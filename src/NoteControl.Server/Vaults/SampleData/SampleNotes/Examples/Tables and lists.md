---
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
tags: [reference]
locked: false
---
# Tables and lists

## Tables

3×4 table with a header row. Click any cell to edit; Tab moves to the next cell, Shift+Tab back. Right-click the table for add-row / add-column / delete actions.

| Project | Status | Owner | Due |
|---|---|---|---|
| Refactor authentication module | In progress | Søren | 2026-Q2 |
| Migrate to .NET 9 | Blocked | — | — |
| Document deployment pipeline | Done | Sara | 2026-04-15 |

A wider table with numeric columns:

| Build target | RAM (MB) | Cold start (ms) | Binary (KB) |
|---|---:|---:|---:|
| Debug         |  142 | 1820 |  87,400 |
| Release       |   78 |  610 |  41,200 |
| Release-AOT   |   42 |   95 |  18,900 |
| Self-contained|   95 |  720 | 102,800 |

The right-aligned numeric columns are achieved with the standard markdown `|---:|` syntax.

## Bullet lists

- Top-level item
- Another top-level item
  - Nested one level
  - Nested again
    - Three levels deep
  - Back to two
- Top-level again

Press **Tab** at the start of a list item to indent, **Shift+Tab** to outdent.

## Numbered lists

1. First
2. Second
   1. Sub-point
   2. Another sub-point
3. Third

The numbers re-number themselves automatically — delete an item in the middle and the list stays sequential.

## Mixed lists

You can mix bullet and numbered lists at different levels:

1. Plan
   - Sketch architecture
   - Identify risks
2. Build
   - Server
   - Tray
   - Frontend
3. Ship

## Task / checkbox lists

This isn't a bullet list — it's a separate "task list" item type. The slash menu doesn't currently have a direct entry; type `[ ]` at the start of a line to convert.

- [ ] Open PR for the search-pagination fix
- [x] Update CodeSys runtime to 3.5 SP21
- [ ] Schedule downtime window with prod
- [ ] Test failover behaviour after deployment

<div class="nc-callout nc-callout-note" data-variant="note">

**Lists round-trip cleanly.** Open this file in any plain markdown editor (Notepad, VS Code, Obsidian) and the lists, tables, and tasks all look right. NoteControl's WYSIWYG is just a layer on top — the source of truth is what's on disk.

</div>
