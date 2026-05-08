# Notes, folders, and templates

Notes are plain markdown files on disk. Folders are folders.
Templates are markdown files in a special subfolder. Read this
when you're touching the editor, the slash menu, paste handling,
the tree, daily notes, templates, or the ST sandbox.

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
  are recognised case-insensitively. ST code blocks have a
  Run button in the header that opens the **ST sandbox** (see
  below).
- **Tables** (3×3 default, header row, with a toolbar for
  add/remove rows and columns).
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
- **/** at the start of a paragraph — open the slash menu.
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
7. **Code block**
8. **Quote**
9. **Divider**
10. **Table** (3×3 with header)
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

## ST sandbox

When a code block's language tag is `st` (the TwinCAT 3
Structured Text dialect), a Run button appears in the block's
header. Clicking it opens the **ST sandbox** — a modal that
parses the code, runs it as a scan loop, and lets the user
poke values mid-run. It's a teaching / scratchpad tool, not a
PLC simulator.

### Modal layout

The modal has three regions:

- **Toolbar**: Run / Step / Stop / Reset, a Cycle dropdown
  (1ms / 10ms / 100ms / 1s), and live readouts of `scan` (the
  scan counter) and `t` (accumulated scan time).
- **Declaration pane**: shows either the raw declaration text
  or a live watch table — see *Source / Watch toggle* below.
- **Implementation pane**: the body source with **inline value
  pills** spliced in after every variable reference and
  member access.

Errors display in a red banner at the top with the offending
line, and the corresponding line in the Implementation pane is
highlighted. The runtime halts on error; click Reset to clear.

### Accepted code shape

The sandbox accepts hand-pasted TwinCAT exports, including the
PLCOpenXML "InterfaceAsPlainText" form. Specifically:

- **POU header**: optional `PROGRAM <Name>`,
  `FUNCTION_BLOCK <Name>`, or `FUNCTION <Name> : <ReturnType>`.
  All three are treated as "a body to run once per scan with a
  flat variable table." `FUNCTION` return types are accepted
  syntactically but never produced — the body just executes.
- **Variable sections**: `VAR`, `VAR_INPUT`, `VAR_OUTPUT`,
  `VAR_IN_OUT`, `VAR_TEMP`, `VAR_GLOBAL`, `VAR_EXTERNAL`. All
  recognised; all collapsed into a single flat scope. The
  section the variable came from is **display-only** — shown
  as a coloured tag in the watch table, but the runtime makes
  no input/output distinction.
- **Modifier keywords** after a section keyword: `CONSTANT`,
  `RETAIN`, `PERSISTENT`. Skipped (not enforced).
- **Pragma blocks**: `{attribute 'hide_all_locals'}`,
  `{region ...}`, etc. Skipped at the lexer level.
- **Multi-decl on one line**: `a, b, c : INT;` accepted.
- **Initial values**: only on scalar declarations.
  `:=` after an FB-typed or unknown-typed variable is rejected.
- **Terminators**: `END_PROGRAM`, `END_FUNCTION_BLOCK`, and
  `END_FUNCTION` all accepted (interchangeably).

### Types

**Scalar types** are stored and computed natively:

- BOOL, BYTE, WORD, DWORD, LWORD
- SINT, INT, DINT, LINT
- USINT, UINT, UDINT, ULINT
- REAL, LREAL
- TIME (stored as integer milliseconds)
- STRING

Integer overflow follows IEC wrap-on-assignment rules. REAL/
LREAL use JS numbers (binary64). TIME is signed milliseconds.

**Built-in FB types**: TON, TOF, R_TRIG, F_TRIG. Each ticks
correctly per scan; the user can read `.Q`, `.ET` (TON/TOF),
or just `.Q` (R_TRIG/F_TRIG).

**Unknown types** — anything not in the lists above (custom
function blocks like `FB_MyController`, structs like
`ST_Settings`, enums, union types) — are **accepted at parse
time** but treated as opaque containers:

- Calls to unknown FB instances in the body silently no-op.
  Argument expressions are NOT evaluated, output bindings
  are NOT written.
- Reading an unknown bare variable or unknown member before
  it's been poked raises a runtime error ("has no value yet
  — click its pill to poke one"). No silent defaulting.
- The user pokes values into unknown variables and members
  to drive them manually. The poked value's type is
  **inferred from the input syntax** — `TRUE` / `FALSE` →
  BOOL, `T#1s` / `TIME#…` → TIME, `'foo'` / `"bar"` →
  STRING, `3.14` → LREAL, `42` → DINT, `16#FF` / `2#1010`
  → DINT, anything else → unquoted STRING.
- Unknown identifiers in the source are rendered with reduced
  opacity in both panes so the user sees they're "on hold."

### Built-in functions

- **Arithmetic / math**: `ABS`, `MIN`, `MAX`, `LIMIT`, `SEL`.
- **Bit shifts**: `SHL`, `SHR`, `ROL`, `ROR`.
- **Type conversions** — every scalar pair, in two forms:
  `TO_<TARGET>(x)` (modern short form) and
  `<SOURCE>_TO_<TARGET>(x)` (legacy long form). The long form
  ignores the source label and dispatches on the runtime
  value's actual type, matching TwinCAT.
  Conversion semantics:
  - Numeric → numeric: wrap-on-overflow per the assignment rule.
  - BOOL → numeric: TRUE → 1, FALSE → 0. Numeric → BOOL: 0 →
    FALSE, anything else → TRUE.
  - TIME ↔ numeric: TIME values pass as milliseconds; numeric
    → TIME clamps to ≥0 ms, truncates to integer.
  - STRING ↔ scalar: STRING → numeric parses decimal, hex
    (`16#FF`), octal (`8#777`), binary (`2#1010`), with
    optional sign / underscores / whitespace; STRING → BOOL
    accepts `TRUE`/`FALSE`/`1`/`0` case-insensitively;
    STRING → TIME accepts `T#…` form or a bare ms count;
    Numeric/BOOL/TIME → STRING formats decimally.

### Inline value pills (Implementation pane)

Each variable reference and member access in the body is
followed by a small pill showing the current runtime value.
Behaviours:

- **BOOL pills** are filled (blue = TRUE, black = FALSE).
  Other types are border-only with the value as text.
- **Single-click** any pokeable pill → opens an inline editor
  where you type a new value, Enter to commit, Escape to
  cancel. The new value lands in the env immediately and
  drives the next scan tick.
- **Double-click** a BOOL pill → toggles the value directly
  (no editor). Works on declared BOOLs and on unknowns where
  a BOOL has been poked.
- **FB-instance bare references** (e.g. `Timer01` shown as
  `<TON>`) are not pokeable — call them or read a member.
- **Built-in FB members** (e.g. `Timer01.Q`, `Timer01.ET`)
  are read-only — they're computed from the FB's tick state
  each scan, so a poke would be overwritten next tick.
- **Unknown-typed pills** are faded with a dashed border;
  they remain pokeable, with type inferred from input.

Errors during a scan halt the loop and highlight the offending
line. The pill on that line shows the value at the moment of
failure. Click Reset to clear and start over.

### Source / Watch toggle (Declaration pane)

The Declaration pane has a Source / Watch toggle in its title
bar. Source shows the raw declaration text (read-only).
Watch shows a scrollable live table:

- Columns: **Name**, **Type**, **Value**, **Section**.
- Section is a small coloured pill: input (blue), output
  (amber), in_out (purple), local (gray), temp (cyan),
  global (green), external (pink).
- Built-in and unknown FB instances get an expand chevron;
  clicking expands to indented member rows underneath.
  Built-in FB members render read-only; unknown FB members
  are pokeable.
- Value cells use the same poke rules as the inline pills:
  single-click to edit, double-click BOOL to toggle.

The pane defaults to **Source** on first open and **auto-
flips to Watch** on the first successful scan. Once the user
manually toggles, their choice is honoured for the rest of
the modal session. Expand/collapse state resets when the
modal closes.

### Runtime safety

- **Statement budget per scan**: the interpreter limits how
  many statements a single scan can execute. Hitting the
  limit halts with a "scan budget exceeded" error — typically
  an unbounded `WHILE` or `REPEAT` in the body.
- **No real-time guarantees**. The Cycle setting picks a
  target interval but the scan runs on `setInterval`; under
  load, ticks can drift or stack. The displayed `t` is the
  accumulated *target* scan time, not wall-clock.
- **No filesystem, no network, no asset access**. The
  sandbox runs in-page; the body cannot touch the note's
  contents, other notes, or anything outside the env.

### What the sandbox does NOT do

- No multi-POU programs. One body per code block; no
  cross-block calls.
- No `TYPE ... END_TYPE` declarations (struct / enum / union /
  alias DUTs are rejected at parse time). Use unknown types
  instead — declare a variable with the DUT name and poke its
  members.
- No arrays. `ARRAY [..] OF X` syntax fails at parse time, and
  array indexing (`x[0]`) isn't accepted in the body either.
- No pointers or references. `POINTER TO X` / `REFERENCE TO X`
  fail at parse time; `ADR()`, `REF=`, and `^` dereference are
  not recognised.
- No persistence between modal sessions. Closing and
  reopening the modal loses all poked values, scan counts,
  and expand state.

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
