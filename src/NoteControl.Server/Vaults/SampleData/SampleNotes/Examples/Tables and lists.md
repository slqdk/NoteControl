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
| Migrate AX5000 axes | In progress | Søren | 2026-Q2 |
| Test EL7211 ramp | Blocked | — | — |
| Document gear assemblies | Done | Sara | 2026-04-15 |

A wider table with numeric columns:

| Drive | Voltage | Continuous current | Peak current |
|---|---:|---:|---:|
| AX5101 | 24 V | 1.5 A | 4.5 A |
| AX5103 | 24 V | 4.5 A | 9 A |
| AX5106 | 24 V | 6 A | 12 A |
| AX5118 | 230 V | 18 A | 36 A |

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

- [ ] Order replacement EtherCAT cable
- [x] Update TwinCAT 3 to 4026
- [ ] Schedule downtime window with prod
- [ ] Test failover behaviour

<div class="nc-callout nc-callout-note" data-variant="note">

**Lists round-trip cleanly.** Open this file in any plain markdown editor (Notepad, VS Code, Obsidian) and the lists, tables, and tasks all look right. NoteControl's WYSIWYG is just a layer on top — the source of truth is what's on disk.

</div>
