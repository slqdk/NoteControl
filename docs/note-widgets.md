# Note widgets

Interactive widgets attached to a single note, rendered in the
band above the editor (above the note's top rule). Added via the
Properties panel's **＋ Add Note Widget** dropdown. Persisted in
a per-vault sidecar — `.notesapp/note-widgets.json` keyed by
note path — NOT in the note's `.md` body.

This doc is the **kind catalog** plus the framework contract
that hosts them. For the framework's place in the wider UI see
[frontend.md § Note widgets](frontend.md#note-widgets); for the
on-disk file shape see
[storage.md § note-widgets.json](storage.md#notesapp-subfolder);
for the HTTP endpoints see
[api.md § Note widgets](api.md#note-widgets).

## Why a sidecar, not the `.md` body

Note widgets are interactive React surfaces (an animated motor
compare, an RSS feed, a Motion calculator). They have no faithful
markdown representation, so embedding their state in the `.md`
body would either bloat the file with serialised JSON-in-HTML or
lose state on round-trip through source view / `.docx` export.

Keeping them out of the body also removes the body-overwrite
hazard the Properties panel already guards against: widget edits
never touch the note body or its etag, so a stale editor
snapshot cannot clobber a widget change, and vice versa.

The trade-off — surfaced to the user when they add a widget:

- Invisible in source view and in `.md` / `.docx` export.
- Don't travel if the bare `.md` file is copied out of the vault.
- Bound to the note by its path — the app's move/rename flow
  does not currently re-key the sidecar, so renaming or moving
  a note (in the app or by hand on disk) orphans its widgets.
  Tracked separately.

## The host

Each widget is rendered inside a per-widget host element with:

- **Auto-fit height by default.** The child is `position:
  relative` and flows in normal layout, so the host wraps it
  exactly — no clipping, no fixed host height.
- **Manual height override.** A full-width grab strip at the
  bottom of the host. Drag to set an explicit height (written
  to the widget payload's `height`, clamped 120–1600 px),
  double-click to reset to the kind's default.
- **Measured width.** The host uses a `ResizeObserver` to
  measure its own content width and hands that pixel width to
  the widget, so the widget fills the note column (not its
  dashboard width). x/y from the widget's DTO are forced to 0
  and any x/y the widget writes back is discarded — there is
  no coordinate space in the note stack.
- **No double resize grip.** The dashboard widgets carry their
  own bottom-right resize handle for the dashboard canvas; CSS
  hides that handle inside a note host so there's a single
  full-width grip instead.

Source view (the editor's view-mode toggle) **hides the
note-widget band** — widgets aren't part of the markdown, so
showing them over raw source would be misleading.

## Add flow

The Properties panel and the editor page live in different
branches of the tree (panel in `VaultLayout`, editor in the
routed page). The Add menu therefore dispatches a window
`CustomEvent`:

- **Event:** `nc:add-note-widget`
- **Detail:** `{ notePath: string, kind: NoteWidgetKind,
  motionMode?: 'A' | 'B' | 'C' | 'D' }`

The editor listens, ignores events whose `notePath` doesn't
match the open note (a stale panel selection mustn't drop a
widget on the wrong note), builds a freshly-seeded widget from
the kind + optional motionMode, and appends it to the open
note's slice of the map. Same decoupling pattern as the
topbar's **Widgets+** dropdown talking to DashboardPage on
the startpage.

## Persistence cadence

The editor loads the whole per-vault map once when the vault
changes and slices the open note's widgets out of it. Switching
notes within the same vault is a re-slice, not a refetch.
Add/edit/delete updates the in-memory map and debounce-saves
the whole map back at ~500ms cadence via
`PUT /api/vaults/{id}/note-widgets`. The single-user / last-
write-wins concurrency model is shared with `startpage.json`
and `assignments.json`.

## Kind catalog

Every widget carries a stable `id` (client-generated UUID),
a `kind` discriminator, and exactly one payload field selected
by `kind`. Width/height live on the payload.

The first four kinds **reuse the dashboard's Startpage block
DTOs verbatim** as their payloads, so the dashboard's React
components render unchanged in a note. Adding a kind that's
already a Startpage block is a wiring change; new note-native
kinds add a new payload field on the wrapper DTO.

### rss — RSS feed

- **Source:** shared with the dashboard's RSS block.
- **Payload:** `RssBlockDto` (see `NoteControl.Shared/Startpage/StartpageDtos.cs`).
- **Behaviour:** identical to the dashboard's RSS block — feed
  URL, headline size, preview words, max items.
- **Default height in-note:** 320 px.

### task — Task area

- **Source:** shared with the dashboard's Task area.
- **Payload:** `TaskAreaDto`.
- **Behaviour:** identical to the dashboard. Sticky notes
  inside still work — they are not standalone documents.
- **Default height in-note:** 380 px.

### links — Links

- **Source:** shared with the dashboard's Links block.
- **Payload:** `LinkBlockDto`.
- **Behaviour:** identical to the dashboard.
- **Default height in-note:** 320 px.

### motion — Motion calculator

- **Source:** shared with the dashboard's Motion block.
- **Payload:** `MotionBlockDto`. The Add menu surfaces all
  four modes (A / B / C / D); the chosen mode is seeded on the
  payload at add time using the dashboard's own per-mode
  defaults (`MOTION_DEFAULTS`).
- **Default height in-note:** 460 px (mode A–C) or 640 px
  (mode D).

### motor — Motor compare (sync / async)

Note-native widget (no dashboard counterpart). A teaching
animation: a rotating stator field drives a synchronous rotor
(locked to the field) beside an asynchronous rotor (lagging
the field by the slip, which grows with load).

- **Inputs:** pole-pairs (1..12, shared), line frequency Hz
  (0..100, shared), field-speed rpm slider (coupled to Hz via
  pole-pairs), load % (0..100), rated slip % (0..10).
- **Physics (deliberately simplified for intuition, not
  calibrated):**
  ```
  n_sync  = 60·f / p         [rpm]   p = pole pairs
  slip    = (load/100) · (ratedSlipPct/100), clamped to [0, 0.95]
  n_async = n_sync · (1 − slip)
  ```
  The widget renders the formula alongside the substituted
  numbers so a reader sees where every figure on screen comes
  from. The on-screen spin is slowed by a fixed display factor
  so a 3000 rpm machine doesn't visually blur; the numeric
  readouts show the true values.
- **Payload:** `MotorBlockDto` in
  `NoteControl.Shared/NoteWidgets/NoteWidgetDtos.cs`.
- **Default height in-note:** 420 px.

### convert — Unit converter

Note-native widget. Live multi-unit conversion: pick a
category, type a value in any unit, all the others update
instantly.

- **Categories (v1):** Force, Torque, Mass, Inertia, Length,
  Rotational speed.
- **Units:** metric + imperial + servo-typical, e.g. `kgf`,
  `lbf·ft`, `oz·in`, `kg·cm²` (the one the Beckhoff AM/AG
  datasheets use), `g·cm²`, `slug·ft²`, `rpm`, `rev/s`.
- **Model — single source of truth.** The payload stores ONE
  base-SI value per category (`values[categoryId]`). Each
  field renders as `base / unit.factor`; editing sets
  `base = typed × unit.factor`. No per-unit text on disk →
  no cross-unit rounding drift. Switching categories preserves
  each category's value because they're all kept in the map.
- **Unit factors** live entirely in the frontend
  (`src/util/convertUnits.ts`). Exact-by-definition where they
  exist (`lbf = 4.4482216152605 N`, `lb = 0.45359237 kg`,
  `in = 0.0254 m`, etc.). Adding a unit or category is a
  frontend-only change — the server treats the payload as
  opaque, so no DTO bump.
- **Payload:** `ConvertBlockDto`.
- **Default height in-note:** 340 px.

## Forward-compat

Unknown `kind` values are **preserved verbatim** in the
sidecar — both server normalisation and the client renderer
skip them silently rather than dropping the row. A newer build
that wrote a kind this build doesn't recognise is safe to open
in the older build; the unknown widgets just don't render
until the user opens the newer build again.
