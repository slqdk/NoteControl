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

// ---------------------------------------------------------------- Startpage

/**
 * One RSS block on the per-vault startpage. Mirrors
 * NoteControl.Shared.Startpage.RssBlockDto.
 *
 * Position + size are in pixels relative to the startpage scrollable
 * area. Bounds are enforced client-side (see RssBlock.tsx); the
 * server stores values verbatim, so a future client could relax
 * the bounds without a server change.
 */
export interface RssBlockDto {
  id: string;             // crypto.randomUUID() at create time
  title: string;          // user-given title (empty falls back to feed title in UI)
  feedUrl: string;        // empty when block was just added
  x: number;              // pixels from left of startpage area
  y: number;              // pixels from top
  width: number;          // pixels; clamped client-side [200, 1200]
  height: number;         // pixels; clamped client-side [150, 1200]
  headlineSize: number;   // px font-size for item titles; clamped [10, 24]
  previewWords: number;   // words from item summary to show; clamped [0, 200]
  maxItems: number;       // truncate at this many items; clamped [1, 100]
}

export interface StartpageConfigDto {
  blocks: RssBlockDto[];
  /**
   * Task areas (step 42). Free-floating containers each holding a
   * list of sticky notes, persisted alongside the RSS blocks in
   * the same startpage.json. Older clients (pre-step-42) didn't
   * write this field; the server normalises missing/null to []
   * on load, so it's always an array on the wire from this point
   * on.
   */
  taskAreas: TaskAreaDto[];
}

/** One free-floating task area on the startpage (step 42). */
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
