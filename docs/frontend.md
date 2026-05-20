# Frontend (web UI)

The browser-side React + TypeScript SPA. Read this when you're
touching routes, the top bar, the properties panel, sticky
notes, RSS blocks, the startpage, settings, or the appearance
system. The editor itself, slash menu, daily-note formatting,
and tree behaviour are documented in [notes.md](notes.md).

## Routes

The full route table:

| Path | Page | Auth | Notes |
|---|---|---|---|
| `/login` | Login form | anonymous | Username + password. POSTs `/api/auth/login`. |
| `/vaults` | Vault list | required | Picks a vault. Auto-redirects to last-opened vault if one is remembered. |
| `/vaults/:vaultId` | Folder view | required | Tree on the left, folder contents in the middle, properties on the right. |
| `/vaults/:vaultId/note?path=…` | Editor | required | Single-note editor. The path is URL-encoded. |
| `/vaults/:vaultId/startpage` | Startpage | required | Per-vault dashboard with movable blocks. |
| `/vaults/:vaultId/templates` | Templates | required | Manages the vault's template files. Has its own header (no shared layout). |
| `*` (anything else) | redirect to `/vaults` | n/a | |

The folder, editor, and startpage routes share a common
**VaultLayout** that mounts once per vault session. Switching
between a folder and a note (or between two notes) does not
unmount the layout — the tree's cached children, expanded set,
and selection survive navigation. The templates page does NOT
use this layout (it's full-width).

## App frame

Everything renders inside `.nc-app-frame` — a centred band of
configurable width:

- **Width**: 1000–2400 px in steps of 50, default 1600. Set
  globally per-browser, not per-vault.
- **Outside the frame**: a configurable preset gradient acts as
  a "desk surface" — visible as left/right gutters on monitors
  wider than the frame.
- **Light/dark variants**: each gradient preset has separate
  light and dark CSS values; the active one follows the
  browser's `prefers-color-scheme`.

Both width and gradient preference are stored in localStorage.
Cross-tab changes propagate via the `storage` event.

## Top bar

The top bar contains, left to right:

1. **Brand / vault picker** — depends on context:
   - On the vault list page: just the brand text.
   - On any `/vaults/:vaultId/*` page with the full vault list
     loaded: a desktop-only **vault picker**. ≤ 3 vaults render
     as inline pills. > 3 vaults render as the active pill +
     dropdown for the others. Right-click on the active pill
     opens an **appearance popover** (12 emoji + 8 colour swatches
     + auto fallback) for changing the vault's icon/colour.
2. **Search box** — searches the current vault. Submits to
   `/api/vaults/{id}/search`. Hits open the result in the editor.
3. **Rail toggle slot** — placeholder filled by VaultLayout. Has
   two buttons (📁 toggles the tree rail, ℹ️ toggles the
   properties panel) in vault routes. Empty on routes without a
   shared layout.
4. **Templates link** — direct route to the templates page for
   the current vault (in vault routes).
5. **Account menu** — current user's name, with a popover menu
   (Account, My sessions, Settings, Sign out).

## Settings (web UI, not the tray)

Two settings groups, both per-browser via localStorage:

### Appearance
Configurable from the appearance cog in the top bar:
- App frame width (1000–2400 px).
- Gradient preset (6 presets: Slate, Sky, Mint, Peach, Lavender,
  Charcoal — each with light + dark variants).

### Note defaults
Configurable from the same panel:
- Default note width (700–2400 px, default 1000). Resolution
  order: per-note frontmatter `width` → this default → CSS
  baseline (700).
- Default font (one of the system aliases: System UI, Sans-serif,
  Serif, Monospace, Inter, Rubik, JetBrains Mono — or "Default").
  Per-note frontmatter `font` overrides.
- Default font size in pixels. Per-note frontmatter `fontSize`
  overrides.

### Tree behaviour
One preference today:
- **Row click expands**: when true (default), clicking anywhere
  on a folder row both selects+navigates AND toggles expansion.
  When false, only the chevron toggles expansion. Double-click
  always toggles in either mode.

Server-side configuration (logging, networking, HTTPS, SMTP,
backups, authentication knobs, etc.) is in the **tray**, not
the web UI. See [tray.md](tray.md).

## Folder view

Layout: **3 panes**.

- **Left rail (tree)**: collapsible (toggle in topbar).
- **Centre**: a recursive **"All notes under X"** list of every
  note at or below the current folder, sorted most-recently-
  updated first. The list is **compact and zebra-striped**:
  each row is a single line with the note's name (relative to
  the current folder, .md stripped) on the left and a timestamp
  on the right showing both a relative form and an absolute
  short date (`1 hour ago · May 20`; the year suffix appears
  only when the date isn't this year). Even-indexed rows pick
  up a tinted background from the active theme's stripe colour
  — the same `--nc-stripe-bg-*` variables the Links startpage
  block uses, so the stripe shade follows whatever gradient
  preset the user has picked and switches automatically between
  light and dark variants. Long names truncate with ellipsis;
  the full path is in the link's browser-default tooltip.
  Pages with zero notes show a muted "No notes here yet."
  placeholder instead of the list.

  The centre pane also includes inline rows for "new folder"
  and "new note" prompts (desktop), plus the mobile-only
  bottom-of-page "+ Add note or folder" composer.

  The compact styling is opt-in via the `nc-list-compact`
  modifier on the list element; other callers of the shared
  `nc-list` class (e.g. the vault picker) keep the original
  taller-row styling.
- **Right rail (properties)**: collapsible. Shows metadata for
  the selected note or folder; editable name/tags/locked/version
  inline. Includes a Move button that toggles the layout into
  "move mode" (clicking a folder in the tree completes the move).

## Editor view

The editor opens when a note is selected. The layout still has
the tree on the left and the properties panel on the right, so
navigation between notes feels like a real desktop app — no
re-mount, no full-page reload.

Auto-save is **debounced ~1.5s after the last keystroke**. A
small badge in the topbar shows save state (Saved, Saving,
Error). Ctrl+S forces an immediate save.

The editor renders the note inside a fixed-width "page" surface
(default 700 px, configurable via frontmatter or the global
note-default). Content wider than the page (e.g. wide tables,
images) overflows horizontally with its own scrollbar; the page
itself doesn't grow.

The editor is **TipTap-based** with a custom extension set;
features and shortcuts are documented in [notes.md](notes.md).
The custom extensions include LaTeX/KaTeX math rendering
(inline and block); see [notes.md § Math](notes.md#math) for
delimiter rules, the edit popover, and the symbol palette.

## Properties panel

Shows the selected note or folder's metadata. For notes:

- **Editable inline**: name, tags, locked toggle, version,
  per-note appearance (font / font size / page width).
- **Read-only**: full path, parent folder, created/updated
  timestamps, size in bytes, frontmatter dump (raw YAML for
  debugging).
- **Buttons**: Move (toggles move-mode), Delete (with
  confirmation). Rename happens by editing the name inline.

For folders: name, full path, contents count, created/updated
timestamps. Move/Delete buttons available.

The panel toggles via the rail-toggle button in the topbar (or
collapses automatically on narrow viewports).

## Mobile

A few mobile-specific affordances:

- Tree and properties rails collapse by default on narrow
  viewports.
- Properties panel content is rendered inside the editor itself
  via `MobileNoteProperties` when the right rail is hidden, so
  edits to name/tags/etc. stay accessible.
- **The topbar's Templates link is hidden** at ≤ 768 px —
  template management is a desktop workflow; the route is still
  reachable by URL, but isn't surfaced.
- Touch resize handles for images/videos in the editor are
  **not** in scope yet (queue item).

This is desktop-first software. Mobile is "doesn't break,"
not "first-class."

## Templates page

Per-vault template manager at `/vaults/:vaultId/templates`.
Reached via the **Templates** link in the topbar (visible only
when a vault is in scope) or by navigating directly. **Hidden
on mobile** (viewports ≤ 768 px) — the link is suppressed via
CSS because template editing is a desktop-only workflow; mobile
users who need the page can still reach it by typing the URL
or via a bookmark, but the page layout itself isn't tuned for
narrow viewports.

The page sits outside the shared `VaultLayout` — it has its
own header and uses the full app-frame width (no tree, no
properties panel).

The page is **two-column**:

- **Left rail** — list of existing templates, sorted
  alphabetically (server-side). Each row shows the template
  name and last-modified timestamp. A **+ New template** button
  at the top of the rail starts a new draft.
- **Right pane** — editor for the currently-selected template.
  Shows the template's name (editable text input) and body
  (rich TipTap editor — same surface as the note editor, with
  the restrictions documented in [notes.md](notes.md)). When
  nothing is selected, the pane shows an empty-state hint.

### Save semantics

**No autosave.** A **Save** button at the bottom of the right
pane commits the draft. The button is enabled when:

- For a new (unsaved) draft: the name field is non-empty.
- For an existing template: the draft's name or body differs
  from what was loaded.

Save dispatches `POST /templates` for new drafts and
`PUT /templates/{originalName}` for edits. A name change on an
existing template uses the same `PUT` (the server treats a
different name in the body as a rename). After a successful
save the page reloads the list and re-selects the (possibly
renamed) template.

A **Delete** button appears next to Save when editing an
existing template — confirms, then `DELETE /templates/{name}`.

### Cache refresh

After any save or delete the page calls
`refreshTemplates(vaultId)`, which repopulates the module-level
cache that the editor's slash menu reads from. This is the only
mechanism that updates the slash-menu cache while a vault
session is alive — the cache otherwise refreshes only when a
`NoteEditor` instance mounts (i.e. when you navigate to or
between notes).

### Caveats

- The slash-menu cache is **per-tab in-memory only**. If you
  have an editor tab open in a second window and create a
  template in the first window's templates page, the second
  tab's slash menu won't see the new template until that editor
  remounts (switch to a different note and back).
- The cache refresh **silently swallows errors** (auth race
  during page load, transient network failure). If the cache
  stays empty after the page initialises, the slash menu's
  Templates entry won't appear in editors until a successful
  refresh runs. This is a known limitation; a forced refresh
  from the slash menu UI itself isn't currently available.

## Templates submenu in the slash menu

Inside any note editor, typing `/` opens the slash menu. When
the vault has at least one template (i.e. the cache is
non-empty for the vault), a **Templates** entry sits at **the
top of the menu** — position 0, above all built-in block items.

Selecting it (Enter, click, or arrow-down + Enter) **swaps the
popup in place** to a submenu listing all templates
alphabetically. The first row is **← Back**, which returns to
the main menu. Picking a template inserts its body at the
original `/` position; the popup closes.

There is **no search box and no preview pane** in the
submenu — by design, this is a flat clickable list. Filtering
happens in the main menu (typing `/temp` narrows to the
Templates entry plus anything else matching).

Esc inside the submenu returns to the main menu. Esc in the
main menu closes the popup entirely.

The Templates entry **disappears when the cache is empty** —
there's no "0 templates" placeholder. The cache is empty either
when the vault genuinely has no templates or when the initial
fetch failed (see caveat above). The Templates page itself
remains reachable via the topbar link regardless.

The template editor's own slash menu (when editing a template
body) hides this Templates entry — see
[notes.md](notes.md#templates) for why.

## Startpage

Per-vault dashboard at `/vaults/:vaultId/startpage`. The
canvas is a free-form 2D area (no grid) with three block types:

- **RSS feed block** — fetches and displays a feed via the
  server's `/api/vaults/{id}/startpage/feed` proxy. Drag header
  to move; bottom-right handle to resize. Gear icon opens
  per-block settings (feed URL, title, max items).
- **Task area** — a titled box containing draggable sticky
  notes. Each sticky has: a checkbox (done state, visual only),
  a one-line headline, a multi-line content textarea, and a gear
  menu. Notes have one of a fixed colour palette (yellow is
  default).
- **Links block** — up to 10 link entries (title + description
  + URL), click-to-edit, opens in new tab on click when not
  editing.

Block layout (positions, sizes, contents) is stored in
`{vault}/.notesapp/startpage.json` and saved with debounced
~500ms cadence after the last edit.

Adding a block: the topbar's **Widgets+** dropdown (when on the
startpage route) lists "Add RSS feed", "Add Task area", "Add
Links". The dropdown communicates with the page via window
`CustomEvent`s — no shared context.

## Sticky notes

Sticky notes only exist inside Task areas on the startpage.
They are not standalone documents and do not have markdown
files. Each sticky has:

- Headline (single line, editable inline).
- Content (multi-line textarea, auto-sizing where supported,
  with a manual resize grip fallback).
- Done state (visual only — strikethrough + opacity).
- One of 6 colours (yellow default).
- Reorder via drag-and-drop within their parent area.

## Search box

In the topbar. Submits the current text to
`/api/vaults/{id}/search`. Displays results in a dropdown panel
under the box: each row shows note title, path breadcrumb, and
a snippet with the match highlighted. Clicking a result
navigates to the editor at that note's path.

The search is server-side FTS5; behaviour and tokenisation rules
are in [notes.md](notes.md).

## Account menu

A small popover triggered from the user's name in the topbar.
Items:

- **Account** — change own password, change email.
- **My sessions** — list of own active sessions, with revoke
  buttons.
- **Settings** — opens the appearance/notes/tree settings panel.
- **Sign out** — POSTs `/api/auth/logout`, clears in-memory
  state, navigates to `/login`.

## Keyboard shortcuts

App-level (anywhere in the SPA):

| Key | Action |
|---|---|
| Esc | Clear tree selection (when not in an input or the editor) |

Editor-level shortcuts are TipTap defaults plus a few custom
ones — documented in [notes.md](notes.md).

## State persistence (localStorage)

Per-browser preferences and ephemeral state:

| Key | What |
|---|---|
| `nc:appearance` | App frame width + gradient preset |
| `nc:note-defaults` | Default note width / font / font size |
| `nc:tree-behaviour` | rowClickExpands flag |
| `nc:last-vault-id` | Last vault opened (for redirect from `/vaults`) |
| `nc:tree-expanded:<vaultId>` | Set of expanded folder paths per vault |

These are best-effort and can be cleared without breaking the
app — defaults take over.

## Browser support

Modern Chromium and Firefox, current major versions. Uses APIs
that may not be in older browsers:

- **`field-sizing: content`** for sticky notes' auto-resize
  textareas (Chrome 123+, Firefox 122+) — falls back to a manual
  resize grip on older browsers.
- **`navigator.clipboard.read()`** for image-paste — requires a
  secure context (HTTPS or localhost). On plain HTTP from a
  remote host, paste-image does nothing.
- **Pointer Events** for drag/resize gestures — universal in
  current browsers; not supported in IE11 (which we don't aim
  for anyway).

Dark mode follows `prefers-color-scheme` automatically; there is
no in-app toggle.
