# HTTP API reference

Behavioural reference for the server's HTTP surface. Paths,
methods, and what they do — but **not** request/response JSON
shapes (those live in `NoteControl.Shared/` and change with the
DTOs; see the source for the wire format).

Use this when you're adding/removing/changing an endpoint.
Update the relevant table below in the same change.

## Auth requirements

Every endpoint has one of these auth requirements:

- **anon** — no authentication required.
- **auth** — a valid session cookie required (`nc_sid`).
- **admin** — auth + caller's user `Role` must be `admin`.
- **vault:role** — auth + caller has `role` or higher on the
  specified vault. Roles, lowest to highest: `viewer` <
  `editor` < `owner`. The site-wide admin role does **not**
  grant vault access; an admin needs an explicit
  `VaultPermission` to read/write someone else's vault.

State-changing methods (POST, PUT, DELETE, PATCH) additionally
require the CSRF header `X-CSRF-Token` matching the `nc_csrf`
cookie. GET/HEAD do not.

## Auth

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| POST | `/api/auth/login` | anon | Username + password. Returns user + CSRF token. Sets `nc_sid` + `nc_csrf` cookies. Rate-limited per-IP and per-account. |
| POST | `/api/auth/logout` | auth | Revokes the current session, clears cookies. |
| GET | `/api/auth/me` | auth | Returns current user (id, username, email, role). |
| POST | `/api/auth/local-token` | anon (loopback only) | Tray auto-login. Body: `{token}`. Returns a session for the bootstrap admin (or first active admin). 403 for non-loopback callers. |

## Sessions

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/api/users/{userId}/sessions` | auth (self or admin) | Lists the user's active sessions. |
| DELETE | `/api/sessions/{sessionId}` | auth (session owner or admin) | Revokes one session. |

## Users

All under `/api/users`, all admin-only.

| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/users` | List all users. |
| GET | `/api/users/{id}` | Get one user. |
| POST | `/api/users` | Create user (username, email, role, password). |
| PUT | `/api/users/{id}` | Update user (rename, email, role, status). |
| DELETE | `/api/users/{id}` | Delete user. Refused if it's the last active admin. |
| POST | `/api/users/{id}/password` | Change a user's password (admin reset). |

Self-password-change reuses `POST /api/users/{id}/password` —
the endpoint allows the calling user OR an admin.

## Vaults

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/api/vaults` | auth | Lists vaults the caller has any role on. |
| GET | `/api/vaults/{vaultId}` | vault:viewer | Get one vault's metadata. |
| POST | `/api/vaults` | auth | Create a new vault (server creates the on-disk folder). |
| POST | `/api/vaults/register` | auth | Register an existing folder as a vault. |
| DELETE | `/api/vaults/{vaultId}` | vault:owner | Delete vault row, permissions, AND the on-disk folder. |
| GET | `/api/vaults/{vaultId}/permissions` | vault:viewer | List members and their roles. |
| POST | `/api/vaults/{vaultId}/permissions` | vault:owner | Add or update a member (userId + role). |
| DELETE | `/api/vaults/{vaultId}/permissions/{userId}` | vault:owner | Remove a member. |
| POST | `/api/vaults/{vaultId}/install-sample-data` | vault:owner | Install starter notes (refused if vault has any notes). |
| PUT | `/api/vaults/{vaultId}/appearance` | vault:owner | Change `iconKey` + `colorKey`. Server validates against the fixed palettes. |

## Notes

All under `/api/vaults/{vaultId}`. `?path=` is the URL-encoded
note path with `.md` extension.

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/folder?path=` | vault:viewer | List one folder's contents (notes + folders). `?path=` empty = vault root. |
| GET | `/folder/recursive?path=` | vault:viewer | Same as above but recursive — returns the whole subtree. |
| GET | `/note?path=` | vault:viewer | Get one note's body + frontmatter + metadata. |
| POST | `/note` | vault:editor | Create a new note. Body has path + initial content. |
| PUT | `/note?path=` | vault:editor | Update a note. Body fields are all optional: any combination of `body`, `tags`, `locked`, `font`, `fontSize`, `width`, `versionMajor`, `versionMinor`, `state` can be sent. Omitted fields are left alone — in particular, omitting `body` preserves the on-disk body byte-for-byte and the server only rewrites the frontmatter. This is the path the Properties panel uses for property-only edits (Locked, Tags, version/state, appearance) so that a stale body snapshot in the panel cannot clobber newer content from the editor. The editor's own save sends `body` + `etag`; `etag` mismatch returns 412. Version/state are validated server-side and a bad change returns **400**: the version is monotonic (a `major.minor` below the current value is rejected; equal is allowed), `state` must be `development` or `released`, `released` requires version ≥ 1.0, and no lifecycle state is accepted at version 0.0. Switching `state` between `development` and `released` performs the release-copy swap (freeze/park/restore) described in [storage.md § .notesapp/releases/](storage.md#notesapp-subfolder); those switches load a stored slot and bypass the monotonic check by design. `locked: true` in the frontmatter is a UI hint — the frontend renders such notes read-only and refrains from saving — but the server itself does not refuse writes to a locked note. |
| DELETE | `/note?path=` | vault:editor | Move note to `.notesapp/trash/`. |
| PUT | `/note/move` | vault:editor | Move/rename a note. Old + new paths in body. |
| GET | `/note/release?path=` | vault:editor | Info about the note's single frozen released copy: `{ exists, versionMajor, versionMinor, savedAt, developmentStashed }`. `exists` is false when the note has never been released. `developmentStashed` is true while the released copy is showing live and the working copy is parked. Drives the Properties panel's recall affordance. Editor role (matches the note-history endpoints' rationale). |
| GET | `/note/export?path=&format=` | vault:viewer | Export a note. `format` is one of: `docx` (default — Word document via the rich-conversion pipeline) or `md` (zip containing the note's `.md` plus its `.assets/` folder if any, suitable for round-trip via `/import`). `format=pdf` returns 501 (placeholder; not surfaced in the UI). |
| POST | `/import` | vault:editor | Multipart upload that imports either a single `.md` file or a `.zip` of `.md` files (with optional `*.assets/` folders). Form fields: `targetFolder` (optional, vault-relative; empty = root), `file` (required). Conflict policy: numeric-suffix rename (`Foo.md` → `Foo (2).md`); a renamed note's body is rewritten to point at its renamed `.assets/` sibling so image references survive. Always returns 200 with a per-entry result list unless the request itself is malformed; per-file failures inside a multi-file import surface as `failed` entries rather than aborting the batch. |

## Folders

All under `/api/vaults/{vaultId}`.

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| POST | `/folder` | vault:editor | Create folder. Body has parent path + name. |
| DELETE | `/folder?path=` | vault:editor | Recursively delete folder + all notes inside. |
| PUT | `/folder/move` | vault:editor | Move/rename a folder. Index entries for notes inside are updated. |
| GET | `/folder/cover?path=` | vault:viewer | Stream the folder's cover image bytes. `?path=` empty = vault root. 404 if the folder has no cover. The URL embedded in `FolderListingDto.coverUrl` (see [notes.md § Folders](notes.md#folders)) carries a `&v=<unix-ms>` cache-buster so re-uploads bypass the browser cache. |
| POST | `/folder/cover?path=` | vault:editor | Multipart upload (or replace) of the folder's cover. Form field: `file` (required). **Image-only** — server enforces `image/*` content types (PNG/JPEG/GIF/WebP/BMP/SVG); other types return 415. Size limit reuses the asset endpoint's `MaxUploadBytes`. Returns the freshly-built `coverUrl` for immediate use in `<img src>`. |
| DELETE | `/folder/cover?path=` | vault:editor | Remove the folder's cover. Idempotent — returns 204 whether or not a cover existed. |

## Templates

All under `/api/vaults/{vaultId}`.

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/templates` | vault:viewer | List template names. |
| GET | `/templates/{name}` | vault:viewer | Get one template's body. |
| POST | `/templates` | vault:editor | Create a new template (name + body). |
| POST | `/templates/from-selection` | vault:editor | Create a new template from a selection in a note. Body: `sourceNotePath`, `markdown`. Server picks the auto-name (`Template YYYY-MM-DD HHmm` in local time, suffixed on collision), copies any images referenced in the selection from the source note's asset folder into the new template's asset folder, rewrites image paths. Returns the created template. |
| POST | `/templates/{name}/render?targetNotePath=` | vault:editor | Render a template's body for insertion into a target note. Copies any images from the template's asset folder into the target note's asset folder, rewrites paths, returns `{body}`. The slash-menu submenu calls this on every template insert. Side-effecting (writes to the target's asset folder), hence editor and not viewer. |
| PUT | `/templates/{name}` | vault:editor | Update an existing template's body or rename it. Rename also moves the `<name>.assets/` folder and rewrites image refs in the body. |
| DELETE | `/templates/{name}` | vault:editor | Delete a template. Also deletes the `<name>.assets/` folder. |

A template named `Daily` is used as the body of newly-created
daily notes.

## Daily notes

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| POST | `/api/vaults/{vaultId}/daily/today` | vault:editor | Open today's daily note: returns its path, creating the year + month + date file (and `Daily Notes/` itself) if missing. Uses the `Daily` template's body if present, otherwise creates an empty note. |

## Search & indexing

All under `/api/vaults/{vaultId}`.

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/search?q=&path=&limit=` | vault:viewer | FTS5 search of the per-vault index. `q` is the free-text query (whitespace-separated terms ANDed; falls back to OR per vault if AND returns zero and the query has 2+ terms). Optional `path=` limits the search to one folder subtree. Optional `limit=` caps results (default 50, max 200). Response is `{ results: SearchResultDto[], indexing: bool, looseMatch: bool }`. Each result has `path`, `title`, `snippet`, `updated`; matched tokens inside the snippet are wrapped with U+0001 (start) and U+0002 (end) control characters — C0 controls are used rather than markdown markers so the client can distinguish FTS5 emphasis from literal bold in the source body. `looseMatch=true` indicates the OR fallback fired for this vault. |
| GET | `/index/status` | vault:viewer | Index health: schema version, note count, last-built-at. |
| POST | `/index/rebuild` | vault:owner | Force rebuild the index by re-reading every note. Long-running. |

## Assets

All under `/api/vaults/{vaultId}`.

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| POST | `/note/asset` | vault:editor | Multipart upload. Form fields: `notePath`, file, optional `originalName`. Stores under the note's asset folder; returns the relative markdown path to insert. |
| POST | `/template/asset` | vault:editor | Multipart upload for template assets. Form fields: `templateName`, file. Stores under `.notesapp/templates/<templateName>.assets/`. **Image-only** — server enforces `image/*` content types (PNG/JPEG/GIF/WebP/BMP/SVG); other types return 415. |
| GET | `/asset?path=` | vault:viewer | Stream one asset by relative path. Accepts both note-asset paths (`<NoteName>.assets/<file>`) and template-asset paths (`.notesapp/templates/<TemplateName>.assets/<file>`). The path must contain a `.assets/` segment — that's the load-bearing safety rule. |

## Startpage

All under `/api/vaults/{vaultId}/startpage`.

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/config` | vault:viewer | Read the startpage block layout from `{vault}/.notesapp/startpage.json`. |
| PUT | `/config` | vault:editor | Replace the layout. |
| GET | `/feed?url=` | vault:viewer | Server-side proxy that fetches one RSS/Atom feed and parses it. Used by RSS blocks to avoid CORS. |
| GET | `/link-preview?url=` | vault:viewer | Server-side proxy that fetches a page and extracts Open Graph / Twitter Card / `<title>` / favicon metadata. Used by Links-block entries for thumbnail + title auto-fill. Empty fields are valid (page had no usable metadata); upstream failures (timeout, SSRF block, 4xx/5xx) propagate as 4xx/5xx here. Cached server-side for 1 hour per URL. |

## Assignments

All under `/api/vaults/{vaultId}/assignments`. Backs the
per-vault Assignments page (see
[frontend.md](frontend.md#assignments)). Bare-route group —
nothing else lives under `/assignments` so there's no `/config`
sub-route the way the startpage has one.

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `` | vault:viewer | Read the assignments list from `{vault}/.notesapp/assignments.json`. Missing or empty file returns an empty list (no default placeholder). |
| PUT | `` | vault:editor | Replace the assignments list. Atomic temp-then-rename write. List order is significant — the frontend groups the flat list into category buckets at render time and preserves order within each bucket, so reordering and cross-bucket moves are persisted purely as changes to this list (order + each item's `category`). Server stamps the schema version on write — clients may PUT any number; the on-disk file always carries the current version. |

## Admin: server config & operations

All under `/api/admin/server`, all admin-only.

| Method | Path | Behaviour |
|---|---|---|
| GET | `/config` | Returns the current effective configuration (Storage, Network, HTTPS hostnames, Auth, Smtp, Backup, Logging). |
| PUT | `/config` | Replace the configuration; persists to `appsettings.json`. Most knobs apply via `IOptionsMonitor` without a restart; some explicitly note "needs restart". |
| POST | `/smtp/test` | Sends a test email using the SMTP config (either the saved one or one supplied in the request body for "test before save"). |

## Admin: backups

All under `/api/admin/server/backup`, all admin-only.

| Method | Path | Behaviour |
|---|---|---|
| GET | `/status` | Current schedule, target path, last run, retention settings, in-progress flag. |
| POST | `/run` | Run a backup synchronously (one at a time — concurrent calls return 409). |
| GET | `/list` | List existing backups (one per timestamp folder under the target path). |
| DELETE | `/{id}` | Delete one backup (recursive folder remove). |
| POST | `/{id}/restore-vault` | Restore one vault from one backup. Body: source vault id, target name, target parent folder. |

## Admin: audit & logs

All admin-only.

| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/admin/audit` | Paged audit-event query. Filters: event type, user id, vault id, date range, free-text. |
| GET | `/api/admin/audit/event-types` | List the known audit event-type names. |
| GET | `/api/admin/server/logs/tail` | Returns the last N lines of the latest Serilog rolling file. Query: `lines` (default 200, max 5000). |

## Health

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/health` | anon | Liveness probe. Returns 200 + version + DB status. Used by the tray, Caddy, and any external monitoring. |

## Audit events

The server writes one of the following event types to the
`AuditEvents` table on relevant operations. The set is fixed;
new events require server-side code:

- `AdminBootstrap`
- `LoginSuccess` / `LoginFailure` / `LoginLockedOut` / `Logout`
- `PasswordChanged`
- `SessionRevoked`
- `UserCreated` / `UserUpdated` / `UserDeleted`
- `VaultCreated` / `VaultRegistered` / `VaultDeleted`
- `VaultShared` / `VaultUnshared`
- `VaultAppearanceChanged`
- `VaultSampleDataInstalled`
- `NoteCreated` / `NoteDeleted` / `NoteMoved`
- `BackupRun` / `BackupRestored` / `BackupDeleted`
- `ServerConfigUpdated`

Note edits are **not** audited. The audit log focuses on
identity, structural changes, and configuration; per-keystroke
content changes would flood the table.

## Errors

Errors use ASP.NET Core's `Results.Problem` (RFC 7807). HTTP
status codes used:

- **400** — validation failure or malformed request.
- **401** — not authenticated (no/expired session).
- **403** — authenticated but not authorised (wrong role,
  remote loopback caller, etc.).
- **404** — note/folder/vault/template/user not found.
- **409** — conflict (creating a name that exists, concurrent
  backup running, etc.).
- **413** — request body too large (asset upload exceeds size limit).
- **415** — unsupported content type (e.g. non-image upload to `/template/asset` or `/folder/cover`).
- **423** — login locked out (per-account rate limit hit).
- **429** — too many requests (per-IP rate limit hit).
- **5xx** — uncaught exception. Logged with a correlation id;
  the response problem JSON includes the same id.
