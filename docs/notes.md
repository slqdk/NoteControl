# Notes, folders, and templates

Notes are plain markdown files on disk. Folders are folders.
Templates are markdown files in a special subfolder. Read this
when you're touching the editor, the slash menu, paste handling,
the tree, daily notes, or templates.

## File-on-disk model

Every note is a single `.md` file in the vault folder. Folder
structure on disk is the folder structure in the UI — there is
no virtual hierarchy. To move a note, you move its file. To
delete a folder, you delete the folder and everything in it.

A note is its body plus an optional YAML frontmatter block at
the top. Both are markdown standard:

```
---
created: 2026-04-12T08:30:00+02:00
updated: 2026-05-04T15:22:01+02:00
tags: [project-x, electrical]
locked: false
version: v0.1
---

# Heading

The body of the note in normal markdown.
```

Frontmatter fields the server understands:

| Key | Type | Meaning |
|---|---|---|
| `created` | ISO 8601 datetime | When the note was first created. Server sets it on first save; preserved across edits. |
| `updated` | ISO 8601 datetime | Last write. Server bumps it on every successful save. |
| `tags` | string array | Comma-separable tag list. Lowercased on save. Indexed for search. |
| `locked` | boolean | When true, the editor renders read-only and the save endpoint rejects writes. Toggleable from the properties panel. |
| `version` | string (free-text) | Per-note version label. Defaults to `v0.0` when missing. The editor shows it in the properties panel; users edit it freely. |
| `font` | string | Optional CSS font family / alias. When set, the editor renders the note in this font. |
| `fontSize` | integer | Optional font size in pixels. |
| `width` | integer | Optional page width in pixels (default 700). |

Any other YAML keys are **preserved verbatim** through round-trip
saves — the server reads, mutates the known fields, and writes
back without dropping unknown ones. Hand-edit frontmatter to add
your own keys; they survive editor saves.

## Path conventions

A note's path inside the vault is its relative path from the
vault root, with `/` separators, no leading slash, and `.md`
extension included. Example: `Project X/2026/Spec.md`.

Folder paths use `/` separators with no trailing slash. Example:
`Project X/2026`.

Reserved folder names (the server refuses to create or move
into them):

- `.notesapp` — per-vault metadata folder. Holds `index.db`,
  `templates/`, `trash/`, `startpage.json`, and other
  per-vault state.
- `.server` — only at the **vault parent** (DataRoot) level,
  never inside vaults. Holds server-wide state files.

Note titles in the UI come from the note's first H1 heading if
present, otherwise the filename without `.md`.

## Editor

The editor is TipTap-based. What it supports out of the box:

- **Headings**: H1, H2, H3.
- **Lists**: bullet, numbered, nested. Tab/Shift-Tab to
  indent/outdent.
- **Inline marks**: bold, italic, underline, strikethrough,
  inline code, links.
- **Blocks**: blockquote, horizontal rule, paragraph.
- **Code blocks** with editable language tag. Syntax
  highlighting via lowlight, with a custom **Structured Text
  (TwinCAT 3 ST)** language registered — the keywords for ST
  are recognised case-insensitively. Code blocks tagged as
  ST and titled `Implementation`, when paired with a sibling
  Declaration block above them, show an inline **Run** button
  that opens the ST runtime sandbox modal — see [ST runtime
  sandbox](#st-runtime-sandbox) below.
- **Tables**: insertion goes through a small modal that lets the
  user pick rows, columns, header-row presence, and an optional
  per-table row height (defaults: 3×3, header row, no fixed
  height). Inside a table, a floating popup above the table offers
  add/remove row/column, header-row toggle, and a `•••` button
  that opens an options panel with row height (number + presets),
  cell alignment (left/center/right), header-column toggle, and
  cell merge/split. See [Tables in detail](#tables-in-detail).
- **Callouts** in 5 variants: error, warning, info, tip, note.
  Each is a colour-coded box with an icon.
- **Images**: inline, with hover controls (resize, replace,
  delete, alt-text).
- **Videos**: inline, with hover controls (similar to images).

What the editor does NOT do:

- No collaborative / real-time editing. One user writes a note
  at a time.
- No diff / version history beyond what the markdown file's
  filesystem mtime gives you. (Backups are how you go back.)
- No outline / minimap.

### Keyboard shortcuts

The editor honours TipTap defaults: Ctrl+B (bold), Ctrl+I
(italic), Ctrl+U (underline), Ctrl+K (link), etc. Plus:

- **Ctrl+S** — force-save (debounced auto-save runs anyway).
- **Tab / Shift-Tab** in lists — indent / outdent.
- **Tab / Shift-Tab** in code blocks — insert four spaces /
  remove up to four leading spaces from the current line. Works
  in code blocks of any language. The four-space width matches
  TwinCAT 3's default ST indent.
- **/** at the start of a paragraph — open the slash menu.
- **F2** inside a Structured Text code block — open the
  autocomplete popup (see below).
- **Ctrl+Backspace** in a table cell — delete the cell's row
  if at start, otherwise delete word (TipTap default). The
  table delete shortcut also handles cleaning up empty tables.

### Slash menu

Type `/` at the start of a paragraph to open a menu of
block-insertion shortcuts. Items shown in order:

1. **Templates** (only if the vault has at least one template;
   opens a submenu of the templates by name)
2. **Heading 1**
3. **Heading 2**
4. **Heading 3**
5. **Bullet list**
6. **Numbered list**
7. **Code block** (inserts a paragraph header plus paired
   `Declaration` and `Implementation` ST code blocks — the
   shape the [ST runtime sandbox](#st-runtime-sandbox) reads
   to enable the **Run ▶** button)
8. **Quote**
9. **Divider**
10. **Table** (opens an insert dialog — see [Tables in
    detail](#tables-in-detail))
11. **Error callout**
12. **Warning callout**
13. **Info callout**
14. **Tip callout**
15. **Note callout**
16. **Image** (only outside the templates editor; opens a file
    picker, uploads, inserts)

The menu filters as you type. Filtering matches title prefix
first, then title infix, then keyword prefix, then keyword
infix.

### Tables in detail

Tables are markdown-flavoured by default but carry NoteControl-
specific decoration when needed. The editor offers controls in
two places: an insert dialog (when creating a table) and a
floating popup (when the cursor is inside one).

**Insert dialog.** Picking Table from the slash menu opens a
modal with fields for rows, columns, an "include header row"
checkbox, and an optional row height (number input plus presets:
Auto, 24, 32, 48, 64). Defaults are 3×3, header row on, no fixed
height — matches the pre-dialog default. Enter on a dimensions
field submits; Escape or click-outside cancels.

**Floating popup.** When the cursor is inside any cell, a
toolbar floats above the table. Two layers:

- **Always-visible row** — add row above/below, add column
  left/right, delete row, delete column, toggle header row, and
  a `•••` button to reveal the options panel.
- **Options panel** (toggled by `•••`) — row height with the
  same number+presets controls as the insert dialog, cell
  alignment (left/center/right, toggle off by clicking active),
  header column toggle, and merge/split (disabled when the
  current selection wouldn't allow the action).

Row height is a per-table attribute. Cell alignment is
per-cell. Header row and header column are independent toggles.

**Deleting a table.** Drag-select all cells (top-left to
bottom-right), then press Del or Backspace. The popup does not
include a delete-table button — the deliberate-selection gesture
guards against accidental destructive actions.

**Markdown round-trip.** A table is saved to disk as one of two
forms, picked per-table at save time:

- **GFM pipe syntax** when the table is "plain" — no per-table
  row height, no per-cell alignment, no merged cells, no header
  column, no multi-block content inside any cell.
- **Raw HTML** otherwise. The `<table>` carries
  `data-row-height` plus a matching `style` for the row-height
  CSS variable; cells carry `data-align` plus a matching
  `text-align` style. Plain markdown viewers (GitHub, VS Code
  preview, Obsidian) render the HTML form correctly because GFM
  permits inline HTML; the `data-*` attributes are how
  NoteControl reads the values back on load.

The HTML form preserves cell text but **drops inline marks
inside cells** (bold/italic/inline code/links). If a table
needs both a custom row height and rich cell formatting,
clearing the row height (set to Auto) reverts the table to pipe
syntax which preserves marks.

### F2 autocomplete (Structured Text)

Press F2 with the cursor inside a code block whose language is
`st` (the default for new blocks) to open an autocomplete popup.
The popup runs in one of two modes, picked automatically from the
surrounding document:

- **Declaration mode** — when the active block's title is
  `Declaration` (case-insensitive), or when the block isn't
  paired with a Declaration sibling. The popup lists built-in
  scalar types (BOOL, BYTE, WORD, DWORD, LWORD, SINT, USINT,
  INT, UINT, DINT, UDINT, LINT, ULINT, REAL, LREAL, STRING,
  TIME) and common function-block types (TON, TOF, TP, R_TRIG,
  F_TRIG, CTU, CTD, CTUD, RS, SR). Picking an item inserts the
  type/FB name at the cursor.

- **Implementation mode** — when the active block's title is
  `Implementation` AND the immediately-preceding sibling block
  is an `st` code block titled `Declaration` (the shape the
  PLCOpen XML import produces; same rule the Run button uses).
  The popup lists every variable scanned out of that Declaration
  block, with its type as a subtitle. Picking a scalar variable
  inserts its name. Picking a variable whose type is a known FB
  inserts a full call signature with the formal parameters in
  source order — for example `Timer01(IN := , PT := , Q => , ET
  => )` for a `Timer01 : TON` instance — and places the caret
  right after the first input's `:= ` so the user can type the
  value immediately.

The declaration scanner is deliberately lenient: it survives
mid-typing (missing semicolons, no `END_VAR` yet), comments,
TwinCAT pragmas, `AT %ADDR` direct addresses, multi-name
declarations (`a, b, c : INT;`), and `POINTER TO` / `REFERENCE
TO` wrappers. Variables whose type isn't recognisable are
silently skipped rather than failing the whole popup.

Inside the popup: type letters/digits/underscore to filter
(prefix-then-infix scoring against the title and keywords),
ArrowUp/ArrowDown to navigate, Enter or Tab to insert the
highlighted item, Escape or click-outside to dismiss without
inserting. Backspace shrinks the filter query.

### Bubble menu

Selection in the editor floats a small toolbar with: bold,
italic, link (text input), inline code. The link button uses
the browser's `window.prompt` today (queue item: replace with a
proper modal).

### Paste

Two kinds of paste are handled specially:

- **Image data on the clipboard** (e.g. screenshot from
  Snipping Tool): uploaded as an asset to the current note's
  asset folder, inserted as `![](path)` at the paste position.
- **Office HTML** (paste from Word/Excel/Outlook with embedded
  images): each `<img>` whose `src` can't be fetched is
  replaced by uploading the corresponding image blob from the
  clipboard, in DOM order. Order is preserved relative to the
  surrounding text. Falls back to "drop the image" silently on
  HTTP failure or if the image count doesn't match.

Asset paste requires a **secure context** (HTTPS or localhost)
because `navigator.clipboard.read()` is gated on that. If
you're on plain HTTP from a remote host, paste-image won't
work; the user is told nothing — pre-existing limitation.

Generated paste filenames: `paste-<unix-ms>-<index>.<ext>`.

### Drag and drop

You can drag files from the OS into the editor. Image and
video drops upload as assets. Drag from the tree view onto
folders in the tree moves notes/folders. Drag-out of the
editor (e.g. a note onto a Slack window) gives the OS a
default URL of the editor route — not a markdown export.

## Folders

A folder exists if and only if there's a directory of that
name. There are no folder rows in any database — the file
system IS the folder model.

Operations:

- **Create** — server makes the directory. Refused if the
  parent doesn't exist or the name conflicts.
- **Rename / move** — server moves the directory and updates
  index entries for any notes inside. Cross-vault moves are
  not supported.
- **Delete** — recursive. Removes the on-disk directory and
  all notes within. The notes go to `.notesapp/trash/<vault>/`
  with a manifest (so a future "undelete" feature could find
  them); folder structure inside trash mirrors the original
  paths.

## Trash

`.notesapp/trash/` is the per-vault holding area for deleted
notes. There is no UI for browsing or restoring trash today;
files just accumulate. Manual cleanup is on the user. (Future
queue item: trash UI + retention policy.)

## ST runtime sandbox

A lightweight in-browser interpreter for **Structured Text**
(TwinCAT 3 dialect) lets the user run small ST programs
directly inside a note, without the server or a real PLC. Think
of it as a sandbox for working through example logic while
writing a note about it — closer to a calculator than a
debugger.

### Invocation

The Run button appears on a code block when **both** of these
are true:

1. The block's language tag is `st` (the editable language tag
   on the code block — see the Editor section above).
2. The block's title is `Implementation`, AND its **immediate
   previous sibling** is another ST code block titled
   `Declaration`.

The Declaration block holds the `VAR ... END_VAR` block(s);
the Implementation block holds the body. The runtime needs
both to know what variables exist and what statements to run.

The slash menu's **Code block** item inserts this Declaration +
Implementation pair directly (a header paragraph + the two
correctly-titled ST code blocks). Users can also build the
pair by hand from two separate code blocks if they want — the
runtime keys off the title + language attributes, not how the
blocks were created.

Clicking Run opens a modal overlaying the editor. The modal is
a self-contained sandbox: it holds its own copy of the program
state, makes no server calls, and closes cleanly without
touching the note.

### Modal layout

The modal contains:

- A **toolbar** at the top: Run / Stop / Step / Reset buttons,
  a cycle-time selector (10 / 50 / 100 / 500 ms or 1 s,
  default 10 ms), a scan counter (`scan: N`), and a runtime
  elapsed-time readout (`t: 1.5s`). Elapsed time is the
  runtime's own clock, not wall time — frozen during Stop and
  zeroed by Reset.
- A **Declaration pane**: read-only display of the parsed
  declaration source.
- An **Implementation pane**: the implementation source with
  inline value pills spliced in after every variable reference
  and FB-member access. Non-BOOL pills sit on a warm cream
  background (matching TwinCAT's online-view look). BOOL pills
  reverse out for stronger signal: `TRUE` is white text on
  blue, `FALSE` is white text on black.
- An **error banner** appears above the toolbar when a parse
  or runtime error occurs, naming the offending line; the
  matching source line in the Implementation pane is
  highlighted.

### Supported language scope

What the v1 interpreter handles:

- **Scalar types**: `BOOL`, `BYTE`, `WORD`, `DWORD`, `LWORD`,
  `SINT`, `INT`, `DINT`, `LINT`, `USINT`, `UINT`, `UDINT`,
  `ULINT`, `REAL`, `LREAL`, `STRING`, `TIME`. Integer
  assignments wrap silently to the destination type's range
  (two's complement for signed types) — matches real PLC
  behaviour.
- **Operators**: full ST precedence — `OR` > `XOR` > `AND` >
  comparisons (`=`, `<>`, `<`, `<=`, `>`, `>=`) > additive
  (`+`, `-`) > multiplicative (`*`, `/`, `MOD`) > exponent
  (`**`) > unary (`NOT`, `+`, `-`).
- **Statements**: `IF / ELSIF / ELSE / END_IF`, `CASE` with
  range labels, `FOR / TO / BY / DO / END_FOR`, `WHILE / DO /
  END_WHILE`, `REPEAT / UNTIL / END_REPEAT`, `EXIT`,
  `CONTINUE`, `RETURN`, plain assignments and expression
  statements. The trailing `;` after `END_IF` / `END_CASE` /
  `END_FOR` / `END_WHILE` / `END_REPEAT` is **optional** —
  both `END_IF` and `END_IF;` parse.
- **Built-in functions**: `ABS`, `MIN`, `MAX`, `LIMIT`, `SEL`,
  `SHL`, `SHR`, `ROL`, `ROR`, and the full `<X>_TO_<Y>`
  conversion family across the numeric types (e.g.
  `INT_TO_REAL`, `REAL_TO_DINT`, `BOOL_TO_INT`).
- **Built-in function blocks**: `TON`, `TOF`, `R_TRIG`,
  `F_TRIG`. Declared as `MyTimer : TON;` (no init expression
  allowed for FB instances — the parser rejects it). Called
  with named arguments using `:=` for inputs and `=>` for
  output bindings: `MyTimer(IN := bStart, PT := T#1s, Q =>
  bDone);`. The `PT` argument **must be a TIME value** —
  `PT := 1000` is rejected with a type-mismatch; write
  `PT := T#1s` (or any other `T#…` literal). FB outputs are
  also readable via member access: `MyTimer.Q`, `MyTimer.ET`.
  Timer elapsed time uses the runtime's scan-time clock, so a
  Stop/Run pause doesn't advance the timer.
- **Literals**: decimal, hexadecimal (`16#FF`), binary
  (`2#1010`), and octal (`8#777`) integers; typed-prefix
  integers (`UDINT#42`); reals; BOOL `TRUE`/`FALSE`; string
  literals in single quotes; TIME literals `T#1s500ms`,
  `T#2h30m`, etc.
- **BOOL assignment from integer**: `bFlag := 1` and
  `bFlag := 0` are accepted (mapping to `TRUE` / `FALSE`),
  in both `:= initial` declarations and assignment
  statements. Other integer values are rejected — write
  `<> 0` or similar if you want C-style "non-zero is true"
  semantics. The reverse direction (assigning a BOOL into an
  integer variable) is still rejected; use `BOOL_TO_INT` for
  that.

### Variable poking

When the modal is in `paused` or `running` mode (i.e. not in an
error state), every scalar value pill in the Implementation
pane is **clickable**. Hovering shows a faint blue ring and a
text cursor; clicking opens an inline input field pre-filled
with the current value, with the text selected.

- **Enter** commits. The input is parsed against the
  variable's declared type and coerced (so typing `9999` into
  a BYTE wraps to `9999 mod 256`). Acceptable forms:
  `TRUE`/`FALSE`/`1`/`0` for BOOL; decimal/hex/binary for
  integers; standard JS-style for reals; `T#...` or a bare
  number-of-ms for TIME; raw text or single-quoted for STRING.
- **Esc** cancels.
- **Blur** with no change cancels; blur with a change commits.
- A parse failure leaves the input open with a red border.

The user can poke variables freely while a scan is running —
the next scan picks up the new value. The pill being edited is
exempted from scan-driven re-renders so typing isn't
overwritten mid-keystroke.

FB instances are **not** pokeable (no single value to set);
neither are FB-member pills (`MyTimer.Q`, `MyTimer.ET` are
derived outputs).

### Statement budget

The interpreter caps each scan at **100 000 statements**.
Exceeding the cap throws a runtime error (`execution budget
exceeded — likely infinite loop`) and halts execution. This
catches `WHILE TRUE` and similar constructs without locking up
the browser tab. The cap resets per scan, so a long-running
program with many small scans is unaffected.

### Worked example

A minimal on-delay timer the user can paste into a note:

````
```st
PROGRAM TimerDemo
VAR
  myTimer : TON;
  bStart : BOOL;
  bDone : BOOL;
  elapsed : TIME;
END_VAR
```

```st
myTimer(IN := bStart, PT := T#2s);
bDone := myTimer.Q;
elapsed := myTimer.ET;
```
````

The fastest way to get this set up is the slash menu's
**Code block** entry, which inserts the Declaration +
Implementation skeleton with the right titles already on it
— then replace the seed `Program1` declaration and empty
implementation with the bodies above. (You can also build
the pair by hand from two separate code blocks; titles are
editable on the code block UI.) The Run button appears on
the Implementation block once both blocks are in place.
Open the modal, click Run, then click the `bStart` pill and
type `TRUE`. The `myTimer.ET` pill counts up; after 2 s,
`bDone` flips to TRUE and stays latched until `bStart` goes
back to FALSE.

### Non-goals

The runtime does **not** support, by design:

- **User-defined function blocks.** `FUNCTION_BLOCK ...
  END_FUNCTION_BLOCK` declarations are rejected. Only the
  four built-in FBs above can be instantiated.
- **Arrays, structs, enums, pointers, references.** Scalars
  only.
- **String functions** beyond literal assignment (no `CONCAT`,
  `LEN`, `MID`, etc.).
- **Real-time semantics.** Inputs aren't latched at scan
  start; outputs aren't held at scan end. The interpreter
  walks the body top-to-bottom each cycle.
- **Persistent state across modal closes.** Closing the modal
  discards the env entirely. Reopening starts fresh.
- **Source-line highlighting during execution.** The error
  banner highlights the failing line on a runtime error, but
  there is no "executing line" cursor during a successful
  scan.

## Daily notes

Daily notes have a fixed on-disk layout:

```
Daily Notes/
  2026/
    04-April/
      2026-04-28.md
      2026-04-29.md
    05-May/
      2026-05-01.md
```

- The folder name `Daily Notes` is conventional. The endpoint
  `POST /api/vaults/{id}/daily/today` looks for this folder
  (case-sensitive), creates it if missing, and creates the
  year + month subfolder + today's file.
- Filenames are ISO date (`YYYY-MM-DD.md`). Folder names use
  `MM-MonthName` so they sort correctly and read naturally.
- The frontend re-formats these for display in **Danish**:
  - The year stays as-is.
  - The month folder displays as the Danish month name without
    the number prefix (`April` not `04-April`).
  - The day file displays as Danish weekday + day number
    (`Mandag 28`).

This is **display-only**. The on-disk filenames stay in the
canonical format; search, links, and the index all use the
canonical paths.

The "Open today's daily note" button (in the topbar / startpage)
either opens an existing today file or creates a new one with a
template body if a `Daily.md` template exists in the vault.

## Templates

Templates are markdown files in `{vault}/.notesapp/templates/`.
Each file is one template; the filename (minus `.md`) is the
template name shown in the picker. Body is plain markdown,
inserted verbatim at the cursor when the user picks the
template from the slash menu.

Templates are managed via the **Templates** page (separate
route, not under the shared layout). Permissions: viewers can
read, editors can write. Templates are **shared at the vault
level** — every user with viewer-or-better on the vault sees
the same template list.

Special name: a template called `Daily` is used as the body
for newly-created daily notes (see above).

The template editor is a stripped-down version of the note
editor:

- The slash menu has the **Image** item disabled (templates
  have no asset folder).
- The slash menu has the **Templates** submenu disabled
  (avoids template-of-template recursion in the picker).
- Otherwise behaves the same: callouts, code blocks, lists,
  tables, and so on are all available.

## Tree view

The vault's notes/folders are shown in a tree on the left side
of the shell. Behaviours:

- **Expand/collapse**: click the chevron, double-click the
  row, or press Right/Left arrow when focused.
- **Persistence**: the expanded set persists in localStorage
  per vault (`nc:tree-expanded:<vaultId>`). Reopening the
  vault restores the same expansion.
- **Selection**: click a row to select it. Selection drives
  the properties panel and the editor's current note.
- **Right-click menu**: New note, New folder, Rename, Move,
  Delete.
- **Drag-and-drop**: drag a row onto a folder to move it.
  Cross-vault drag is not supported.
- **Pinned rows at top**: the **Startpage** row is always at
  the top, above all other folders. **Daily Notes** is not
  pinned — it sorts as a regular folder named "Daily Notes".

The tree component is shared between the folder page and the
editor page; it's mounted once per vault session and survives
navigation between notes (its cached children + expanded set
+ selection don't reset).

## Search

Server-side full-text search uses SQLite FTS5 over the
per-vault index DB. Behaviours:

- Search hits return note path, title, and a snippet with the
  match highlighted.
- Tokenizer is `porter unicode61` — handles Latin scripts well,
  case-insensitive, basic English stemming. Danish stems are
  not handled specifically.
- Searches are scoped to one vault. There is no cross-vault
  search today.
- The index is rebuilt automatically on schema-version bump
  (currently 1). Owners can also force-rebuild via
  `POST /api/vaults/{id}/index/rebuild`.

## Audit events

- `NoteCreated`
- `NoteDeleted`
- `NoteMoved`

Note *updates* (edits to the body) are not audited — they'd
flood the log with debounced auto-save events. Backup runs are
the authoritative record of what changed when.
