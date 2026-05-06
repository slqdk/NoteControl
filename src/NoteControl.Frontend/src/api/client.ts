// API client for NoteControl. See ./types.ts for the JSON casing
// rationale. All DTOs use camelCase; this file's wire payloads follow.

import type {
  AuthMeDto,
  CreateNoteRequest,
  FeedDto,
  FolderListingDto,
  NoteDto,
  NoteSummaryDto,
  ProblemDetails,
  SearchResponseDto,
  StartpageConfigDto,
  UpdateNoteRequest,
  VaultDto,
} from './types';

let csrfToken: string | null = null;

/** Set after login / on auth init. Cleared on logout / 401. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
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
}

/**
 * The single fetch wrapper that everything else routes through.
 *
 * Returns the parsed JSON body, or `null` for 204 No Content responses.
 * Throws {@link ApiError} on any non-2xx status.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
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
  if (isMutation && csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  const response = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 401 && !options.skipAuthRedirect) {
    // Session expired or invalid. Clear CSRF and bounce.
    csrfToken = null;
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
    throw new ApiError(
      response.status,
      problem,
      `Request failed: ${response.status} ${response.statusText}`,
    );
  }

  if (response.status === 204) {
    return null as T;
  }

  const text = await response.text();
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
};

// ============================================================== VAULTS

export const vaultsApi = {
  /** GET /api/vaults — vaults the caller has any role on. */
  list: () => request<VaultDto[]>('/api/vaults'),

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
  update: (vaultId: string, notePath: string, request_: UpdateNoteRequest) =>
    request<NoteDto>(
      `/api/vaults/${vaultId}/note?path=${encodeURIComponent(notePath)}`,
      {
        method: 'PUT',
        body: request_,
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
  /** GET /api/vaults/{id}/search?q=... */
  query: (vaultId: string, q: string, folderPath = '') => {
    const params = new URLSearchParams({ q });
    if (folderPath) params.set('path', folderPath);
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
export const startpageApi = {
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
};
