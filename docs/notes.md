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
  are recognised case-insensitively.
- **Tables** (3×3 default, header row). See the **Table editing**
  section below for selection grips, the unified popup, and row
  height.
- **Callouts** in 5 variants: error, warning, info, tip, note.
  Each is a colour-coded box with an icon.
- **Images**: inline, with hover controls (resize, replace,
  delete, alt-text).
- **Videos**: inline, with hover controls (similar to images).
- **Math** (LaTeX / KaTeX) in two flavours: inline (sits in a
  paragraph like a word) and block (centred display equation).
  See the **Math** section below for delimiter rules and
  round-trip behaviour.

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
- **Ctrl+Shift+M** — insert an empty inline math node at the
  cursor and open its edit popover. Block math has no shortcut;
  use `/math` for it.
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
10. **Math (block)** — inserts an empty block math node and
    opens the edit popover.
11. **Math (inline)** — inserts an empty inline math node and
    opens the edit popover.
12. **Table** (3×3 with header)
13. **Error callout**
14. **Warning callout**
15. **Info callout**
16. **Tip callout**
17. **Note callout**
18. **Image** (only outside the templates editor; opens a file
    picker, uploads, inserts)

The menu filters as you type. Filtering matches title prefix
first, then title infix, then keyword prefix, then keyword
infix.

### Bubble menu

Selection in the editor floats a small toolbar with: bold,
italic, link (text input), inline code, and a **Make inline
math** button (𝑥). The link button uses the browser's
`window.prompt` today (queue item: replace with a proper
modal). The math button turns the selected text into the
LaTeX source of a new inline math node (the popover opens
immediately so you can adjust the source); with no selection
it inserts an empty inline math node — equivalent to
`Ctrl+Shift+M`.

### Table editing

Cursor in a table cell does not show any chrome on its own.
To edit the table's structure you select a row, a column, or
the whole table via small grip handles that fade in on hover:

- one grip on the **left edge of each row**
- one grip on the **top edge of each column**
- one grip in the **top-left corner** (the table grip)

Clicking a grip opens a single popup whose contents are
scoped to the selection:

- **Row scope**: add row above, add row below, delete row,
  row height (Auto / 24 / 32 / 48 / 64 / custom), toggle
  header row.
- **Column scope**: add column left, add column right, delete
  column, cell alignment (left / centre / right), toggle
  header column.
- **Table scope**: row height, toggle header row, toggle
  header column, merge cells / split cell, delete table.

The popup closes on Escape, on a click outside, on selection
leaving the table, or on note switch. Clicking a different
grip while a popup is open swaps the popup's scope rather
than closing-then-reopening.

**Row height** is a single attribute on the whole table —
choosing a height applies to every row, and every row stays
at that height (rows grow if their content needs more, but
never shrink below the value). A table with a non-Auto row
height is stored as raw HTML inside the `.md` file (same as
callouts); plain tables stay as markdown pipe syntax. Other
table features that also force the HTML form are: any cell
with a non-default alignment, merged cells (colspan/rowspan
> 1), header cells outside row 0, multi-block content inside
a cell (e.g. a list), and user-set column widths from the
column-resize handle.

Mobile uses a different editor surface and does not show
grips today — table editing is desktop-only for now.

### Paste

Three kinds of paste are handled specially:

- **Image data on the clipboard** (e.g. screenshot from
  Snipping Tool): uploaded as an asset to the current note's
  asset folder, inserted as `![](path)` at the paste position.
- **Office HTML** (paste from Word/Excel/Outlook with embedded
  images): each `<img>` whose `src` can't be fetched is
  replaced by uploading the corresponding image blob from the
  clipboard, in DOM order. Order is preserved relative to the
  surrounding text. Falls back to "drop the image" silently on
  HTTP failure or if the image count doesn't match.
- **LaTeX delimiters in pasted text**: any of `$..$`,
  `$$..$$`, `\(..\)`, `\[..\]` in pasted plain text OR in the
  text content of pasted HTML (paragraphs, list items, etc.)
  become math nodes. The substitution skips inside code fences,
  inline code spans, and HTML tags. See the **Math** section
  below for the exact delimiter rules. HTML pastes from
  KaTeX-rendering apps are additionally checked for MathML
  `<annotation encoding="application/x-tex">` blocks — when
  present, the LaTeX source is extracted from there rather
  than re-parsed from the visible delimiters.

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

## Math

The editor renders LaTeX-style math via **KaTeX**. Two node
types, both edited through a popover with live preview and a
symbol palette:

- **Inline math** — sits inside paragraph flow. Renders at the
  surrounding line's font size.
- **Block math** — sits at block level. Renders display-style
  (centred, with larger operators).

### Delimiters

Four input forms are accepted on paste and on load from disk:

| Input form | Kind |
|---|---|
| `$x^2$` | inline |
| `$$\frac{a}{b}$$` | block |
| `\(x^2\)` | inline (LaTeX style) |
| `\[\frac{a}{b}\]` | block (LaTeX style) |

On save, the editor **normalises to the dollar form** —
`$..$` for inline and `$$\n..\n$$` for block — regardless of
which style the source arrived in. Reasoning: a single
canonical on-disk format means a save-then-reload never
silently rewrites a file's delimiters mid-session, and the
files stay portable to Obsidian, GitHub's math rendering, and
Pandoc (all of which default to dollars).

### Disambiguating `$` from currency

Naively pattern-matching `$..$` would eat real text like
"It costs $5 and $10" as if "5 and " were math. The editor
applies the Pandoc rule for single-dollar inline math:

- Opening `$` must NOT be followed by whitespace.
- Closing `$` must NOT be preceded by whitespace.
- The character right after the closing `$` must NOT be an
  ASCII digit.

That catches the common currency cases (`$5 and $10`, `$100`,
`$9.99`). It won't catch every adversarial sentence —
something like "I owe $5 to Bob and $7 to Alice" passes the
rule but isn't math. Realistic risk in technical notes is
low; if it bites, the workaround is to write the dollar
amount differently (`USD 5` etc.) or wrap the math in
`\(..\)` instead. There is no opt-out toggle.

The `$$..$$` form has no currency ambiguity and no such
restriction. The `\(..\)` and `\[..\]` forms also have no
restriction beyond "the source between delimiters must not be
empty or whitespace-only".

### What's supported

KaTeX's standard subset. Common Greek (`\alpha`, `\Sigma`,
…), operators (`\sum`, `\int`, `\frac`, `\sqrt`, …),
relations (`\le`, `\ne`, …), `\text{...}` for literal text
inside math, matrices and `cases` via `\begin{pmatrix} … \end`
and `\begin{cases} … \end`, sub/superscript with `_` and `^`,
auto-sized delimiters via `\left( … \right)`, and so on. See
the KaTeX docs for the full list.

What's NOT supported:

- `\usepackage`, `\newcommand`, custom macros — KaTeX doesn't
  do these.
- `\href`, `\includegraphics`, `\url` and other side-effectful
  commands — KaTeX's `trust` flag is left at the default
  (`false`).
- Copy-out of a math node yields the LaTeX **source** as plain
  text; there is no "copy as rendered image" path.

Invalid LaTeX renders in red (KaTeX's built-in
`throwOnError: false` behaviour) — the source stays on the
node's `latex` attribute either way, so fixing a typo in the
popover restores the rendering immediately.

### Editing a math node

Clicking a rendered math node opens a popover with:

- **Source textarea** on the left (LaTeX source; multi-line
  for block math, single-line for inline).
- **Live preview** on the right (KaTeX-rendered output of
  whatever's currently in the textarea).
- **Symbol palette** below — ~60 common symbols grouped by
  category (Structure, Operators, Relations, Arrows, Greek,
  Structures). Clicking a symbol inserts at the cursor;
  template entries like `\frac{$1}{$2}` position the caret at
  the first slot.

Commit / cancel gestures:

- Ctrl+Enter (or Enter on inline math) — commit + close.
- Esc — cancel + close.
- Click outside the popover — commit + close.
- Committing with an empty source deletes the math node.

A freshly-inserted math node auto-opens its popover so you can
type directly without a second click. Slash menu, bubble menu,
and `Ctrl+Shift+M` all go through this path.

### Inserting via the slash menu

`/math` (block) and `/math` (inline) — see the **Slash menu**
section. Both insert an empty node and open the popover
immediately. The block variant also appends a trailing
paragraph so the cursor has somewhere to land after the math.

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
- **Cover image** — a folder (including the vault root) can
  have an optional cover image rendered above the search on
  the Folder view. Managed from the Properties panel; stored
  as a hidden dotfile inside the folder so it moves with the
  folder automatically. See
  [frontend.md § Folder view](frontend.md#folder-view) for the
  UX and [storage.md § Folder covers](storage.md#folder-covers)
  for the on-disk layout.

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
  tables, math, and so on are all available.

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
- **Empty folders are muted**: a folder we've loaded and seen
  to contain zero subfolders + zero notes renders with a muted
  label and a dimmed icon — a "don't bother opening this"
  signal so the user can scan past empty folders without
  expanding them. Hovering the row restores the normal
  foreground colour; selecting it does too. The italic style
  on the label persists in both states as a quiet extra cue.
  Folders that haven't been loaded yet are NOT muted — "we
  don't know" is rendered the same as "has stuff," because
  graying unknowns would make the whole tree look dead on
  first paint.

The tree component is shared between the folder page and the
editor page; it's mounted once per vault session and survives
navigation between notes (its cached children + expanded set
+ selection don't reset).

### Eager one-level pre-fetch

For the empty-folder muting above to be useful, the tree has
to know a folder's contents BEFORE the user expands it.
Whenever a folder's children land in the listing cache, the
tree fires listing requests for each of that folder's direct
subfolders — one level deep, sequential (not parallel), and
idempotent (already-loaded or in-flight paths are skipped).

This is **one level only**. When a top-level folder's listing
arrives, its direct subfolders get pre-fetched; their
subfolders do NOT get pre-fetched at the same time. The next
level only loads when the user expands the parent — which
re-triggers the same one-level pre-fetch for the newly-loaded
layer.

Trade-offs to know:

- **First-paint flash**: the tree renders un-muted for ~50-500
  ms while the root listing arrives, then folders mute one by
  one as their listings come back. On slow links this window
  is longer; nothing breaks, the muting just settles in
  visibly.
- **N requests per expand**: a folder with K subfolders fires
  K sequential listing calls when it expands. Each call is
  small (one folder), but on a folder with 50 subfolders
  there's a brief network burst.
- **Cross-tab staleness**: if another tab (or user) creates a
  note inside a pre-fetched-as-empty folder, the muting
  persists in this tab until the folder's own listing refreshes
  on a manual expand or vault re-open. Same-tab CRUD already
  refreshes via the existing tree-refresh paths.

## Search

Server-side full-text search uses SQLite FTS5 over the
per-vault index DB. Behaviours:

- Search hits return note path, title, and a snippet with matched
  tokens wrapped in U+0001 / U+0002 control characters (see
  [api.md](api.md#search--indexing) for the wire format).
- Tokenizer is `porter unicode61` — handles Latin scripts well,
  case-insensitive, basic English stemming. Danish stems are
  not handled specifically.
- The endpoint is per-vault. Multi-vault search is implemented
  client-side as a parallel fan-out across selected vaults; see
  [frontend.md](frontend.md#search-box).
- Multi-term queries first run a strict AND match (every term in
  title or body); if that returns zero hits and the query has
  2+ terms, the server retries with OR (any single term) and
  sets `looseMatch=true` on the response.
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
