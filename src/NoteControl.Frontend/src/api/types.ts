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
  createdAt: string;
  role: 'owner' | 'editor' | 'viewer';
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
   * Ship 68: free-text per-note version. Always non-empty on the
   * wire — the server fills in "v0.0" if the note's frontmatter
   * doesn't have a version key. The Properties panel surfaces this
   * for editing; the docx export renders it in the page-top header.
   */
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
  body: string;
  tags?: string[] | null;
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
   * Ship 68: free-text per-note version. null/undefined = leave alone,
   * any string = replace. Empty string is treated by the server as
   * "reset to default v0.0" (not "remove the field").
   */
  version?: string | null;
}

export interface NoteSummaryDto {
  path: string;
  name: string;
  lastModified: string;
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
