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
- **Tables** (3×3 default, header row, with a toolbar for
  add/remove rows and columns). Column widths set by dragging
  the column resize handle persist across saves; row height
  is configurable per table via the toolbar's More-options
  panel.
- **Callouts** in 5 variants: error, warning, info, tip, note.
  Each is a colour-coded box with an icon. Callouts can
  contain any block content — paragraphs, lists, headings,
  code blocks, tables — and inline marks (bold, italic, etc.)
  inside the body round-trip correctly through save/reload.
- **Images**: inline, with hover controls (resize, replace,
  delete, alt-text).
- **Videos**: inline, with hover controls (similar to images).

What the editor does NOT do:

- No collaborative / real-time editing. One user writes a note
  at a time.
- No diff / version history beyond what the markdown file's
  filesystem mtime gives you. (Backups are how you go back.)
- No outline / minimap.

### Cursor escape from trailing blocks

The doc always ends with an empty paragraph the user can click
into when its last block is a "trapping" block — one whose
node-view occupies a full row and doesn't itself accept a click
below as "outside the block". This covers callouts, tables,
code blocks, horizontal rules, images, and videos. The
guarantee holds both on initial load (a saved note that ended
with a callout reopens with a clickable line beneath it) and
during editing (deleting the paragraph below a callout
re-creates an empty one).

The trailing paragraph is part of the editor state only — it
serialises to nothing in markdown — so it doesn't show up in
the saved `.md` file and doesn't appear when the file is
viewed outside NoteControl. It also can't be undone away with
Ctrl+Z.

### Keyboard shortcuts

The editor honours TipTap defaults: Ctrl+B (bold), Ctrl+I
(italic), Ctrl+U (underline), Ctrl+K (link), etc. Plus:

- **Ctrl+S** — force-save. Bypasses the debounce and also
  cancels any pending debounced save so there's no double-PUT.
  Suppresses the browser's "Save page as..." dialog. See
  [frontend.md](frontend.md#editor-view) for the full list of
  flush triggers and the navigation-guard behaviour.
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
italic, link (text input), inline code, and **Save selection
as template**. The link button uses the browser's
`window.prompt` today (queue item: replace with a proper
modal).

The "Save selection as template" button takes the current
selection and creates a new template from it. If the selection
crosses a table boundary on either side (a common case where
ProseMirror's table plugin would otherwise restrict the
selection to either a CellSelection or a paragraph-only
range), the saved range is expanded outward to enclose the
whole table — the user gets "what I selected, plus any table
I touched", never a selection that visibly contained a table
but was saved without it.

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
