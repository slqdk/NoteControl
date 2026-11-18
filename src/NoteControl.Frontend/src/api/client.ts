// API client for NoteControl. See ./types.ts for the JSON casing
// rationale. All DTOs use camelCase; this file's wire payloads follow.

import type {
  ArchivedRelease,
  AuditEntryDto,
  AuthMeDto,
  AssignmentsConfigDto,
  BackupListItemDto,
  BackupRunResultDto,
  BackupStatusDto,
  CreateNoteRequest,
  FeedDto,
  FolderCoverUploadResponse,
  FolderListingDto,
  LinkPreviewDto,
  NoteDto,
  NoteHistoryInfo,
  NoteSummaryDto,
  NoteWidgetsConfigDto,
  ProblemDetails,
  ReleaseInfo,
  ReleasedVersions,
  RestoreResultDto,
  SearchResponseDto,
  ServerConfigDto,
  ServerInfoDto,
  ServerLogTailDto,
  StartpageConfigDto,
  SessionDto,
  UpdateNoteRequest,
  UserDto,
  VaultDto,
  VaultMemberDto,
} from './types';
import { recordApi } from '../util/debugRecorder';

let csrfToken: string | null = null;

/** Default name of the server's (non-HttpOnly) CSRF cookie. */
const CSRF_COOKIE = 'nc_csrf';

/** Set after login / on auth init. Cleared on logout / 401. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

function readCsrfCookie(): string | null {
  try {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + CSRF_COOKIE + '=([^;]*)'));
    return m && m[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * The token to echo in X-CSRF-Token. Read from the cookie at send
 * time: the server refreshes that cookie on every authenticated
 * response, so it always belongs to the session the browser is
 * actually sending. The in-memory copy went stale when the user
 * signed in again in another tab (every save and Sign out then got
 * 403). The in-memory value is the fallback for an install that
 * renamed the cookie (Auth:CsrfCookieName).
 */
export function getCsrfToken(): string | null {
  return readCsrfCookie() ?? csrfToken;
}

function isCsrfRejection(status: number, problem: ProblemDetails | null): boolean {
  return status === 403 && (problem?.title ?? '').startsWith('CSRF token');
}

/**
 * Re-learn the CSRF token from the server after a CSRF 403. GET /me
 * needs no token, returns the session's own token and re-sets the
 * cookie. Returns false when there is no session to refresh from.
 */
async function refreshCsrfToken(): Promise<boolean> {
  try {
    const r = await fetch('/api/auth/me', {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (!r.ok) return false;
    const me = (await r.json()) as AuthMeDto;
    if (!me?.csrfToken) return false;
    csrfToken = me.csrfToken;
    return true;
  } catch {
    return false;
  }
}

/**
 * Hook the AuthContext registers so 401s anywhere in the app can boot
 * the user back to login. Decoupled via this callback so api/client.ts
 * doesn't need to import React.
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/** Thrown for any non-2xx response. Carries the parsed problem detail. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails | null;

  constructor(status: number, problem: ProblemDetails | null, fallbackMessage: string) {
    super(problem?.detail || problem?.title || fallbackMessage);
    this.status = status;
    this.problem = problem;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Extra headers — typically just `If-Match` for ETag concurrency. */
  headers?: Record<string, string>;
  /** Suppress the global 401 handler (for login attempts). */
  skipAuthRedirect?: boolean;
  /**
   * fetch keepalive: lets the request outlive the page (tab close,
   * reload). Browsers cap keepalive bodies at 64 KB in total, so the
   * caller must only ask for it with small bodies.
   */
  keepalive?: boolean;
  /** Called with the raw Response (e.g. to read the ETag header). */
  onResponse?: (response: Response) => void;
}

/**
 * The single fetch wrapper that everything else routes through.
 *
 * Returns the parsed JSON body, or `null` for 204 No Content responses.
 * Throws {@link ApiError} on any non-2xx status.
 */
async function request<T>(
  path: string,
  options: RequestOptions = {},
  isCsrfRetry = false,
): Promise<T> {
  const method = options.method ?? 'GET';
  const isMutation = method !== 'GET';

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...options.headers,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  // CSRF: double-submit. The server compares the X-CSRF-Token header to
  // the value of the nc_csrf cookie (which the browser automatically sends).
  const csrf = isMutation ? getCsrfToken() : null;
  if (csrf) {
    headers['X-CSRF-Token'] = csrf;
  }

  // Debug recorder: capture timing + result. The __ncTyped marker
  // tells the global fetch patch (in util/debugRecorder.ts) to skip
  // logging this call — we record it ourselves here with richer
  // typed info.
  const t0 = performance.now();
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    keepalive: options.keepalive === true ? true : undefined,
    // @ts-expect-error — non-standard marker read by debug recorder
    __ncTyped: true,
  });

  options.onResponse?.(response);

  if (response.status === 401 && !options.skipAuthRedirect) {
    // Session expired or invalid. Clear CSRF and bounce.
    csrfToken = null;
    recordApi({
      method,
      path,
      body: options.body,
      status: 401,
      durationMs: Math.round(performance.now() - t0),
      errorStatus: 401,
      errorMessage: 'Not signed in.',
    });
    onUnauthorized?.();
    throw new ApiError(401, null, 'Not signed in.');
  }

  if (!response.ok) {
    let problem: ProblemDetails | null = null;
    try {
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('json')) {
        problem = (await response.json()) as ProblemDetails;
      }
    } catch {
      // Body wasn't JSON — fall through to the fallback message.
    }
    // CSRF mismatch (token lost after a browser restart, or replaced
    // by a sign-in in another tab): refresh it once and retry. The
    // server rejected the request before doing anything, so a retry
    // can't double-apply it.
    if (isMutation && !isCsrfRetry && isCsrfRejection(response.status, problem)) {
      if (await refreshCsrfToken()) {
        return request<T>(path, options, true);
      }
    }
    const errMsg = `Request failed: ${response.status} ${response.statusText}`;
    recordApi({
      method,
      path,
      body: options.body,
      status: response.status,
      durationMs: Math.round(performance.now() - t0),
      errorStatus: response.status,
      errorMessage: problem?.detail || problem?.title || errMsg,
    });
    throw new ApiError(response.status, problem, errMsg);
  }

  if (response.status === 204) {
    recordApi({
      method,
      path,
      body: options.body,
      status: 204,
      durationMs: Math.round(performance.now() - t0),
    });
    return null as T;
  }

  const text = await response.text();
  recordApi({
    method,
    path,
    body: options.body,
    status: response.status,
    durationMs: Math.round(performance.now() - t0),
  });
  if (text.length === 0) {
    return null as T;
  }
  return JSON.parse(text) as T;
}

// ============================================================== AUTH

export const authApi = {
  /** GET /api/auth/me — used on app load to detect existing session. */
  me: () => request<AuthMeDto>('/api/auth/me', { skipAuthRedirect: true }),

  /** POST /api/auth/login — returns user + fresh CSRF token. */
  login: (username: string, password: string) =>
    request<AuthMeDto>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
      skipAuthRedirect: true,
    }),

  /** POST /api/auth/logout — server clears session, we clear CSRF. */
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),

  /**
   * POST /api/auth/password — change the caller's own password.
   * Needs the current password; the server revokes the user's other
   * sessions and keeps this one. 400 with a reason on a wrong current
   * password or a policy failure.
   */
  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    request<void>('/api/auth/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),
};

// ============================================================== USERS (admin)

export interface CreateUserBody {
  username: string;
  email: string;
  password: string;
  role: 'admin' | 'user';
}

export interface UpdateUserBody {
  email?: string;
  role?: 'admin' | 'user';
  status?: 'active' | 'locked' | 'disabled';
}

export const usersApi = {
  /** GET /api/users — admin only. */
  list: () => request<UserDto[]>('/api/users'),

  /** POST /api/users — admin only. 409 on duplicate username. */
  create: (body: CreateUserBody) =>
    request<UserDto>('/api/users', { method: 'POST', body }),

  /** PUT /api/users/{id} — email / role / status; omitted fields unchanged. */
  update: (userId: string, body: UpdateUserBody) =>
    request<UserDto>(`/api/users/${userId}`, { method: 'PUT', body }),

  /** DELETE /api/users/{id} — refused for the last active admin. */
  remove: (userId: string) =>
    request<void>(`/api/users/${userId}`, { method: 'DELETE' }),

  /**
   * POST /api/users/{id}/password — admin reset, no current password.
   * Revokes ALL of the target's sessions (including the admin's own
   * when resetting themselves).
   */
  resetPassword: (userId: string, newPassword: string) =>
    request<void>(`/api/users/${userId}/password`, {
      method: 'POST',
      body: { currentPassword: null, newPassword },
    }),
};

// ============================================================== ADMIN: config, backups, export

export const adminApi = {
  /** GET /api/admin/server/config — effective server configuration. */
  getConfig: () => request<ServerConfigDto>('/api/admin/server/config'),

  /**
   * PUT /api/admin/server/config — the whole DTO is saved (the server
   * persists Auth, Backup, Logging and Network to config.json).
   * 400 ValidationProblem with per-field `errors` on bad input.
   */
  updateConfig: (config: ServerConfigDto) =>
    request<ServerConfigDto>('/api/admin/server/config', { method: 'PUT', body: config }),

  backupStatus: () => request<BackupStatusDto>('/api/admin/server/backup/status'),

  /** POST /api/admin/server/backup/run — runs synchronously; resolves when done. */
  runBackup: () => request<BackupRunResultDto>('/api/admin/server/backup/run', { method: 'POST' }),

  listBackups: () => request<BackupListItemDto[]>('/api/admin/server/backup/list'),

  deleteBackup: (id: string) =>
    request<void>(`/api/admin/server/backup/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * POST /api/admin/server/backup/{id}/restore-vault — replaces the live
   * vault's folder with the copy in the backup. The live folder is
   * kept as "<name>.pre-restore-<time>".
   */
  /** GET /api/admin/server/info — version, uptime, OS, restart capability. */
  serverInfo: () => request<ServerInfoDto>('/api/admin/server/info'),

  /**
   * POST /api/admin/server/restart — 202, then the process exits and
   * systemd starts it again (a few seconds). 409 outside systemd.
   */
  restartServer: () => request<{ restarting: boolean }>('/api/admin/server/restart', { method: 'POST' }),

  /**
   * GET /api/admin/audit — newest first, at most 200 per call. Page
   * backwards by passing the oldest timestamp seen as `until`.
   */
  audit: (q: { since?: string; until?: string; userId?: string; eventType?: string; limit?: number }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== '') p.set(k, String(v));
    }
    const qs = p.toString();
    return request<AuditEntryDto[]>(`/api/admin/audit${qs ? `?${qs}` : ''}`);
  },

  auditEventTypes: () => request<string[]>('/api/admin/audit/event-types'),

  /** GET /api/admin/server/logs/tail — last N lines of today's Serilog file, newest first. */
  logTail: (lines: number) => request<ServerLogTailDto>(`/api/admin/server/logs/tail?lines=${lines}`),

  restoreVault: (backupId: string, vaultId: string, vaultFolderInBackup: string) =>
    request<RestoreResultDto>(`/api/admin/server/backup/${encodeURIComponent(backupId)}/restore-vault`, {
      method: 'POST',
      body: { vaultId, vaultFolderInBackup },
    }),
};

/**
 * Download URLs for the zip exports. Plain GETs with the session
 * cookie, so they're used as <a href download> targets rather than
 * fetched — the browser streams the (possibly large) file to disk.
 */
export const exportUrls = {
  /** Whole DataRoot (admin). Importable with deploy/linux/import.sh. */
  full: () => '/api/admin/export',
  /** One vault folder (vault owner). */
  vault: (vaultId: string) => `/api/vaults/${vaultId}/export`,
};

// ============================================================== SESSIONS

export const sessionsApi = {
  /** GET /api/users/{id}/sessions — self, or any user for admins. */
  listForUser: (userId: string) =>
    request<SessionDto[]>(`/api/users/${userId}/sessions`),

  /** DELETE /api/sessions/{id} — session owner or admin. */
  revoke: (sessionId: string) =>
    request<void>(`/api/sessions/${sessionId}`, { method: 'DELETE' }),
};

// ============================================================== VAULTS

export const vaultsApi = {
  /** GET /api/vaults — vaults the caller has any role on. */
  list: () => request<VaultDto[]>('/api/vaults'),

  /**
   * GET /api/vaults?all=true — admin only: every vault on the server.
   * Vaults the admin has no permission row on come back with
   * myRole = "none" (visible, not openable).
   */
  listAll: () => request<VaultDto[]>('/api/vaults?all=true'),

  /**
   * POST /api/vaults — create a new vault. Path is
   * "users/<ownerUsername>/<name>" (personal) or "shared/<name>".
   * ownerUserId other than the caller requires admin.
   */
  create: (body: { path: string; name?: string; ownerUserId?: string }) =>
    request<VaultDto>('/api/vaults', { method: 'POST', body }),

  /** DELETE /api/vaults/{id} — owner only. Deletes the folder on disk too. */
  remove: (vaultId: string) =>
    request<void>(`/api/vaults/${vaultId}`, { method: 'DELETE' }),

  /** GET /api/vaults/{id}/permissions — members and their roles. */
  listMembers: (vaultId: string) =>
    request<VaultMemberDto[]>(`/api/vaults/${vaultId}/permissions`),

  /**
   * POST /api/vaults/{id}/permissions — owner only. Adds the user or
   * changes their role (editor | viewer; owner can't be granted).
   */
  share: (vaultId: string, username: string, role: 'editor' | 'viewer') =>
    request<VaultMemberDto>(`/api/vaults/${vaultId}/permissions`, {
      method: 'POST',
      body: { username, role },
    }),

  /** DELETE /api/vaults/{id}/permissions/{userId} — owner only. */
  unshare: (vaultId: string, userId: string) =>
    request<void>(`/api/vaults/${vaultId}/permissions/${userId}`, { method: 'DELETE' }),

  /**
   * Ship 91: PUT /api/vaults/{id}/appearance — set or clear the
   * vault's icon glyph and/or colour swatch. Either field can be
   * null individually; both null means "revert to auto-derived
   * avatar". Returns the updated VaultDto so the caller can
   * splice it into local state without a separate GET.
   *
   * 403 (server-side) when the caller has only viewer role —
   * editors and owners may rebrand. 400 if iconKey isn't in the
   * fixed 12-emoji palette or colorKey isn't a known swatch name;
   * the client picker constrains both, so a 400 means a stale
   * client / a hand-edited DOM, not normal operation.
   */
  updateAppearance: (
    vaultId: string,
    body: { iconKey: string | null; colorKey: string | null },
  ) =>
    request<VaultDto>(`/api/vaults/${vaultId}/appearance`, {
      method: 'PUT',
      body,
    }),
};

// ============================================================== NOTES

export const notesApi = {
  /**
   * GET /api/vaults/{id}/note?path=...
   * Returns null on 404 (note doesn't exist).
   */
  async get(vaultId: string, notePath: string): Promise<NoteDto | null> {
    try {
      return await request<NoteDto>(
        `/api/vaults/${vaultId}/note?path=${encodeURIComponent(notePath)}`,
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        return null;
      }
      throw e;
    }
  },

  /** POST /api/vaults/{id}/note — create. 409 if it already exists. */
  create: (vaultId: string, request_: CreateNoteRequest) =>
    request<NoteDto>(`/api/vaults/${vaultId}/note`, {
      method: 'POST',
      body: request_,
    }),

  /** PUT /api/vaults/{id}/note?path=... — update with optional ETag. */
  update: (
    vaultId: string,
    notePath: string,
    request_: UpdateNoteRequest,
    opts: { keepalive?: boolean } = {},
  ) =>
    request<NoteDto>(
      `/api/vaults/${vaultId}/note?path=${encodeURIComponent(notePath)}`,
      {
        method: 'PUT',
        body: request_,
        keepalive: opts.keepalive,
      },
    ),

  /** DELETE /api/vaults/{id}/note?path=... — soft-delete to trash. */
  delete: (vaultId: string, notePath: string) =>
    request<void>(
      `/api/vaults/${vaultId}/note?path=${encodeURIComponent(notePath)}`,
      { method: 'DELETE' },
    ),

  /**
   * PUT /api/vaults/{id}/note/move
   * Rename or relocate a note in a single operation. Body carries
   * both old and new paths so the server can validate, refuse on
   * collision, and re-index in one transaction.
   */
  move: (vaultId: string, oldPath: string, newPath: string) =>
    request<NoteDto>(`/api/vaults/${vaultId}/note/move`, {
      method: 'PUT',
      body: { oldPath, newPath },
    }),

  /**
   * GET /api/vaults/{id}/note/history?path=...
   *
   * @deprecated The 10-snapshot Revert ring was replaced by per-version
   * release archives (see {@link listReleases}). The endpoint survives
   * on the server as a stub that always returns `count: 0`, which keeps
   * the legacy pre-Ship-C mobile properties surface working — its
   * Revert button just stays disabled. Desktop code uses listReleases
   * instead and does not call this method.
   */
  getHistory: (vaultId: string, notePath: string) =>
    request<NoteHistoryInfo>(
      `/api/vaults/${vaultId}/note/history?path=${encodeURIComponent(notePath)}`,
    ),

  /**
   * GET /api/vaults/{id}/note/release?path=...
   *
   * @deprecated The single-frozen-release model was replaced by per-
   * version release archives (see {@link listReleases}). The endpoint
   * survives on the server as a stub that always returns
   * `exists: false`, which keeps the legacy pre-Ship-C mobile
   * properties surface working — its recall affordance just hides
   * itself. Desktop code uses listReleases instead and does not call
   * this method.
   */
  getRelease: (vaultId: string, notePath: string) =>
    request<ReleaseInfo>(
      `/api/vaults/${vaultId}/note/release?path=${encodeURIComponent(notePath)}`,
    ),

  /**
   * GET /api/vaults/{id}/note/releases?path=...
   *
   * List the archived released versions of a note, newest first. Each
   * entry was frozen at the moment the note entered Released state at
   * that (major, minor) version; archive entries are immutable and the
   * list grows monotonically (an unlock bumps the minor by one, and a
   * subsequent re-release adds a new entry without disturbing the
   * existing ones).
   *
   * Drives the Properties panel's "Previous releases" list. The list
   * is empty when the note has never been released.
   */
  listReleases: (vaultId: string, notePath: string) =>
    request<ReleasedVersions>(
      `/api/vaults/${vaultId}/note/releases?path=${encodeURIComponent(notePath)}`,
    ),

  /**
   * GET /api/vaults/{id}/note/releases/content?path=&versionMajor=&versionMinor=
   *
   * Read one archived released version's full body + frontmatter for
   * the read-only archive viewer. Returns 404 if no archive exists at
   * the requested version (e.g. the user opened a list entry that was
   * concurrently deleted by an admin sweep).
   */
  getReleaseContent: (
    vaultId: string,
    notePath: string,
    versionMajor: number,
    versionMinor: number,
  ) =>
    request<ArchivedRelease>(
      `/api/vaults/${vaultId}/note/releases/content` +
        `?path=${encodeURIComponent(notePath)}` +
        `&versionMajor=${versionMajor}` +
        `&versionMinor=${versionMinor}`,
    ),

  /**
   * DELETE /api/vaults/{id}/note/releases?path=...&versionMajor=...
   * Permanently removes one archived released version. The live note
   * is untouched. Returns 204 on success, 404 if the (major, minor)
   * pair has no archive. No undo — the archive is a frozen file and
   * once removed it's gone. Callers should confirm with the user
   * before invoking.
   */
  deleteRelease: (
    vaultId: string,
    notePath: string,
    versionMajor: number,
    versionMinor: number,
  ) =>
    request<void>(
      `/api/vaults/${vaultId}/note/releases` +
        `?path=${encodeURIComponent(notePath)}` +
        `&versionMajor=${versionMajor}` +
        `&versionMinor=${versionMinor}`,
      { method: 'DELETE' },
    ),

  /** GET /api/vaults/{id}/folder?path=... — list one folder. */
  listFolder: (vaultId: string, folderPath = '') =>
    request<FolderListingDto>(
      `/api/vaults/${vaultId}/folder?path=${encodeURIComponent(folderPath)}`,
    ),

  /**
   * GET /api/vaults/{id}/folder/recursive?path=...&limit=...
   * Flat list of every note under the given folder (and all
   * descendants), sorted by most-recently-updated first. Backed by
   * the search index on the server, so freshness matches the index
   * (live-updated by CRUD; rebuild for external edits).
   */
  listFolderRecursive: (vaultId: string, folderPath = '', limit = 100) => {
    const params = new URLSearchParams();
    if (folderPath) params.set('path', folderPath);
    params.set('limit', String(limit));
    return request<NoteSummaryDto[]>(
      `/api/vaults/${vaultId}/folder/recursive?${params.toString()}`,
    );
  },

  /**
   * Compute the GET URL for the export endpoint. The browser does
   * the actual download — we navigate (or click a hidden <a>) to
   * this URL and the cookie auth + Content-Disposition combine to
   * trigger a Save dialog with the right filename.
   *
   * Two formats:
   *   - 'docx' (default) → Word document via the rich-conversion
   *     pipeline (callouts, tables, embedded images).
   *   - 'md' → zip containing the note's .md plus its .assets/
   *     folder if it has one. Round-trips through the import
   *     endpoint with image references intact.
   *
   * 'pdf' was supported as a placeholder (server returned 501) but
   * was dropped from the UI; the export menu now exposes .docx and
   * .md only.
   */
  exportUrl: (vaultId: string, notePath: string, format: 'docx' | 'md' = 'docx') =>
    `/api/vaults/${vaultId}/note/export?path=${encodeURIComponent(notePath)}&format=${format}`,

  /**
   * POST /api/vaults/{id}/import (multipart/form-data)
   *
   * Imports either a single .md file or a .zip of .md + asset
   * files into the given target folder. The server resolves
   * conflicts by appending a numeric suffix (Foo.md → Foo (2).md)
   * — same convention as asset-upload collisions. Per-entry
   * failures inside a zip surface as "failed" rows in the result;
   * the whole batch never aborts on one bad file.
   *
   * Bypasses the shared request() helper for the same reason
   * assetsApi.upload does — multipart boundaries must come from
   * the browser, not a hand-set Content-Type header.
   */
  async import(
    vaultId: string,
    file: File,
    targetFolder: string,
  ): Promise<ImportNoteResult> {
    const form = new FormData();
    form.append('targetFolder', targetFolder);
    form.append('file', file, file.name);

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    const csrf = getCsrfToken();
    if (csrf) {
      headers['X-CSRF-Token'] = csrf;
    }

    const response = await fetch(`/api/vaults/${vaultId}/import`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: form,
    });

    if (!response.ok) {
      let problem: ProblemDetails | null = null;
      try {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('json')) {
          problem = (await response.json()) as ProblemDetails;
        }
      } catch {
        /* ignore */
      }
      throw new ApiError(
        response.status,
        problem,
        `Import failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as ImportNoteResult;
  },
};

/**
 * Per-entry outcome shape from POST /import. Mirrors the C#
 * ImportNoteEntry record. Outcome values:
 *   - "created"  the file was written at finalPath
 *   - "renamed"  the requested path collided; finalPath has a
 *                numeric suffix (e.g. "Foo (2).md")
 *   - "skipped"  zip contained an entry we don't import
 *                (non-.md outside any *.assets/ folder)
 *   - "failed"   the write attempt threw; errorMessage has detail
 */
export interface ImportNoteEntry {
  requestedPath: string;
  finalPath: string;
  outcome: 'created' | 'renamed' | 'skipped' | 'failed';
  errorMessage: string | null;
}

/** Mirrors C# ImportNoteResult. */
export interface ImportNoteResult {
  created: number;
  renamed: number;
  skipped: number;
  failed: number;
  entries: ImportNoteEntry[];
};

// ============================================================== ASSETS

/**
 * Shape returned by POST /note/asset. Mirrors the C# AssetUploadResponse.
 */
export interface AssetUploadResponse {
  relativeMarkdownPath: string;
  serveUrl: string;
  originalFileName: string;
  storedFileName: string;
  sizeBytes: number;
  contentType: string;
}

export const assetsApi = {
  /**
   * POST /api/vaults/{id}/note/asset (multipart/form-data)
   *
   * Uploads a file (image, video, document, anything) into the
   * note's `<basename>.assets/` folder. The server resolves
   * collisions, validates size/MIME, and returns the relative
   * markdown path plus the authenticated serve URL.
   *
   * We bypass the shared request() helper because that one sets
   * Content-Type: application/json — fetch needs to set the
   * multipart boundary itself, so we leave Content-Type unset and
   * the browser fills it in.
   */
  async upload(
    vaultId: string,
    notePath: string,
    file: File | Blob,
    fileName?: string,
  ): Promise<AssetUploadResponse> {
    const form = new FormData();
    form.append('notePath', notePath);
    // FormData requires a string filename for blobs. Caller can
    // pass an explicit one (e.g. when pasting from the clipboard
    // a Blob has no file name).
    const effectiveName =
      fileName ?? (file instanceof File ? file.name : 'paste.bin');
    form.append('file', file, effectiveName);

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    const csrf = getCsrfToken();
    if (csrf) {
      headers['X-CSRF-Token'] = csrf;
    }

    const response = await fetch(`/api/vaults/${vaultId}/note/asset`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: form,
    });

    if (!response.ok) {
      let problem: ProblemDetails | null = null;
      try {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('json')) {
          problem = (await response.json()) as ProblemDetails;
        }
      } catch {
        /* ignore */
      }
      throw new ApiError(
        response.status,
        problem,
        `Upload failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as AssetUploadResponse;
  },

  /**
   * Compute the GET URL for an asset given its canonical path.
   * Used when re-resolving a markdown image's relative href back
   * into something the browser can actually fetch (with auth).
   */
  serveUrl(vaultId: string, canonicalAssetPath: string): string {
    return `/api/vaults/${vaultId}/asset?path=${encodeURIComponent(canonicalAssetPath)}`;
  },
};

// ============================================================== SEARCH

export const searchApi = {
  /**
   * GET /api/vaults/{id}/search?q=...
   *
   * Optional `folderPath` restricts the search to one folder subtree
   * (passed through as `?path=`). Optional `limit` caps the number
   * of results — the server clamps anything > 200 anyway, and the
   * default (omitted) is 50. The SearchBox passes a smaller per-vault
   * limit when fanning out across multiple vaults so a wide fan-out
   * doesn't return hundreds of rows.
   */
  query: (vaultId: string, q: string, folderPath = '', limit?: number) => {
    const params = new URLSearchParams({ q });
    if (folderPath) params.set('path', folderPath);
    if (limit && limit > 0) params.set('limit', String(limit));
    return request<SearchResponseDto>(
      `/api/vaults/${vaultId}/search?${params.toString()}`,
    );
  },
};

// ============================================================== FOLDERS

export const foldersApi = {
  /**
   * POST /api/vaults/{id}/folder
   * Create an empty folder. Idempotent — safe to call if it already
   * exists. The server canonicalises the path and echoes it back.
   */
  create: (vaultId: string, folderPath: string) =>
    request<{ path: string }>(`/api/vaults/${vaultId}/folder`, {
      method: 'POST',
      body: { path: folderPath },
    }),

  /**
   * DELETE /api/vaults/{id}/folder?path=...
   * Refuses with 409 if the folder is not empty.
   */
  delete: (vaultId: string, folderPath: string) =>
    request<void>(
      `/api/vaults/${vaultId}/folder?path=${encodeURIComponent(folderPath)}`,
      { method: 'DELETE' },
    ),

  /**
   * PUT /api/vaults/{id}/folder/move
   * Rename or relocate a folder. All notes and subfolders move with it.
   * The server re-indexes contained notes so search keeps working.
   */
  move: (vaultId: string, oldPath: string, newPath: string) =>
    request<{ path: string }>(`/api/vaults/${vaultId}/folder/move`, {
      method: 'PUT',
      body: { oldPath, newPath },
    }),

  // ---------------------------------------------------------------- Cover

  /**
   * POST /api/vaults/{id}/folder/cover?path=... (multipart/form-data)
   *
   * Upload (or replace) the cover image for a folder. Empty path =
   * vault root. Image-only on the server side (PNG/JPEG/GIF/WebP/
   * BMP/SVG); other types return 415. Returns a cache-busted URL
   * the caller can drop into `<img src>` immediately.
   *
   * Mirrors assetsApi.upload's CSRF + Content-Type handling — the
   * browser sets the multipart boundary, so we don't set
   * Content-Type ourselves.
   */
  async uploadCover(
    vaultId: string,
    folderPath: string,
    file: File | Blob,
    fileName?: string,
  ): Promise<FolderCoverUploadResponse> {
    const form = new FormData();
    const effectiveName =
      fileName ?? (file instanceof File ? file.name : 'cover.png');
    form.append('file', file, effectiveName);

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    const csrf = getCsrfToken();
    if (csrf) {
      headers['X-CSRF-Token'] = csrf;
    }

    const response = await fetch(
      `/api/vaults/${vaultId}/folder/cover?path=${encodeURIComponent(folderPath)}`,
      {
        method: 'POST',
        headers,
        credentials: 'include',
        body: form,
      },
    );

    if (!response.ok) {
      let problem: ProblemDetails | null = null;
      try {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('json')) {
          problem = (await response.json()) as ProblemDetails;
        }
      } catch {
        /* ignore */
      }
      throw new ApiError(
        response.status,
        problem,
        `Cover upload failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as FolderCoverUploadResponse;
  },

  /**
   * DELETE /api/vaults/{id}/folder/cover?path=...
   * Idempotent — 204 whether or not a cover existed.
   */
  deleteCover: (vaultId: string, folderPath: string) =>
    request<void>(
      `/api/vaults/${vaultId}/folder/cover?path=${encodeURIComponent(folderPath)}`,
      { method: 'DELETE' },
    ),
};

// ============================================================== TEMPLATES

export interface TemplateSummaryDto {
  name: string;
  lastModified: string;     // ISO timestamp
}

export interface TemplateDto {
  name: string;
  body: string;
  lastModified: string;
}

export interface TemplateUpsertRequest {
  name: string;
  body: string;
}

export const templatesApi = {
  /** GET /api/vaults/{id}/templates */
  list: (vaultId: string) =>
    request<TemplateSummaryDto[]>(`/api/vaults/${vaultId}/templates`),

  /** GET /api/vaults/{id}/templates/{name} */
  get: (vaultId: string, name: string) =>
    request<TemplateDto>(
      `/api/vaults/${vaultId}/templates/${encodeURIComponent(name)}`,
    ),

  /** POST /api/vaults/{id}/templates */
  create: (vaultId: string, body: TemplateUpsertRequest) =>
    request<TemplateDto>(`/api/vaults/${vaultId}/templates`, {
      method: 'POST',
      body,
    }),

  /** PUT /api/vaults/{id}/templates/{name} — body MAY include a new name (rename). */
  update: (vaultId: string, name: string, body: TemplateUpsertRequest) =>
    request<TemplateDto>(
      `/api/vaults/${vaultId}/templates/${encodeURIComponent(name)}`,
      { method: 'PUT', body },
    ),

  /** DELETE /api/vaults/{id}/templates/{name} */
  delete: (vaultId: string, name: string) =>
    request<void>(
      `/api/vaults/${vaultId}/templates/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),

  /**
   * POST /api/vaults/{id}/template/asset (multipart/form-data)
   *
   * Ship 98: upload an image for a specific template. Returns the
   * same shape as a note-asset upload — the relativeMarkdownPath
   * is what the template body should reference (e.g.
   * "MyTemplate.assets/photo.png").
   *
   * Mirrors `assetsApi.upload` exactly except for the form field
   * name (`templateName` instead of `notePath`) and the URL.
   * Server enforces an image-only policy; non-image content types
   * return 415.
   */
  async uploadAsset(
    vaultId: string,
    templateName: string,
    file: File | Blob,
    fileName?: string,
  ): Promise<AssetUploadResponse> {
    const form = new FormData();
    form.append('templateName', templateName);
    const effectiveName =
      fileName ?? (file instanceof File ? file.name : 'image.bin');
    form.append('file', file, effectiveName);

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    const csrf = getCsrfToken();
    if (csrf) {
      headers['X-CSRF-Token'] = csrf;
    }

    const response = await fetch(`/api/vaults/${vaultId}/template/asset`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: form,
    });

    if (!response.ok) {
      let problem: ProblemDetails | null = null;
      try {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('json')) {
          problem = (await response.json()) as ProblemDetails;
        }
      } catch {
        /* ignore */
      }
      throw new ApiError(
        response.status,
        problem,
        `Template asset upload failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as AssetUploadResponse;
  },

  /**
   * POST /api/vaults/{id}/templates/from-selection
   *
   * Ship 98b: save a selection from a note as a new template.
   * Server picks the auto-name (no client-side name negotiation),
   * walks the markdown for image refs, copies referenced images
   * from the source note's asset folder into the new template's
   * own asset folder, and rewrites the markdown paths. Returns the
   * created TemplateDto so the caller can show the chosen name in
   * a toast.
   */
  createFromSelection: (
    vaultId: string,
    sourceNotePath: string,
    markdown: string,
  ) =>
    request<TemplateDto>(
      `/api/vaults/${vaultId}/templates/from-selection`,
      {
        method: 'POST',
        body: { sourceNotePath, markdown },
      },
    ),

  /**
   * POST /api/vaults/{id}/templates/{name}/render?targetNotePath=...
   *
   * Ship 98c: render a template for insertion into a specific
   * target note. The server reads the template's body, copies any
   * referenced images from .notesapp/templates/<name>.assets/ into
   * the target note's <basename>.assets/ folder (collision-safe),
   * and returns the markdown with image refs rewritten to point at
   * the new location.
   *
   * The slash-menu submenu calls this on every template pick (even
   * for text-only templates — the cost is negligible and one code
   * path is easier to reason about).
   */
  render: (vaultId: string, templateName: string, targetNotePath: string) => {
    const qs = new URLSearchParams({ targetNotePath }).toString();
    return request<{ body: string }>(
      `/api/vaults/${vaultId}/templates/${encodeURIComponent(templateName)}/render?${qs}`,
      { method: 'POST' },
    );
  },
};

// ============================================================== DAILY NOTES

/**
 * Response shape from <c>POST /api/vaults/{id}/daily/today</c>.
 * Mirrors NoteControl.Shared.DailyNotes.DailyNoteResponse on the
 * server.
 *
 *   path             — canonical note path, e.g.
 *                      "Daily Notes/2026/04-April/2026-04-30.md"
 *   created          — true if the server created the note as part
 *                      of this call; false if it already existed
 *   appliedTemplate  — name of the template used to seed the body,
 *                      or null if no daily template exists
 *                      (only meaningful when created === true)
 */
export interface DailyNoteResponseDto {
  path: string;
  created: boolean;
  appliedTemplate: string | null;
}

export const dailyNotesApi = {
  /**
   * POST /api/vaults/{id}/daily/today
   *
   * Idempotent. Returns today's daily note, creating it on the first
   * call of the day. Server applies the `daily-note` template if one
   * exists in the vault's `.notesapp/templates/` directory.
   */
  openToday: (vaultId: string) =>
    request<DailyNoteResponseDto>(`/api/vaults/${vaultId}/daily/today`, {
      method: 'POST',
    }),
};

// ============================================================== STARTPAGE

/**
 * Per-vault startpage config + RSS feed proxy. See server-side
 * NoteControl.Server.Startpage.Endpoints.StartpageEndpoints for the
 * routes; types live in api/types.ts mirroring NoteControl.Shared.
 */

// ============================================================ SIDECAR ETAGS

/**
 * GET a per-vault sidecar together with its ETag (see
 * util/sidecarSync.ts for why).
 */
async function getVersioned<T>(path: string): Promise<{ data: T; etag: string | null }> {
  let etag: string | null = null;
  const data = await request<T>(path, {
    onResponse: (r) => {
      etag = r.headers.get('ETag');
    },
  });
  return { data, etag };
}

/**
 * PUT a per-vault sidecar with If-Match. Rejects with ApiError 412
 * when it changed elsewhere; resolves with the new ETag.
 */
async function putVersioned<T>(path: string, body: T, etag: string | null): Promise<string | null> {
  let next: string | null = null;
  await request<void>(path, {
    method: 'PUT',
    body,
    headers: etag ? { 'If-Match': etag } : undefined,
    onResponse: (r) => {
      next = r.headers.get('ETag');
    },
  });
  return next;
}

export const startpageApi = {
  /** GET config + ETag (conflict-safe saving, util/sidecarSync.ts). */
  getConfigVersioned: (vaultId: string) =>
    getVersioned<StartpageConfigDto>(`/api/vaults/${vaultId}/startpage/config`),

  /** PUT config with If-Match; 412 when changed elsewhere. */
  saveConfigVersioned: (vaultId: string, config: StartpageConfigDto, etag: string | null) =>
    putVersioned(`/api/vaults/${vaultId}/startpage/config`, config, etag),

  /** GET /api/vaults/{id}/startpage/config */
  getConfig: (vaultId: string) =>
    request<StartpageConfigDto>(`/api/vaults/${vaultId}/startpage/config`),

  /** PUT /api/vaults/{id}/startpage/config */
  saveConfig: (vaultId: string, config: StartpageConfigDto) =>
    request<void>(`/api/vaults/${vaultId}/startpage/config`, {
      method: 'PUT',
      body: config,
    }),

  /**
   * GET /api/vaults/{id}/startpage/feed?url=...
   *
   * The server proxies the actual feed fetch (cross-origin RSS
   * is blocked by browsers; the server is the only thing that
   * can reach arbitrary feed URLs). It also caches in-memory for
   * 5 minutes so resizing a block doesn't refetch upstream.
   */
  fetchFeed: (vaultId: string, url: string) =>
    request<FeedDto>(
      `/api/vaults/${vaultId}/startpage/feed?url=${encodeURIComponent(url)}`,
    ),

  /**
   * GET /api/vaults/{id}/startpage/link-preview?url=...
   *
   * Server-side proxy that fetches a page and extracts OG /
   * Twitter Card / fallback metadata. Used by the Links block's
   * auto-fill flow when the user types a URL into a new entry.
   *
   * Returns mostly-empty fields for pages without metadata —
   * that's a successful response, not an error. Errors mean
   * the page was actually unreachable (timeout, SSRF block,
   * 4xx/5xx, DNS failure).
   *
   * Cached server-side for 1 hour per URL.
   */
  fetchLinkPreview: (vaultId: string, url: string) =>
    request<LinkPreviewDto>(
      `/api/vaults/${vaultId}/startpage/link-preview?url=${encodeURIComponent(url)}`,
    ),
};

// ============================================================ ASSIGNMENTS

/**
 * Per-vault assignments list. The route is the bare
 * /api/vaults/{id}/assignments (no /config sub-route) since
 * nothing else lives under it — keeps URLs short in logs.
 *
 * See server-side
 * NoteControl.Server.Assignments.Endpoints.AssignmentsEndpoints
 * for the auth split (GET = viewer, PUT = editor).
 */
export const assignmentsApi = {
  /** GET + ETag (conflict-safe saving, util/sidecarSync.ts). */
  getConfigVersioned: (vaultId: string) =>
    getVersioned<AssignmentsConfigDto>(`/api/vaults/${vaultId}/assignments`),

  /** PUT with If-Match; 412 when changed elsewhere. */
  saveConfigVersioned: (vaultId: string, config: AssignmentsConfigDto, etag: string | null) =>
    putVersioned(`/api/vaults/${vaultId}/assignments`, config, etag),

  /** GET /api/vaults/{id}/assignments */
  getConfig: (vaultId: string) =>
    request<AssignmentsConfigDto>(`/api/vaults/${vaultId}/assignments`),

  /** PUT /api/vaults/{id}/assignments */
  saveConfig: (vaultId: string, config: AssignmentsConfigDto) =>
    request<void>(`/api/vaults/${vaultId}/assignments`, {
      method: 'PUT',
      body: config,
    }),
};

/**
 * Per-vault note-widgets store. Route is the bare
 * /api/vaults/{id}/note-widgets (no /config sub-route), same shape as
 * assignmentsApi. GET reads the whole map (note path → widgets), PUT
 * replaces it. The editor loads the map once when a note opens and
 * PUTs the whole map back on a debounce — the single-user assumption
 * makes whole-file replace safe.
 *
 * See server-side
 * NoteControl.Server.NoteWidgets.Endpoints.NoteWidgetsEndpoints for
 * the auth split (GET = viewer, PUT = editor).
 */
export const noteWidgetsApi = {
  /** GET + ETag (conflict-safe saving, util/sidecarSync.ts). */
  getConfigVersioned: (vaultId: string) =>
    getVersioned<NoteWidgetsConfigDto>(`/api/vaults/${vaultId}/note-widgets`),

  /** PUT with If-Match; 412 when changed elsewhere. */
  saveConfigVersioned: (vaultId: string, config: NoteWidgetsConfigDto, etag: string | null) =>
    putVersioned(`/api/vaults/${vaultId}/note-widgets`, config, etag),

  /** GET /api/vaults/{id}/note-widgets */
  getConfig: (vaultId: string) =>
    request<NoteWidgetsConfigDto>(`/api/vaults/${vaultId}/note-widgets`),

  /** PUT /api/vaults/{id}/note-widgets */
  saveConfig: (vaultId: string, config: NoteWidgetsConfigDto) =>
    request<void>(`/api/vaults/${vaultId}/note-widgets`, {
      method: 'PUT',
      body: config,
    }),
};
