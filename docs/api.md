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
| PUT | `/note?path=` | vault:editor | Update note body and/or frontmatter. Refused if `locked: true`. |
| DELETE | `/note?path=` | vault:editor | Move note to `.notesapp/trash/`. |
| PUT | `/note/move` | vault:editor | Move/rename a note. Old + new paths in body. |
| GET | `/note/export?path=&format=` | vault:viewer | Export a note. `format` is one of: `md`, `pdf`, `html`. |

## Folders

All under `/api/vaults/{vaultId}`.

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| POST | `/folder` | vault:editor | Create folder. Body has parent path + name. |
| DELETE | `/folder?path=` | vault:editor | Recursively delete folder + all notes inside. |
| PUT | `/folder/move` | vault:editor | Move/rename a folder. Index entries for notes inside are updated. |

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
| GET | `/search?q=` | vault:viewer | FTS5 search of the per-vault index. Returns matches with title, path, snippet. |
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
- **415** — unsupported content type (e.g. non-image upload to `/template/asset`).
- **423** — login locked out (per-account rate limit hit).
- **429** — too many requests (per-IP rate limit hit).
- **5xx** — uncaught exception. Logged with a correlation id;
  the response problem JSON includes the same id.
