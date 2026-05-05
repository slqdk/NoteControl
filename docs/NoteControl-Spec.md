> **HISTORICAL DOCUMENT — for reference only.**
>
> This is the original v0.1 design-phase specification, written before
> any code was shipped. Many details (scope, naming, architecture,
> APIs, file layouts) have evolved since this was written. The shipping
> app is at v0.2.9 and differs from this document in numerous places.
>
> Treat this file as a record of the original intent and as context
> for *why* certain decisions were made — **not** as authoritative
> documentation of how the app currently works. For current behaviour,
> read the source.

---

# NotesApp — Project Specification

**Version:** 0.1 (design phase)
**Target platform:** Windows (server host + browser clients)
**Development environment:** Visual Studio 2022

---

## 1. Project goals

A lightweight, self-hosted multi-user note-taking application in the spirit of Siyuan / Docmost, with a strong emphasis on **data portability**. The core principle: notes are stored as plain markdown files on disk in a human-navigable folder structure, so that if the app ever stops working, moves to another machine, or the user simply wants to browse their data outside the app, everything is accessible with nothing more than Windows Explorer and a text editor.

### Non-negotiables

- Notes stored as plain `.md` files on disk, browsable in Windows Explorer
- Co-located attachments (images, videos, audio) with their notes
- Backup = copy the vault folder. Restore = paste it back.
- No database lock-in for content; index database is disposable and rebuildable
- WYSIWYG editor, but markdown round-trip must be lossless
- Multi-user access over HTTPS from any browser

---

## 2. Architecture overview

```
┌──────────────────────────────────────────────────────┐
│ Windows PC (the host)                                │
│                                                      │
│  ┌──────────────────┐      ┌──────────────────────┐  │
│  │ Tray utility     │◄────►│ Notes server         │  │
│  │ (WPF / WinUI 3)  │named │ (ASP.NET Core, .NET 8)│  │
│  │ - Users          │pipe  │ - HTTPS listener     │  │
│  │ - Settings       │      │ - Auth + sessions    │  │
│  │ - Vaults         │      │ - File storage       │  │
│  │ - Logs           │      │ - SQLite index (EF)  │  │
│  │ - Backups        │      │ - Pandoc (DOCX)      │  │
│  │ - Start/Stop     │      │ - Chromium (PDF)     │  │
│  └──────────────────┘      └──────────┬───────────┘  │
│                                       │              │
│                            ┌──────────▼───────────┐  │
│                            │ D:\NotesData\        │  │
│                            │  ├─ users\           │  │
│                            │  ├─ shared\          │  │
│                            │  └─ .server\         │  │
│                            └──────────────────────┘  │
└──────────────────────────────────────────────────────┘
         ▲
         │ HTTPS (via Caddy reverse proxy)
         │
    ┌────┴────┐  ┌─────────┐  ┌─────────┐
    │ User's  │  │ Other   │  │ Phone   │
    │ browser │  │ user    │  │ browser │
    └─────────┘  └─────────┘  └─────────┘
```

### Process model

Two separate processes running on the host PC:

1. **`NotesApp.Server.exe`** — registered as a Windows Service, starts at boot, runs under a dedicated low-privilege service account. Owns the HTTPS listener and all file operations. No UI.
2. **`NotesApp.Tray.exe`** — starts at user login for admin-capable users. Shows tray icon. Admin windows are native WPF/WinUI 3. Talks to the server over a local named pipe.

Admin operations are **not exposed over HTTP** — they exist only on the named pipe. This limits the attack surface of the internet-facing service.

---

## 3. Technology stack

| Layer | Technology |
|-------|------------|
| Server runtime | .NET 8 / ASP.NET Core |
| Windows Service integration | `Microsoft.Extensions.Hosting.WindowsServices` |
| Index database | SQLite via Entity Framework Core |
| Full-text search | SQLite FTS5 |
| Reverse proxy | Caddy (HTTPS, Let's Encrypt, rate limiting) |
| Tray + admin UI | WPF (or WinUI 3) |
| IPC | Windows named pipes |
| Frontend framework | React |
| Editor | TipTap (ProseMirror-based) with `tiptap-markdown` |
| Markdown parsing (server-side) | Markdig |
| Syntax highlighting | Lowlight or Shiki |
| DOCX export | Pandoc (bundled) |
| PDF export | Headless Chromium (via PuppeteerSharp) |
| Password hashing | Argon2id (`Konscious.Security.Cryptography.Argon2`) |
| File watching | `FileSystemWatcher` |

### Visual Studio 2022 solution layout

```
NotesApp.sln
├── NotesApp.Server         (ASP.NET Core, Windows Service)
├── NotesApp.Tray           (WPF, admin UI, tray icon)
├── NotesApp.Shared         (DTOs, named-pipe contracts)
├── NotesApp.Frontend       (React app, built with Vite, output served statically)
├── NotesApp.Installer      (WiX or Inno Setup project for MSI/EXE installer)
└── NotesApp.Tests          (xUnit)
```

---

## 4. Data storage

### Filesystem layout

```
D:\NotesData\
├── users\
│   ├── alice\
│   │   ├── Personal\                    ← a vault
│   │   │   ├── .notesapp\
│   │   │   │   ├── index.db             ← disposable SQLite cache
│   │   │   │   ├── vault.lock           ← active-session lock
│   │   │   │   ├── config.json
│   │   │   │   ├── trash\               ← soft-deleted notes
│   │   │   │   └── templates\           ← user template .md files
│   │   │   ├── Projects\
│   │   │   │   ├── q2-planning.md
│   │   │   │   ├── q2-planning.assets\
│   │   │   │   │   ├── roadmap.png
│   │   │   │   │   └── demo.mp4
│   │   │   │   └── website-redesign.md
│   │   │   ├── Daily Notes\
│   │   │   │   └── 2026\
│   │   │   │       └── 04-April\
│   │   │   │           └── 2026-04-24.md
│   │   │   └── Inbox.md
│   │   └── Journal\                     ← another of Alice's vaults
│   └── bob\
│       └── Work\
├── shared\
│   └── Household\                       ← shared vault (Alice + Bob)
│       ├── .notesapp\
│       └── Recipes\
│           ├── lasagna.md
│           └── lasagna.assets\
│               └── photo.jpg
└── .server\
    ├── users.db                         ← accounts, password hashes
    ├── permissions.db                   ← vault access control
    ├── audit.db                         ← security + admin log
    └── config.json                      ← server settings
```

### Core rules

- **Each vault is self-contained.** Copy a vault folder to another PC and everything works (including attachments).
- **Assets are co-located with their note**, in a sibling folder named exactly `<basename>.assets\`. The dot is required — the indexer ignores folders without it.
- **The `.notesapp\` folder inside each vault** holds the disposable index and app-managed state. If deleted, it is rebuilt on next open. It is not required for data integrity — only for performance and features like search.
- Vaults are **isolated from each other** — search, tags, backlinks, daily notes all scope to the currently-open vault.

### Note file format

Every note is a markdown file with YAML frontmatter managed by the app:

```markdown
---
created: 2026-04-20T10:30:00Z
updated: 2026-04-24T14:15:00Z
tags: [planning, work]
locked: false
---

# Q2 Planning

Main themes for the quarter:

- Ship the new search feature
- Migrate auth to the new provider

See [[website-redesign]] for related work.

![Roadmap](q2-planning.assets/roadmap.png)

<video src="q2-planning.assets/demo.mp4" controls></video>

​```python
def reindex_vault(path):
    pass
​```
```

### Markdown conventions

- **Line endings:** LF (Unix) within the file.
- **Bullets:** `-` (not `*` or `+`).
- **Headings:** ATX style (`## Heading`), not underlined.
- **Frontmatter:** always present, managed by the app. Unknown fields are preserved verbatim.
- **Tables:** GFM pipe syntax.
- **Task lists:** `- [ ]` / `- [x]`.
- **Wikilinks:** `[[note-name]]` — matched by filename within the vault.
- **Images:** `![alt](relative/path.png)`.
- **Videos / audio:** raw HTML, renders correctly in any markdown viewer:
  - `<video src="..." controls></video>`
  - `<audio src="..." controls></audio>`
- **Other files:** standard markdown link syntax `[filename.pdf](...)`.

### Attachment handling (drag-drop)

When any file is dropped into a note or pasted:

1. App creates `<basename>.assets\` next to the note if it does not exist.
2. Copies the file into that folder (renaming on collision).
3. Inserts the appropriate snippet at the cursor based on extension:
   - Images → `![](name.assets/file.ext)`
   - Videos → `<video src="name.assets/file.ext" controls></video>`
   - Audio → `<audio src="name.assets/file.ext" controls></audio>`
   - Other → `[file.ext](name.assets/file.ext)`
4. If the file exceeds a configurable size threshold (default 50 MB), warn before embedding.

When the note is renamed, the `.assets\` folder is renamed to match.
When the note is moved, the `.assets\` folder moves with it.
When the note is deleted, the user is prompted to delete the `.assets\` folder too.

---

## 5. Editor

### WYSIWYG with TipTap

The editor is WYSIWYG throughout — no split view. Round-trips to markdown on every save.

### Required nodes / marks

- Headings H1–H6
- Paragraphs with bold, italic, strike, inline code, highlight, links
- Bullet, numbered, and task lists (nested)
- Blockquotes, callouts
- Horizontal rule
- Code block with per-block language selection and syntax highlighting
- Tables (GFM), with toolbar for row/column operations
- Images, videos, audio (preserved as HTML in source)
- Wikilinks — custom node rendering as clickable link, serialising as `[[name]]`

### Slash command menu

Trigger: `/` at the start of a line or after whitespace. Filterable as the user types. Arrow keys navigate. Enter inserts.

**Menu items (exact scope for v1):**

- Heading 1
- Heading 2
- Heading 3
- Bulleted list
- Numbered list
- Task list (`- [ ]`)
- Blockquote
- Code block (opens submenu for language selection)
- Horizontal rule
- Table (inserts 3×3 starter; in-table toolbar handles resizing after)
- Templates (opens submenu listing files in the vault's `.notesapp\templates\` folder)

### Templates

- Users drop `.md` files into `.notesapp\templates\`.
- Each file appears as an entry in the templates submenu.
- Supported placeholder tokens expanded on insert:
  - `{{date}}` → current date (YYYY-MM-DD)
  - `{{time}}` → current time (HH:MM)
  - `{{title}}` → current note's title (filename without extension)
  - `{{cursor}}` → caret position after insertion

No UI for creating templates — they are just files in a folder, consistent with the project philosophy.

### Metadata strip

At the top of every note, above the editor body:

- **Title** — editable; renaming changes the filename and the sibling `.assets\` folder.
- **Tags** — chip-style, add/remove, writes to frontmatter `tags:` as a YAML list.
- **Lock icon** — toggles `locked: true` in frontmatter.
- **Expand arrow** — reveals full frontmatter as a key/value editor (shows `created`, `updated` read-only; allows editing or deleting unknown fields from imported notes).

Tags live only in the frontmatter `tags:` list. No inline `#hashtag` syntax in v1.

### Locking

Two independent lock mechanisms:

1. **Note-level lock** — `locked: true` in frontmatter. Editor opens note read-only; a clearly-visible "Unlock" button in the metadata strip flips it. Purely an intent marker, preserved in the file so the intent survives reinstalls.
2. **Vault-level lock** — `.notesapp\vault.lock` file contains PID, hostname, timestamp, user ID. On vault open, if the lock exists: warn "this vault appears to be open by <user> on <host>, started <time>". Options: open read-only, force unlock, cancel. Stale locks (process gone) offer seamless takeover.

### External change detection

The server watches each open vault with `FileSystemWatcher`. When a file changes on disk outside the app (e.g. edited in VS Code, restored from backup):

- If no client has unsaved changes to that note: silently reload.
- If a client has unsaved changes: prompt "file changed on disk — reload / keep yours / show diff".

---

## 6. User interface

### Overall layout

```
┌─────────────────────────────────────────────────────────┐
│ [Vault: Personal ▾]           [Search everywhere...]    │ ← top bar
├──────────────┬──────────────────────────────────────────┤
│ Tree view    │                                          │
│              │  Main content area                       │
│ 📁 Projects  │  (editor OR folder view)                 │
│ 📁 Daily...  │                                          │
│ 📄 Inbox     │                                          │
│              │                                          │
│              │                                          │
└──────────────┴──────────────────────────────────────────┘
```

### Tree view (left sidebar)

- Shows folders (expandable) and `.md` files (leaves).
- **Hidden:** `.notesapp\`, any `*.assets\` folders, dotfiles.
- **Sorting:** folders first, then files; alphabetical within each group.
- **Click triangle** → expand/collapse folder.
- **Click folder name** → opens folder view in main content area.
- **Click file** → opens note in editor.
- **Depth guideline:** designed for up to 5 levels of nesting; deeper levels use compressed indentation to avoid horizontal scroll but are not blocked.
- **Virtualization:** required for vaults exceeding ~500 entries.
- **Context menu (right-click):** New note, New folder, Rename, Delete (to trash), Reveal in Explorer, Export as PDF, Export as DOCX.
- **Drag-drop:** move notes and folders between parents (`.assets\` folders follow their note).
- **Rename:** F2 or double-click on the name.
- **Delete:** Delete key → moves to `.notesapp\trash\`.

### Folder view

When a folder is selected, main content area shows:

- **Folder name and breadcrumb** at the top.
- **Search field** scoped to this folder and all descendants (recursive).
- **Recently updated list** — showing the 10 most recently modified notes **across this folder and all descendants (recursive)**, with:
  - Filename (no `.md`)
  - Relative path under the folder (e.g. `Archive / 2025 / Q4`)
  - Last-modified timestamp:
    - `< 7 days`: relative ("2 hours ago", "yesterday", "3 days ago")
    - `≥ 7 days`: absolute date ("April 15" or "April 15, 2025" if prior year)
    - Hover/long-press shows full ISO timestamp.
- "Show all N notes" button to expand to a full sorted-by-modified list.
- **Subfolders listing** with note counts.

The vault root's folder view serves as the vault's home screen.

### Search behaviour

- **Top-bar search field:** searches the entire active vault.
- **Folder-view search field:** searches only the selected folder and its descendants.
- **Implementation:** SQLite FTS5 with a path-prefix filter:
  ```sql
  SELECT path, title, snippet(notes_fts, ...)
  FROM notes_fts
  JOIN notes ON notes.path = notes_fts.path
  WHERE notes_fts MATCH ?
    AND notes.path LIKE ? || '%'
  ORDER BY rank;
  ```
- Results replace the recently-updated list while the user is typing. Clearing the query restores it.

### Startup behaviour

On vault open, show the last-opened note or folder view. Fallback: vault root folder view.

### Daily notes

- "Today's note" button in the top bar.
- Creates or opens `Daily Notes\YYYY\MM-MonthName\YYYY-MM-DD.md`.
- Creates intermediate folders as needed.
- Applies the `daily-note` template if one exists in `.notesapp\templates\`.

---

## 7. Multi-user

### Accounts

- Stored in `D:\NotesData\.server\users.db`.
- Fields: username, email (for password reset and notifications), argon2id password hash, role (admin / user), created, last-login, status (active / locked / disabled).
- Admin is a flag on the user record, not a separate account type.

### Sessions

- Server-side session store (not JWT).
- Session ID in an **httpOnly, Secure, SameSite=Strict** cookie.
- Idle timeout: 12 hours (configurable).
- Absolute timeout: 7 days with sliding refresh (configurable).
- Sessions invalidated server-side on password change or explicit logout.
- Users can view and revoke active sessions in their profile.

### Vaults and permissions

- Each user has their own folder under `users\<username>\` where they create private vaults.
- Vaults under `shared\` are shareable between users.
- Permission table:
  ```
  vault_permissions(user_id, vault_path, role)
    role = 'owner' | 'editor' | 'viewer'
  ```
- **Owner:** full control including sharing and deletion.
- **Editor:** read/write notes.
- **Viewer:** read only.
- Sharing flow: vault owner opens vault settings → invites by username → other user gets access immediately.
- Per-request checks: every API call validates that the session's user has the required role for the target vault.

### Concurrent editing (v1: soft lock)

When user A opens a note for editing, server marks it "in edit by A". If user B opens the same note, they see:

> **Alice is editing this note.** [Open read-only] [Force open]

Lock expires after 10 minutes of inactivity. Combined with external-change detection so force-opens and parallel edits surface reload prompts.

Real-time collaborative editing (CRDT-based) is deferred — it is a major undertaking (likely 2–3× the rest of the app's complexity).

---

## 8. Security

**Threat model:** a service exposed to the public internet from a home IP, accessed by a small number of users (initially 1–2) via browsers on untrusted networks.

### Transport

- **HTTPS only**, enforced by the reverse proxy. No HTTP except for Let's Encrypt challenge.
- **Caddy** as the reverse proxy in front of the ASP.NET Core server.
  - Auto-provisions and renews Let's Encrypt certificates.
  - Terminates TLS.
  - ASP.NET Core listens only on `127.0.0.1:<port>`, unreachable from the network directly.
- **Domain name** required (cheapest: ~$12/yr).
- **Dynamic DNS** (Cloudflare API + cron, or DuckDNS) if the home IP is not static.
- **Router:** forward 80 + 443 only. UPnP disabled. No DMZ.
- **Windows Firewall:** allow 80/443 inbound from the router's LAN interface only.

### Authentication

- **Argon2id** password hashing with per-user salt.
- **Minimum password length: 12 characters**, checked against the HaveIBeenPwned pwned-password list (k-anonymity API, no passwords leave the server in plaintext).
- **No password hints, no security questions.**
- **2FA (TOTP):** deferred but the user model must reserve a `totp_secret` column and the auth flow must be designed to accept a second factor as a later addition.

### Rate limiting and lockout

- **Per IP:** 5 login attempts per minute, then exponential backoff; 20 failures in 1 hour → block that IP for 24 hours.
- **Per account:** 10 failed logins across any IP within 1 hour → temporary lock, notify user via email.
- Accepted tradeoff: per-account lockout enables account-level DoS, mitigated by recovery email and admin unlock.

### Session cookies

- `HttpOnly`, `Secure`, `SameSite=Strict`.
- Session ID rotated on login.
- **CSRF tokens** on all state-changing requests (double-submit cookie pattern).

### Frontend security

Stored XSS is the main risk (notes contain HTML for video/audio, and markdown renders to HTML).

- **DOMPurify** sanitization on all rendered note content, with a strict allowlist: `video`, `audio`, `img`, `a` (http/https only), basic formatting tags, list items, headings, blockquote, code, pre, table elements. No `script`, `iframe`, `object`, `embed`, event handlers, `javascript:` URLs, or inline `style` with expressions.
- **Content Security Policy** (set by ASP.NET Core or Caddy):
  ```
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  media-src 'self';
  object-src 'none';
  frame-ancestors 'none';
  base-uri 'self';
  ```
- Additional headers: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.

### Path traversal protection

Every file operation canonicalises the requested path and verifies the result lies inside an allowed vault root that the user has permission for. No concatenation of user-supplied paths. Reject symlinks that escape the vault.

### Login notifications

Every login from a new IP or new browser triggers an email to the user: "new login from IP x.x.x.x, browser, approximate location — was this you?" Single best mitigation against credential compromise short of 2FA.

### Audit log

`D:\NotesData\.server\audit.db` records security-relevant events: logins, login failures, IP lockouts, account lockouts, permission changes, sharing changes, vault deletions, password resets, user creation, admin operations from the tray utility.

### Backups

- Automated nightly backup of `D:\NotesData\` to an external drive or remote location (restic to Backblaze B2, or robocopy to a NAS).
- Configurable via the tray utility.
- Retention policy: keep last N daily, last M weekly.
- Because notes are plain markdown, any standard backup tool works — emphasise this in the documentation.

---

## 9. Tray utility

### Tray icon menu (right-click)

```
Notes Server
├── ● Running  (or ○ Stopped, ⚠ Error)
├── ──────────────────
├── Open in Browser
├── ──────────────────
├── Users              ▸
├── Server Settings    ▸
├── Vaults             ▸
├── Logs               ▸
├── Backups            ▸
├── ──────────────────
├── Start Server
├── Stop Server
├── Restart Server
├── ──────────────────
├── About
└── Quit Tray
```

**Left-click** on the icon opens the web UI in the default browser.
**Hover tooltip** shows a status summary: "Running — 2 users, 14 logins today".
**Icon color** reflects state: normal / yellow (warning, e.g. backup overdue) / red (security event, e.g. 50+ failed logins in last hour).

### Users window

List of accounts with: username, email, role, last-login IP, last-login time, status.

Actions: Add User, Edit, Reset Password, Disable, Delete, View Active Sessions (with Revoke per session and Revoke All).

### Server Settings window

Sections:

- **Network:** bind address, port, public URL (for email links).
- **Data location:** path to `NotesData`; "move data" action with integrity verification.
- **Authentication:** session lifetime, idle timeout, password policy, require-2FA toggle (disabled until 2FA is implemented).
- **Rate limiting:** per-IP and per-account thresholds.
- **Email (SMTP):** host, port, credentials, from address, test-send.
- **Backups:** target path, schedule, retention, run-now.
- **Logging:** level, retention.

Changes written to `D:\NotesData\.server\config.json`. Hot-reload where possible; restart prompts where not.

### Vaults window

List of all vaults on the server with owner, size, note count, who they are shared with.
Create/move/delete. "Reveal in Explorer" per vault.

### Logs window

Tabs: Server, Access, Security.
Filter by date range, user, IP, endpoint. Real-time tail toggle. Export to file.

### Backups window

Last backup status and timestamp. Run now. Open backup folder. Restore from backup (with confirmation).

### IPC

Tray ↔ Server over a **Windows named pipe** (`\\.\pipe\notesapp-admin`). Pipe ACL limits access to the current Windows user. Admin API is completely separate from the public HTTP API — admin operations are not reachable over HTTP at all.

Admin API methods (illustrative):

- `admin.ListUsers()`, `admin.CreateUser()`, `admin.ResetPassword()`, `admin.RevokeSession()`
- `admin.GetConfig()`, `admin.SetConfig()`
- `admin.ServerStatus()`, `admin.RestartServer()`
- `admin.GetLogs(filter, range)`
- `admin.RunBackup()`, `admin.RestoreBackup()`

---

## 10. Export

### PDF export

- Single note: right-click in tree or button in editor toolbar.
- Folder / whole vault: right-click in tree.
- Implementation: render markdown → HTML with app stylesheet → headless Chromium (PuppeteerSharp) prints to PDF.
- Multi-note exports concatenate HTML with page breaks.

### DOCX export

- Same entry points as PDF.
- Implementation: Pandoc, bundled with the app.
- Use a reference `.docx` for consistent styling (fonts, heading sizes, spacing).
- HTML video/audio tags replaced with placeholder text ("[Video: demo.mp4]") since Word cannot render them.
- Images embedded correctly by Pandoc.

---

## 11. Import

- "Import folder" in the UI: user selects a folder of markdown files.
- App copies files into the active vault, preserving subfolder structure.
- Referenced images are copied into sibling `<basename>.assets\` folders following the project convention.
- Image/attachment paths in the markdown are rewritten to point to the new locations.
- Frontmatter from imported files preserved verbatim. Unknown fields surface in the expanded metadata view.
- If the imported folder is already a well-formed vault (has `.notesapp\`), offer "open as vault" instead.
- After import, a reindex runs.

---

## 12. Index database

`<vault>\.notesapp\index.db` — SQLite, managed by EF Core.

### Schema (rough)

```sql
CREATE TABLE notes (
  path          TEXT PRIMARY KEY,   -- relative to vault root
  title         TEXT,
  created       TEXT,               -- ISO 8601
  updated       TEXT,
  body_text     TEXT,               -- plain text, for FTS
  frontmatter   TEXT                -- JSON blob of parsed frontmatter
);

CREATE INDEX idx_notes_updated ON notes(updated DESC);

CREATE TABLE tags (
  note_path TEXT,
  tag       TEXT,
  PRIMARY KEY (note_path, tag),
  FOREIGN KEY (note_path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE TABLE links (
  source_path TEXT,
  target_path TEXT,
  FOREIGN KEY (source_path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  path UNINDEXED,
  title,
  body_text,
  content='notes',
  content_rowid='rowid'
);
```

### Lifecycle

- On vault open, if `index.db` is missing or older than any note file, rebuild by walking the vault.
- `FileSystemWatcher` events update single rows.
- Users can delete `index.db` at any time to force a rebuild.

---

## 13. Build order

1. ASP.NET Core server skeleton, HTTPS via Caddy, localhost-only backend, SQLite setup.
2. User accounts (argon2id), sessions, login/logout, recovery-email flow.
3. Rate limiting (per IP + per account), login notifications, audit log.
4. Domain + dynamic DNS + router + firewall for real-world testing.
5. Single-user: vault listing, file tree API, note read/write with path-traversal protection.
6. Frontend shell (React), login page, vault picker, tree view with virtualization.
7. Folder view (recursive recently-updated, scoped search), vault-root home screen.
8. TipTap editor, markdown round-trip, YAML frontmatter handling, metadata strip.
9. Slash menu with the defined commands, code-block language submenu, templates submenu.
10. Drag-drop assets with `.assets\` folder convention, videos/audio via HTML tags.
11. Multi-user: permissions table, sharing UI, soft locks on shared notes.
12. Search (SQLite FTS5 with path-prefix filter).
13. Note-level lock (frontmatter), vault-level lock file.
14. External change detection and reload prompts.
15. Daily notes button and folder conventions.
16. PDF export (PuppeteerSharp).
17. DOCX export (Pandoc bundling).
18. Import-folder flow.
19. Tray utility: WPF project, named-pipe IPC, Users window, Server Settings window.
20. Windows Service registration, installer (WiX or Inno Setup).
21. Tray: Vaults window, Logs window, Backups window.
22. Automated backups.
23. 2FA (TOTP) — when ready.

Each step is independently testable and leaves the product in a usable state.

---

## 14. Open questions / deferred

- **Real-time collaborative editing** — deferred; soft locks for v1.
- **Mobile-friendly UI** — the web UI should be responsive; a dedicated mobile app is out of scope.
- **Version history / snapshots** — not planned for v1. Users rely on filesystem backups.
- **End-to-end encryption of note content** — not planned. Threat model assumes trust in the host.
- **Publishing / public share links** — deferred.
- **Plugins / extensions** — deferred.
- **Graph view of backlinks** — deferred.

---

## 15. Philosophy recap

When in doubt, favour the design that keeps the markdown files on disk as the source of truth and the app as a thin, replaceable layer over them. If a feature would require the app's database to be present for notes to be meaningful, reconsider. If a feature would break when a user copies a folder to another PC, reconsider. If a feature would lock content behind the app, reconsider.

Every feature should be testable with this question: *"If the app stopped working tomorrow, would the user still have their notes in a form they could use?"*
