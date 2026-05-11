# Frontend (web UI)

The browser-side React + TypeScript SPA. Read this when you're
touching routes, the top bar, the properties panel, sticky
notes, RSS blocks, dashboards, assignments, settings, or the
appearance system. The editor itself, slash menu, daily-note
formatting, and tree behaviour are documented in
[notes.md](notes.md).

## Routes

The full route table:

| Path | Page | Auth | Notes |
|---|---|---|---|
| `/login` | Login form | anonymous | Username + password. POSTs `/api/auth/login`. |
| `/vaults` | Vault list | required | Picks a vault. Auto-redirects to last-opened vault if one is remembered. |
| `/vaults/:vaultId` | Folder view | required | Tree on the left, folder contents in the middle, properties on the right. |
| `/vaults/:vaultId/note?path=…` | Editor | required | Single-note editor. The path is URL-encoded. |
| `/vaults/:vaultId/dashboards/:dashboardId` | Dashboard | required | One dashboard's free-floating canvas. See [Dashboards](#dashboards). |
| `/vaults/:vaultId/assignments` | Assignments | required | Per-vault list of assignments grouped by category. See [Assignments](#assignments). |
| `/vaults/:vaultId/startpage` | (redirect) | required | Legacy alias. Loads the vault's dashboard list and replaces itself with the first dashboard's URL. Kept so existing links (the tray's "open vault" menu, the vault list page, user bookmarks) still land somewhere useful. |
| `/vaults/:vaultId/templates` | Templates | required | Manages the vault's template files. Has its own header (no shared layout). |
| `*` (anything else) | redirect to `/vaults` | n/a | |

The folder, editor, and dashboard routes share a common
**VaultLayout** that mounts once per vault session. Switching
between a folder, a note, or a dashboard does not unmount the
layout — the tree's cached children, expanded set, selection,
AND the loaded dashboards config all survive navigation. The
templates page does NOT use this layout (it's full-width).

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
     loaded: a **vault picker** with two layout variants:
     - **Desktop** (> 768 px): inline pills. Pills that fit
       render in the original vault order; whichever pills
       don't fit fold into a "+N ▾" overflow dropdown. The
       active vault is treated like any other pill — if it
       doesn't fit, it ends up in the dropdown and the trigger
       gains the active highlight. Right-click on the active
       pill (or on the trigger when the active vault is hidden)
       opens an **appearance popover** (12 emoji + 8 colour
       swatches + auto fallback) for changing the vault's
       icon/colour.
     - **Mobile** (≤ 768 px): a single trigger pill (active
       vault's avatar + name + caret) that opens a dropdown
       listing every vault. No inline-pill overflow algorithm
       and no appearance popover — vault customisation stays a
       desktop workflow.
2. **Search box** — searches the current vault. Submits to
   `/api/vaults/{id}/search`. Hits open the result in the editor.
3. **Rail toggle slot** — placeholder filled by VaultLayout. Has
   two buttons (📁 toggles the tree rail, ℹ️ toggles the
   properties panel) in vault routes. Empty on routes without a
   shared layout.
4. **Widgets+ button** — visible on every dashboard URL
   (`/vaults/:id/dashboards/:dashboardId` and the legacy
   `/vaults/:id/startpage` redirect). Drops down "Add RSS feed
   / Add Task area / Add Links"; selecting one fires a window
   `CustomEvent` that the dashboard page listens for.
5. **Templates link** — direct route to the templates page for
   the current vault (in vault routes).
6. **Account menu** — current user's name, with a popover menu
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
- **Centre**: folder listing — current folder's contents as a
  list with name + kind + updated timestamp + size. Includes
  inline rows for "new folder" and "new note" prompts.
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

## Properties panel

Right-rail panel. Shape depends on what the URL is on:

### For a selected note

- **Editable inline**: name, tags, locked toggle, version,
  per-note appearance (font / font size / page width).
- **Read-only**: full path, parent folder, created/updated
  timestamps, size in bytes, frontmatter dump (raw YAML for
  debugging).
- **Buttons**: Move (toggles move-mode), Delete (with
  confirmation). Rename happens by editing the name inline.

### For a selected folder

Name, full path, contents count, created/updated timestamps.
Move/Delete buttons available.

### For a dashboard

The panel switches into a small dashboard-only view on any
`/vaults/:id/dashboards/:id` URL:

- **Editable inline**: name (same `EditableName` component the
  note/folder rename UI uses; empty/slash-bearing names
  rejected; duplicate-name attempts surface an inline error).
- **Read-only**: type ("Dashboard").
- **Buttons**: Delete (with confirmation), disabled when this
  is the only dashboard in the vault.

### Visibility

The panel toggles via the rail-toggle button in the topbar (or
collapses automatically on narrow viewports). Two separate
visibility states are tracked:

- **Note/folder routes**: the persisted `propsVisible`
  preference (per-browser localStorage).
- **Dashboard routes**: an ephemeral "revealed" flag that
  defaults to **hidden** on every dashboard URL change (initial
  load, switching between dashboards, returning from a note).
  The user reveals it on demand via the same ℹ️ rail toggle.

Switching between contexts doesn't bleed state: a note-side
"panel open" preference is left untouched while the user is on
a dashboard, and reappears when they navigate back to a note.

## Mobile

At viewports ≤ 768 px the shell flips to a single-column layout
with its own dedicated navigation surface (the **MobileNavBar**)
in place of the desktop tree rail. Properties stay edit-able
inline inside the editor. A few other desktop-only affordances
are suppressed (see bullets at the bottom).

### MobileNavBar

The MobileNavBar mounts directly under the top bar on every
`/vaults/:vaultId/*` route and is the primary navigation surface
on mobile — the tree rail is **not** rendered. The navbar is two
stacked horizontally-scrolling rows of round circular buttons,
each with an icon glyph and a label underneath. Horizontal
overflow scrolls; scrollbars are hidden so the rows read as
chrome rather than a list.

**Row 1 — anchors.** Always visible. Fixed order:

1. **Assignments** — calendar-clipboard icon (📋) on amber.
   Navigates to `/vaults/:vaultId/assignments`. Active ring lights
   up when the user is on the assignments page.
2. **Daily notes** — calendar icon (📅) on teal. Pinned at this
   position regardless of the vault's folder list. Tapping it
   opens **today's daily note** (via the same `openToday` flow
   used by the desktop's `Daily+` button) AND anchors row 2 to
   the **Daily Notes folder's immediate children** (year folders)
   — see "anchor override" below. The button always renders, even
   when the vault has no `Daily Notes` folder yet; the server
   creates the folder + today's file on the first tap.
3. **Each root folder** — folder icon (📁) on a neutral-grey
   backdrop, in the server's natural order, with the literal
   `Daily Notes` folder filtered out (it's hoisted to position 2).
   Tapping a folder navigates to its listing page; active ring
   lights up when the URL's first path segment matches.

All folder buttons share a single neutral-grey circle fill —
folders are distinguishable by label. Only the fixed-identity
anchors (Assignments amber, Daily Notes teal) and notes in row 2
(teal) use a palette colour.

**Row 2 — contextual children.** Walks with the user as they
navigate:

- **On a folder view** (`?path=A/B`) — shows the immediate
  subfolders and notes of that folder.
- **On the editor** (`/note?path=A/B/foo.md`) — shows the
  immediate children of the note's parent folder, so the user
  can hop to a sibling note in one tap.
- **On Assignments / dashboards / vault root** — hidden.
- **On a folder with no children** — hidden.

Subfolder buttons use the same neutral-grey treatment as row 1;
note buttons use a flat teal. Tapping a subfolder navigates into
it (row 2 then walks down to show its children); tapping a note
opens the editor.

**Anchor override.** When the user taps Daily notes, row 2 is
forced to show the `Daily Notes` folder's own immediate children
even though the editor URL is now on a note nested several
levels deeper inside it. The override is local component state
— ephemeral, not persisted. It clears as soon as the user taps
any other anchor button or any child in row 2; from that point
the URL-derived "walks with you" logic resumes. A page refresh
or deep-link starts with no override (a bookmarked URL on
today's note doesn't pretend the user came from the Daily Notes
anchor).

The active ring on Daily Notes reflects the override — it lights
up while the override is in effect, and goes dark the moment the
user navigates away.

### Mobile folder Add footer

On folder listing pages (`/vaults/:vaultId?path=...`, also the
vault root), the bottom of the content area renders an
**+ Add note or folder** button (mobile only). Tapping it opens
an inline composer with:

- A **Note / Folder** pill selector.
- A name input.
- Cancel / Create buttons.

Validation matches the desktop tree's inline new-row inputs:
empty rejected, slashes rejected, dup names rejected
case-insensitively against the current folder's children. On a
successful Note create, the editor navigates to the new note;
on a successful Folder create, the composer collapses and the
new folder appears on the navbar (row 1 if at vault root, row 2
otherwise) after the listing refresh.

Desktop folder views deliberately skip this footer — note and
folder creation belongs in the tree rail header buttons (📄+ /
📁+) there.

### Other mobile-specific behaviours

- Properties panel content for notes is rendered inside the
  editor itself via `MobileNoteProperties` when the right rail
  is hidden, so edits to name/tags/etc. stay accessible. There
  is no separate mobile properties surface for folders — folder
  rename/move stay desktop workflows.
- **The topbar's Templates link is hidden** at ≤ 768 px —
  template management is a desktop workflow; the route is still
  reachable by URL, but isn't surfaced.
- The vault picker collapses to a single-trigger dropdown
  variant (see "Top bar" above).
- Dashboards redirect to `/vaults/:vaultId` on mobile — the
  free-floating canvas has no working interaction model on
  touch. The navbar has no dashboard surface either.
- Touch resize handles for images/videos in the editor are
  **not** in scope yet (queue item).

This is desktop-first software. Mobile is "doesn't break,"
not "first-class."

> **Implementation note.** The legacy `.nc-mobile-tree-*`,
> `.nc-rail-mobile`, and `[data-tree-expanded]` CSS rules in
> `styles.css` are unused after the redesign and are kept
> in place pending a cleanup ship. Don't add new rules under
> those selectors; use `.nc-mobile-nav-*` instead.

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

## Dashboards

Each vault holds one or more named **dashboards**, each owning
its own free-floating canvas of blocks. The canvas is a 2D area
(no grid) with four block types:

- **RSS feed block** — fetches and displays a feed via the
  server's `/api/vaults/{id}/startpage/feed` proxy. Drag header
  to move; bottom-right handle to resize. Gear icon opens
  per-block settings (feed URL, title, max items).
- **Task area** — a titled box containing draggable sticky
  notes. Each sticky has: a checkbox (done state, visual only),
  a one-line headline, a multi-line content textarea, and a
  gear menu. Notes have one of a fixed colour palette (yellow
  is default).
- **Links block** — up to 10 link entries (title + description
  + URL), click-to-edit, opens in new tab on click when not
  editing.
- **Motion calculator block** — a jerk-limited S-curve solver,
  picked at insert-time from one of four sub-modes:
  - **Calculator A** (Time → Dynamics): given travel time and
    distance plus acc/dec ratio and S-curve sharpness sliders,
    solves for peak velocity, acceleration, and jerk.
  - **Calculator B** (Dynamics → Time): given dynamics limits
    and a max velocity, solves for the resulting acc / cruise
    / dec timings over a given distance. A "Set min. distance"
    button fills in the smallest distance at which the system
    can actually reach max velocity.
  - **Calculator C** (Dynamics + Limits → Velocity): given
    dynamics limits, a distance, and a total time, solves for
    the highest peak velocity that fits inside both budgets.
  - **Calculator D** (Motor / Gear + Time → Dynamics): same
    motion math as A, plus a motor/gear panel above the form.
    The panel has mechanical inputs (gear ratio, feed constant,
    torque constant) and bidirectional motor↔gear conversion
    of speed and torque (auto-syncs on every keystroke). The
    motor side speed auto-fills from the motion profile and
    can be manually overridden; a ↺ reset button next to the
    motor speed re-couples it to the profile.
  All four render the same velocity chart with optional
  Acceleration and Jerk overlays. Inputs persist per block.

Block layout (positions, sizes, contents) for ALL dashboards
in a vault is stored in a single `{vault}/.notesapp/startpage.json`
file (see [storage.md](storage.md#notesapp-subfolder) for the
file schema and the legacy single-canvas read tolerance). The
file is saved with debounced ~500ms cadence after the last
edit.

Adding a block to the current dashboard: the topbar's
**Widgets+** dropdown lists "RSS feed", "Task area", "Links",
and a **Motion ▸** entry. The Motion entry **swaps the popup
in place** to a submenu with a "← Back" row plus the four
calculators (A through D) — same in-place-swap pattern as the
slash menu's Templates submenu. The dropdown communicates
with the dashboard page via window `CustomEvent`s — no shared
context.

### Tree-side dashboards list

The tree's left rail starts with the dashboards section: one
row per dashboard, with the active one highlighted (matched
against the URL's `:dashboardId`). Right-click a row for a
small context menu:

- **Rename** — swaps the row to an inline editable input
  (Enter saves, Esc cancels, blur commits). Empty / whitespace
  / duplicate-of-sibling names are rejected.
- **Delete** — confirms, then removes the dashboard. Disabled
  when this is the only dashboard left.

Adding a new dashboard: the **🏠+** button in the tree's
rail-header action row (next to `Daily+ / 📄+ / 📁+`). The
button is desktop-only — hidden at ≤ 768 px (see
[Mobile](#mobile)) since a dashboard's free-form canvas isn't
usable on touch. New dashboards land at the end of the list,
get a default name ("Dashboard", or "Dashboard 2",
"Dashboard 3"… — the lowest unused number), and the URL
navigates to them immediately.

### State plumbing

VaultLayout owns the per-vault dashboards config (the
StartpageConfigDto for the whole vault) via the `useDashboards`
hook — one fetch + one debounced save loop per vault session.
Both the tree-side DashboardList and the dashboard canvas read
from this same data, with mutations going through layout-
provided callbacks. There is no second source of truth; adding
a dashboard, switching to it, and editing widgets on it are
all the same React state.

### Properties panel

See [Properties panel](#properties-panel) above for the
dashboard fields. The panel is hidden by default on every
dashboard URL change (including switches between dashboards),
revealed on demand via the ℹ️ rail toggle.

## Assignments

Per-vault Assignments page at `/vaults/:vaultId/assignments`.
Sits inside the shared `VaultLayout`, so the tree + topbar
stay in place when the user navigates to it.

The page lists the vault's assignments grouped into three
**fixed-order** category buckets:

1. **Short Term** — red accent.
2. **Long Term** — yellow accent.
3. **Development** — blue accent.

The order is part of the contract — the UI never sorts the
buckets at runtime. An empty bucket still renders its header
+ a muted "No assignments here yet" hint, so the user always
sees the same three-section structure.

Inside a bucket, assignments render in stored-insertion order
as a responsive card grid:

- **Desktop**: `grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`
  — typically one column in a narrow rail, two on a wide one.
- **Mobile** (≤ 768 px): forced single-column stack; the whole
  page becomes one long scrollable list.

Each card shows the assignment's **subject** (single-line
headline) and, if non-empty, **details** (multi-line, newlines
preserved). A trash icon in the top-right of every card
deletes after a confirm. There is **no checkbox** and no
strikethrough — by design; the lifecycle is add → optionally
edit → delete, without a "done but kept around" state. (This
is the deliberate difference from sticky notes in task areas,
which DO have a done flag.)

Clicking anywhere on a card (outside the trash icon) flips
it into inline edit mode: a category dropdown, subject
input, and details textarea, with **Done** and **Delete**
buttons. Esc inside any field collapses the edit form.
Changing the category in edit mode immediately moves the
card to the new bucket on the next render.

### Composer

A persistent **+ Add assignment** button at the bottom of
the page opens an inline composer in its place. The composer
shows three colour-coded **category pills** (Short Term /
Long Term / Development) selectable at first sight, a
subject input, and a details textarea. Subject is required;
the **Add** button stays disabled until it's non-empty.
Enter in the subject field submits; Ctrl/Cmd+Enter in the
details field submits; Esc cancels. Cancelling the composer
discards the in-progress draft.

### Tree-side row

The tree's left rail carries a single **📋 Assignments**
row, rendered directly below the dashboards section and
above the folder rows. Same visual treatment as the
dashboards section (font-weight + bottom-divider). Active
when the URL is exactly `/vaults/:vaultId/assignments`.

Unlike the dashboards section, this row is **visible on
mobile too** — there's only ever one Assignments page per
vault, the mobile layout (single-column stack) is fully
usable, and the user wanted it always reachable.

### Persistence

Stored as a single JSON file at
`{vault}/.notesapp/assignments.json` (see
[storage.md](storage.md#notesapp-subfolder) for the file
schema). Read once on initial page load; written debounced
~500ms after the last edit. Same atomic temp-then-rename
write pattern the startpage config uses.

### Properties panel

The Assignments page has no per-item selection that maps
onto the properties panel's note/folder/dashboard surfaces,
so the panel is **hidden by default** on this route. The
ℹ️ rail toggle still flips visibility (reusing the same
ephemeral "revealed" flag the dashboard routes use); when
revealed, the panel falls back to its empty-selection
state.

## Sticky notes

Sticky notes only exist inside Task areas on a dashboard.
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
