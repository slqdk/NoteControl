// Hand-maintained mirror of the C# DTOs in NoteControl.Shared.
// camelCase property names — see step 6d for the rationale.

// ---------------------------------------------------------------- Auth

export interface UserDto {
  id: string;
  username: string;
  email: string;
  role: 'admin' | 'user';
  status: 'active' | 'locked' | 'disabled';
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthMeDto {
  user: UserDto;
  csrfToken: string;
}

// ---------------------------------------------------------------- Vaults

export interface VaultDto {
  id: string;
  path: string;
  name: string;
  scope: 'personal' | 'shared';
  ownerId: string;
  /**
   * Username of the user identified by ownerId. Server-projected in
   * the same query that builds the row (VaultService.ListForUserAsync
   * et al.) so the picker can render "shared by Jacob" labels without
   * a separate users lookup. The C# DTO field is `OwnerUsername`;
   * ASP.NET's default camelCase serialiser emits it as
   * `ownerUsername`.
   */
  ownerUsername: string;
  createdAt: string;
  /**
   * Caller's effective role on this vault — one of "owner" | "editor"
   * | "viewer". The wire name is `myRole` (matches the C# property
   * `MyRole` → camelCase `myRole`); the field used to be declared
   * here as `role`, which silently produced undefined at runtime
   * because the JSON key didn't match. No code read it then, so the
   * mismatch went unnoticed; readers added now (the VaultPicker's
   * personal-vs-shared split, the role-gated topbar / rail / panel
   * affordances) need the real value, so the type now matches the
   * wire.
   */
  myRole: 'owner' | 'editor' | 'viewer';
  /**
   * Ship 91: optional emoji glyph for the topbar vault picker. One of
   * 12 from the fixed palette (📁 📓 🛠 🔧 💼 ✏️ 📊 🏠 🎓 🎨 🔬 📐).
   * undefined/null means "use the auto-derived first-letter avatar
   * (deterministic colour from name hash)" — every vault renders
   * cleanly without ever being configured.
   */
  iconKey?: string | null;
  /**
   * Ship 91: optional named colour swatch (one of "blue" | "green" |
   * "orange" | "purple" | "red" | "teal" | "amber" | "pink"). Same
   * fallback semantics as iconKey.
   */
  colorKey?: string | null;
}

// ---------------------------------------------------------------- Notes

export interface FrontmatterDto {
  created: string | null;
  updated: string | null;
  tags: string[];
  /**
   * Legacy field — the `locked` frontmatter key is no longer the source
   * of truth for editor read-only mode. Body lock is now derived from
   * `state === 'released'` (a Released note is locked; Under-development
   * is unlocked). The server still parses this field for round-trip
   * safety on pre-existing notes, but next save drops the key. The
   * desktop frontend ignores it; reading it remains supported only so
   * existing notes don't crash type-checking and so the mobile surface
   * (pre-Ship-C) keeps working unchanged.
   */
  locked: boolean;
  /**
   * Step 14 fields. Optional — null/undefined means "use the default".
   * font: a CSS font-family value (we send full stacks like
   *       "Inter, system-ui, sans-serif" so missing fonts fall back).
   * fontSize: in pixels.
   * width: page width in pixels (default 700, frontend enforces ≥ 700).
   */
  font: string | null;
  fontSize: number | null;
  width: number | null;
  /**
   * Versioning: a note's version is two integers, monotonic (the server
   * rejects any save that lowers it). `state` is the lifecycle state —
   * "not-versioned" (only at 0.0), "development", or "released"
   * (selectable only at version >= 1.0). `version` is a derived
   * "major.minor" string for read-only display / the docx header; the
   * two integer fields are the source of truth.
   */
  versionMajor: number;
  versionMinor: number;
  state: string;
  version: string;
}

export interface NoteDto {
  path: string;
  body: string;
  frontmatter: FrontmatterDto;
  etag: string;
  lastModified: string;
}

export interface CreateNoteRequest {
  path: string;
  body: string;
  tags?: string[] | null;
}

export interface UpdateNoteRequest {
  /**
   * The new note body, or null/undefined to leave the on-disk body
   * alone (the server only rewrites frontmatter in that case).
   *
   * Property saves from the Properties panel (Locked, Tags, Version,
   * Font, FontSize, Width) MUST send no body — otherwise a stale
   * snapshot held by the panel can overwrite newer content the
   * editor has just autosaved. The editor's own save flow is the
   * only path that should send body, paired with an etag.
   */
  body?: string | null;
  tags?: string[] | null;
  /**
   * Legacy — the server accepts this for backward compatibility but no
   * longer acts on it (body lock is derived from `state === 'released'`).
   * Desktop saves should omit it; sending it is harmless but pointless.
   */
  locked?: boolean | null;
  etag?: string | null;
  /**
   * Appearance overrides. null/undefined = leave alone.
   * To CLEAR a previously-set value: send empty string for font, or 0
   * for fontSize / width.
   */
  font?: string | null;
  fontSize?: number | null;
  width?: number | null;
  /**
   * Versioning. null/undefined = leave alone, non-null = set. The server
   * enforces the invariants and rejects bad changes with 400: version is
   * monotonic (can't go below current; equal is allowed for a pure state
   * change), "released" requires version >= 1.0, and no lifecycle state
   * is accepted at version 0.0. Changing `state` between development and
   * released drives the release-copy swap server-side.
   */
  versionMajor?: number | null;
  versionMinor?: number | null;
  state?: string | null;
}

/**
 * Info about a note's single frozen released copy. Mirrors
 * ReleaseInfoDto in the C# server.
 *
 * Deprecated as of the per-version release archive change. The server
 * now keeps one frozen entry per past Released entry, listed via
 * ReleasedVersions below. This endpoint survives as a stub that
 * always returns `exists: false` so the older mobile properties
 * surface (which hasn't been migrated yet) hides its recall affordance
 * cleanly. New desktop code should not call /note/release.
 */
export interface ReleaseInfo {
  exists: boolean;
  versionMajor: number;
  versionMinor: number;
  savedAt: string | null;
  developmentStashed: boolean;
}

/**
 * One archived released version of a note. Mirrors
 * ReleasedVersionSummaryDto in the C# server.
 *
 * Each entry is a frozen snapshot of the note as it was at the moment
 * it entered Released state at the given (major, minor) version.
 * Entries are immutable — leaving Released (which bumps the minor by
 * one) doesn't touch the existing archive.
 */
export interface ReleasedVersionSummary {
  versionMajor: number;
  versionMinor: number;
  savedAt: string;
}

/**
 * The full list of archived released versions for one note. Mirrors
 * ReleasedVersionsDto in the C# server. The list is newest first
 * (highest version on top), suitable for direct rendering in the
 * Properties panel's "Previous releases" section.
 */
export interface ReleasedVersions {
  archived: ReleasedVersionSummary[];
}

/**
 * One archived released version's full content for the read-only
 * archive viewer. Mirrors ArchivedReleaseDto in the C# server. The
 * frontmatter here reflects the snapshot's own version/state at the
 * time of release — not the live note's current values.
 */
export interface ArchivedRelease {
  path: string;
  versionMajor: number;
  versionMinor: number;
  body: string;
  frontmatter: FrontmatterDto;
  savedAt: string;
}

/**
 * Summary of how much undo-history is available for a single note.
 * Mirrors NoteHistoryInfoDto in the C# server.
 *
 * Deprecated as of the per-version release archive change. The 10-
 * snapshot ring was removed in favour of per-Released-entry archive
 * files (see ReleasedVersions). The endpoint survives as a stub that
 * always returns `count: 0` so older clients disable their Revert
 * button cleanly. New desktop code should not call /note/history.
 */
export interface NoteHistoryInfo {
  count: number;
  latest: string | null;
}

export interface NoteSummaryDto {
  path: string;
  name: string;
  lastModified: string;
  /**
   * Per-note version + lifecycle state. Used by:
   *   1. The tree, to render a per-note state badge on note icons
   *      (yellow dot = development, green tick = released, nothing
   *      = not-versioned).
   *   2. The FolderPage recursive listing, to group rows by lifecycle
   *      state (Released → Under development → Not versioned).
   * Both the `/folder` and `/folder/recursive` endpoints populate
   * these. Defaults are versionMajor=0, versionMinor=0, state="not-versioned"
   * when the server can't determine them (e.g. unreadable file).
   */
  versionMajor?: number;
  versionMinor?: number;
  state?: string;
}

/**
 * One subfolder entry returned in a folder listing. Mirrors the
 * server's FolderSummaryDto. The Path is the full canonical
 * forward-slash path inside the vault (e.g. "Projects/Q4"); Name is
 * the last segment ("Q4").
 */
export interface FolderSummaryDto {
  path: string;
  name: string;
}

export interface FolderListingDto {
  folderPath: string;
  subfolders: FolderSummaryDto[];
  notes: NoteSummaryDto[];
  recentlyUpdated: NoteSummaryDto[];
  /**
   * Server-built cover image URL when this folder has a cover, or
   * null/undefined when it doesn't. The URL embeds the file's mtime
   * as `?v=<unix-ms>` so a re-upload always produces a different URL
   * (defeats the browser cache without needing no-store headers on
   * the GET endpoint).
   */
  coverUrl?: string | null;
}

/** Response from POST /api/vaults/{id}/folder/cover (multipart upload). */
export interface FolderCoverUploadResponse {
  coverUrl: string;
  contentType: string;
  sizeBytes: number;
}

// ---------------------------------------------------------------- Search

export interface SearchResultDto {
  path: string;
  title: string;
  snippet: string;
  updated: string;
}

export interface SearchResponseDto {
  results: SearchResultDto[];
  indexing: boolean;
  /**
   * True when the server's strict AND query returned zero results and
   * it fell back to an OR query (any single term). The SearchBox
   * applies a client-side coverage filter to loose-match responses so
   * notes that don't actually contain every query term across path
   * + title + snippet get dropped. Always false for single-term
   * queries (no fallback is possible) and for queries that found at
   * least one strict hit. Optional in the type so older server
   * versions (which never emit it) decode without errors.
   */
  looseMatch?: boolean;
}

// ---------------------------------------------------------------- Errors

export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
}

// ---------------------------------------------------------------- Dashboards

/**
 * Per-vault dashboards configuration. Mirrors
 * NoteControl.Shared.Startpage.StartpageConfigDto.
 *
 * Persisted at {vault}/.notesapp/startpage.json. The endpoint
 * keeps its "startpage" name (route /api/vaults/{id}/startpage/
 * config + on-disk filename) for stable file/URL identity; the
 * shape it carries is multi-dashboard now.
 *
 * Always at least one dashboard — the server seeds a default one
 * named "Dashboard" on first load, and the UI prevents deleting
 * the last remaining dashboard.
 */
export interface StartpageConfigDto {
  /** Schema version. Current value is 2. Server is the authority. */
  version: number;
  /** Ordered list of dashboards in this vault. Order is user-meaningful. */
  dashboards: DashboardDto[];
}

/**
 * One dashboard inside a vault. Owns a free-floating canvas of
 * blocks (RSS, task areas, link blocks). Identity is `id`,
 * generated client-side via crypto.randomUUID() at create time.
 */
export interface DashboardDto {
  id: string;
  /** User-given name. Default "Dashboard" for the seeded one. */
  name: string;
  blocks: RssBlockDto[];
  taskAreas: TaskAreaDto[];
  links: LinkBlockDto[];
  /**
   * Motion-profile calculator blocks on this dashboard. Each block
   * carries its mode (A/B/C), persisted input values, and chart-toggle
   * state. May be undefined on payloads from older servers — the page
   * treats undefined as an empty array.
   */
  motionBlocks?: MotionBlockDto[];
}

/**
 * One RSS block on a dashboard. Mirrors
 * NoteControl.Shared.Startpage.RssBlockDto.
 *
 * Position + size are in pixels relative to the dashboard's
 * scrollable area. Bounds are enforced client-side (see RssBlock.tsx);
 * the server stores values verbatim, so a future client could relax
 * the bounds without a server change.
 */
export interface RssBlockDto {
  id: string;             // crypto.randomUUID() at create time
  title: string;          // user-given title (empty falls back to feed title in UI)
  feedUrl: string;        // empty when block was just added
  x: number;              // pixels from left of dashboard area
  y: number;              // pixels from top
  width: number;          // pixels; clamped client-side [200, 1200]
  height: number;         // pixels; clamped client-side [150, 1200]
  headlineSize: number;   // px font-size for item titles; clamped [10, 24]
  previewWords: number;   // words from item summary to show; clamped [0, 200]
  maxItems: number;       // truncate at this many items; clamped [1, 100]
}

/** One free-floating task area on a dashboard. */
export interface TaskAreaDto {
  id: string;            // crypto.randomUUID()
  title: string;         // empty allowed; UI shows placeholder
  x: number;
  y: number;
  width: number;         // clamped client-side [220, 800]
  height: number;        // clamped client-side [180, 1200]
  notes: StickyNoteDto[]; // top-to-bottom display order
}

/** One sticky note inside a TaskArea. */
export interface StickyNoteDto {
  id: string;            // crypto.randomUUID()
  headline: string;
  content: string;
  /**
   * Colour key from a fixed palette (yellow / pink / green /
   * blue / orange / purple / gray). Stored as a key, not a hex
   * code, so the visible palette can be retuned later without
   * rewriting saved notes.
   */
  color: string;
  done: boolean;
}

/**
 * One free-floating links block on a dashboard.
 * Mirrors TaskAreaDto's shape — same drag/resize semantics, same
 * id stability rules — but the children are link entries instead
 * of sticky notes, capped at 10 per block client-side.
 */
export interface LinkBlockDto {
  id: string;            // crypto.randomUUID()
  title: string;         // empty allowed; UI shows placeholder
  x: number;
  y: number;
  width: number;         // clamped client-side [220, 800]
  height: number;        // clamped client-side [180, 1200]
  items: LinkItemDto[];  // top-to-bottom display order; capped at 10
}

/** One link entry inside a LinkBlock. */
export interface LinkItemDto {
  id: string;            // crypto.randomUUID()
  /** Bold first line. */
  title: string;
  /** Smaller, muted second line. May be empty (row collapses to one line). */
  description: string;
  /** Where the entry navigates to. Opened in a new tab. */
  url: string;
  /**
   * Optional hotlinked thumbnail (og:image / twitter:image / favicon),
   * sourced from the /startpage/link-preview endpoint at edit time.
   * Empty means no thumbnail — the row renders without an image column.
   * Optional in TS for backward compat with `startpage.json` files
   * written before this field existed; the server's positional-record
   * default ("") means newly-saved entries always include it.
   */
  imageUrl?: string;
}

/**
 * One Motion-profile calculator block on a dashboard.
 * Mirrors NoteControl.Shared.Startpage.MotionBlockDto.
 *
 * Four modes share this DTO; `mode` picks which form is rendered
 * and which solver runs:
 *   - 'A' (Time → Dynamics):   inputs T, D, accFrac, dynFrac
 *   - 'B' (Dynamics → Time):   inputs aMax, dMax, jerk, D, vMax
 *   - 'C' (Dynamics + Limits): inputs aMax, dMax, jerk, Dmax, Ttot
 *   - 'D' (Motor / Gear + Time → Dynamics): all of A's inputs plus
 *     mechanical (gearRatio, feedConstant, torqueConstant) and
 *     motor/gear side fields (motorSpeed, motorTorque, gearSpeed,
 *     gearTorque). manualMotorSpeed/manualMotorTorque flags record
 *     whether the user has overridden the auto-computed motor side.
 *
 * Inputs are persisted as a free-form Record<string, number>. Keeping
 * the keys per-mode rather than typing them strictly trades a bit of
 * compile-time safety for a much simpler DTO + a single
 * normalise/store path on the server. If the schema ever needs strict
 * typing (e.g. a server-side calculation that depends on knowing keys
 * up front), this is the moment to split.
 */
export interface MotionBlockDto {
  id: string;            // crypto.randomUUID()
  /** Which solver this block runs. Set at insert-time, sticky. */
  mode: 'A' | 'B' | 'C' | 'D';
  x: number;
  y: number;
  width: number;         // clamped client-side [380, 1400]
  height: number;        // clamped client-side [320, 1200]
  /** Per-mode input values. Keys are mode-specific (see record summary). */
  inputs: Record<string, number>;
  /** Whether the chart's acceleration overlay is on. */
  showAcc: boolean;
  /** Whether the chart's jerk overlay is on. */
  showJerk: boolean;
  /**
   * Mode D only — true means the user has typed into the motor-side
   * speed field (or the gear-side speed, which propagates), and the
   * profile-derived value should NOT auto-overwrite it. The "↺" reset
   * button in the UI clears this back to false. Optional / undefined
   * → behaves as false (auto-coupled). Ignored for non-D modes.
   *
   * Note: there's no equivalent flag for torque because there's no
   * profile-to-torque mapping (no load-torque model), so torque is
   * always user-edited and motor↔gear torque stays in sync via the
   * gear ratio on every keystroke.
   */
  manualMotorSpeed?: boolean;
}

/** One feed item, normalized server-side from RSS or Atom. */
export interface FeedItemDto {
  title: string;
  link: string | null;
  summary: string;          // HTML stripped server-side; safe to render as text
  publishedAt: string | null; // ISO 8601 UTC, or null if the feed didn't supply one
}

/** Full feed payload from the proxy endpoint. */
export interface FeedDto {
  title: string;
  link: string | null;
  items: FeedItemDto[];
}

/**
 * OG / Twitter Card / fallback metadata payload from
 * GET /api/vaults/{id}/startpage/link-preview?url=...
 *
 * Used by the Links-block auto-fill flow: on URL blur in edit mode,
 * if the title is empty, the client fetches this and fills the
 * row's title / description / imageUrl from whatever's populated.
 *
 * Empty strings are valid for any field — they mean "the page
 * didn't expose this." The endpoint itself only errors on
 * unreachable / SSRF-blocked / timed-out fetches.
 */
export interface LinkPreviewDto {
  url: string;         // post-redirect canonical URL
  title: string;
  description: string;
  imageUrl: string;    // absolute http(s) URL, or empty
}

// --------------------------------------------------------------- Assignments

/**
 * Category key for an Assignment. The three values are pinned —
 * the UI groups by category and renders the buckets in this fixed
 * order (Short Term, Long Term, Development). Stored as a short
 * string in the JSON file so a hand-edit reads cleanly without a
 * legend.
 *
 * Unknown values from a hand-edit fall back to 'short' when
 * rendering (see AssignmentsPage).
 */
export type AssignmentCategory = 'short' | 'long' | 'dev';

/** One assignment row. Mirrors NoteControl.Shared.Assignments.AssignmentDto. */
export interface AssignmentDto {
  /** Stable id, generated client-side via newId(). */
  id: string;
  /** 'short' | 'long' | 'dev'. Wire type is a free string; UI normalises. */
  category: string;
  /** Single-line headline. May be empty; UI shows a placeholder. */
  subject: string;
  /** Multi-line body. May be empty. */
  details: string;
}

/**
 * Per-vault assignments configuration. Mirrors
 * NoteControl.Shared.Assignments.AssignmentsConfigDto.
 *
 * Persisted at {vault}/.notesapp/assignments.json. The endpoint is
 * /api/vaults/{id}/assignments (no /config suffix — unlike the
 * startpage endpoint group, there's nothing else under this route).
 *
 * Always non-null lists once the initial GET resolves; an empty
 * assignments list is the steady state for a fresh vault.
 */
export interface AssignmentsConfigDto {
  /** Schema version. Current value is 1. Server is the authority. */
  version: number;
  /** All assignments in stored order. UI groups by category at render time. */
  assignments: AssignmentDto[];
}

/**
 * One widget attached to a note, rendered in the note view above the
 * editor. Mirrors NoteControl.Shared.NoteWidgets.NoteWidgetDto.
 *
 * The concrete payload lives in exactly one of the typed fields,
 * selected by `kind`. These reuse the Startpage block DTOs verbatim
 * so the note-widget renderer can mount the existing RSS / Task /
 * Links / Motion components unchanged (their prop contract is
 * { block|area, onChange(patch), onDelete }).
 *
 * The payload's x/y/width/height are meaningful on the dashboard
 * canvas but NOT in the note view, which stacks widgets vertically
 * and ignores absolute position. Width/height may still inform the
 * widget's own sizing.
 */
export interface NoteWidgetDto {
  /** Stable id, crypto.randomUUID(). React key + edit/delete identity. */
  id: string;
  /**
   * Discriminator. Known values: 'rss' | 'task' | 'links' | 'motion'.
   * Unknown kinds are stored verbatim and skipped by the renderer
   * (forward-compat with newer builds).
   */
  kind: string;
  /** RSS payload — present iff kind === 'rss'. */
  rss?: RssBlockDto | null;
  /** Task area payload — present iff kind === 'task'. */
  task?: TaskAreaDto | null;
  /** Links payload — present iff kind === 'links'. */
  links?: LinkBlockDto | null;
  /** Motion payload — present iff kind === 'motion'. */
  motion?: MotionBlockDto | null;
  /** Motor compare payload — present iff kind === 'motor'. */
  motor?: MotorBlockDto | null;
  /** Unit converter payload — present iff kind === 'convert'. */
  convert?: ConvertBlockDto | null;
}

/**
 * Live unit-converter widget config. Mirrors
 * NoteControl.Shared.NoteWidgets.ConvertBlockDto.
 *
 * A category is selected and the user edits any unit field; the others
 * update live. Persistence stores ONE base-SI value per category in
 * `values` (keyed by category id), not per-unit text — so there's no
 * rounding drift and each category remembers its own value across
 * switches. Unit factors live in the frontend (util/convertUnits.ts);
 * the server treats this payload as opaque.
 */
export interface ConvertBlockDto {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Active category id: force|torque|mass|inertia|length|rotspeed. */
  category: string;
  /** Base-SI value per category, keyed by category id. */
  values?: Record<string, number> | null;
}

/**
 * Synchronous vs. asynchronous motor comparison widget config. Mirrors
 * NoteControl.Shared.NoteWidgets.MotorBlockDto.
 *
 * A teaching animation: one rotating stator field drives a synchronous
 * rotor (locked to the field) beside an asynchronous rotor (lagging by
 * the slip, which grows with load). Both machines share pole-pairs and
 * line frequency for a fair compare.
 *
 * Physics (simplified for intuition):
 *   synchronous speed  n_s = 60·f / p   [rpm], p = pole pairs
 *   slip               s   = (load/100) · (ratedSlipPct/100), clamped
 *   async rotor speed  n_r = n_s · (1 − s)
 *
 * x/y ignored in the note stack; width/height drive layout.
 */
export interface MotorBlockDto {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Pole pairs (p), shared by both machines. 1..12. */
  polePairs: number;
  /** Line frequency in Hz, shared. 0..100. */
  frequencyHz: number;
  /** Mechanical load percent 0..100 — drives async slip. */
  loadPct: number;
  /** Rated slip percent at full load (typ. 1..6). */
  ratedSlipPct: number;
  /** Whether the animation is running. */
  running: boolean;
}

/**
 * Per-vault note-widgets store. Mirrors
 * NoteControl.Shared.NoteWidgets.NoteWidgetsConfigDto.
 *
 * Persisted at {vault}/.notesapp/note-widgets.json. The endpoint is
 * /api/vaults/{id}/note-widgets. `byNote` maps a note's vault-relative
 * path (with .md, '/' separators) to that note's ordered widget list.
 * Notes with no widgets are absent from the map.
 *
 * Caveat: widgets live in this sidecar, NOT in the .md body, so they
 * do not appear in source view or docx/.md export and don't travel
 * with a hand-copied .md file.
 */
export interface NoteWidgetsConfigDto {
  /** Schema version. Current value is 1. Server is the authority. */
  version: number;
  /** note path → ordered widget list. */
  byNote: Record<string, NoteWidgetDto[]>;
}
