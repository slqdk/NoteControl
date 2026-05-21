# Storage

Where everything lives on disk. Read this when you're touching
the file layout under DataRoot, the per-vault `.notesapp/`
folder, asset storage, or backups.

## Two roots, distinct responsibilities

```
C:\ProgramData\NoteControl\
├── NotesData\               ← DataRoot (the user's data)
└── logs\                    ← server's Serilog rolling files
```

- **DataRoot** holds *everything that's the user's*. Vaults
  (notes, folders, assets), the server DB, server-wide state
  files. A backup of DataRoot is a complete backup.
- **Logs** sit *outside* DataRoot so they don't bloat backups
  and so log retention is independent of data.

The DataRoot path is configured in `appsettings.json` under
`Storage:DataRoot`. The default and recommended location is
`C:\ProgramData\NoteControl\NotesData\`. Dev installs override
it to `dev-data` (relative to the working directory).

## DataRoot layout

```
{DataRoot}/
├── server.db                   ← server SQLite (users, vaults, sessions, audit)
├── server.db-wal
├── server.db-shm
├── .server/                    ← server-wide state files
│   ├── server.url              ← URL the tray uses to reach Kestrel
│   └── tray.token              ← rotating local-tray-auth secret
├── <Vault A>/                  ← one folder per vault
│   ├── .notesapp/              ← per-vault metadata
│   │   ├── index.db            ← SQLite + FTS5 search index
│   │   ├── index.db-wal
│   │   ├── index.db-shm
│   │   ├── templates/          ← {name}.md per template
│   │   ├── trash/              ← deleted notes (vault-scoped)
│   │   ├── startpage.json      ← dashboards + block layout
│   │   └── assignments.json    ← per-vault assignments list
│   ├── My Note.md              ← markdown body + frontmatter
│   ├── My Note.assets/         ← asset folder for "My Note.md"
│   │   └── photo.png
│   └── Project X/              ← nested folders are real folders
│       └── Spec.md
└── <Vault B>/
    └── ...
```

The vault folder is **just a folder of markdown files**. There
is no virtual hierarchy — the on-disk folder structure IS the
vault's structure. Move a file in Explorer and the next
indexer pass picks up the move (it'll appear renamed in the UI
unless the index has been told about it directly).

## .server/ folder

A small folder for files the server writes and the tray reads:

| File | What | Lifetime |
|---|---|---|
| `server.url` | Plain text. The tray reads this once at startup to find Kestrel's loopback URL. | Rewritten on every server start. |
| `tray.token` | Plain text. Random base64url token (32 bytes of entropy). | Rotated on every server start. ACL-restricted on Windows (SYSTEM, Administrators, server's process user — see [auth.md](auth.md#local-tray-token) for full details). |

Don't put anything else here without thinking about its
lifetime — the convention is "server writes, tray reads,
rotates often."

## Vault folder

Has any name and lives anywhere the server's process can
read/write. The Vault row in `server.db` carries the absolute
path; the folder's *name* and *path* are independent of the
vault's display `Name` (the user can rename either without
affecting the other).

A folder is a vault if and only if there's a Vault row
referencing it. A folder without a row is just a folder; the
"register existing folder" flow creates the row. A row pointing
at a folder that's been deleted on disk surfaces as an error
when the user tries to open the vault.

### .notesapp/ subfolder

Per-vault metadata. Reserved name; the server refuses to create
notes or folders called `.notesapp`.

| Path | What |
|---|---|
| `.notesapp/index.db` | SQLite + FTS5 index of all notes in the vault. WAL mode. |
| `.notesapp/templates/` | Each `*.md` file is one template. Filename without `.md` is the template name. A template called `Daily.md` is the body for new daily notes. |
| `.notesapp/trash/` | Deleted notes are moved here, keeping their original folder structure as subpaths. No automatic cleanup. |
| `.notesapp/startpage.json` | Dashboard layouts for the vault: positions, sizes, RSS URLs, sticky note contents, link entries. One file holds every dashboard the vault has. Saved with debounced cadence. |
| `.notesapp/assignments.json` | Per-vault Assignments page contents. Flat list of assignments, each carrying its own category. Saved with debounced cadence. |

#### startpage.json schema

The file is hand-editable JSON. The current shape (schema
version **2**) is a versioned envelope around an ordered list
of dashboards:

```json
{
  "version": 2,
  "dashboards": [
    {
      "id": "...",            // stable, client-generated UUID
      "name": "Dashboard",    // user-given; defaults to "Dashboard"
      "blocks":    [ /* RSS blocks */ ],
      "taskAreas": [ /* task areas + sticky notes */ ],
      "links":     [ /* link blocks + entries */ ]
    },
    ...
  ]
}
```

A vault always has at least one dashboard — the server seeds a
default named "Dashboard" on first load (when the file is
missing or empty), and the UI prevents deletion of the last
remaining dashboard.

**Legacy v1 read tolerance.** Files written before the multi-
dashboard ship had no `version` field and stored
`blocks` / `taskAreas` / `links` at the root (one implicit
dashboard's worth). The server reads those files, lifts them
into a single dashboard named "Dashboard" with a deterministic
id (derived from the vault id, so the synthesised dashboard's
identity is stable across re-reads), and serves them through
the same shape as v2. The v1 keys disappear from disk on the
first save — there is no automatic on-read migration write.

Hand-edits are tolerated case-insensitively (the server reads
PascalCase or camelCase and always writes camelCase). On write
the server stamps the current schema version, sorts each
dashboard's blocks / taskAreas / links by id for deterministic
diffs, and uses temp-then-rename for atomic replacement. Items
*within* an area or link block (sticky notes, link entries)
are NOT sorted — their order is user-meaningful (drag-to-
reorder semantics).

#### assignments.json schema

The file is hand-editable JSON. The current shape (schema
version **1**) is a versioned envelope around a flat list of
assignments:

```json
{
  "version": 1,
  "assignments": [
    {
      "id": "...",          // stable, client-generated
      "category": "short",  // "short" | "long" | "dev"
      "subject": "...",     // single-line headline
      "details": "..."      // multi-line body, may be empty
    },
    ...
  ]
}
```

A missing file (fresh vault) or an empty/whitespace file is
treated as an empty list — the server does not seed a default
placeholder. The UI renders three fixed category buckets
regardless of whether any assignments live in them (see
[frontend.md](frontend.md#assignments) for the bucket order).

The `category` field is stored verbatim. The UI normalises
unknown values to `"short"` at render time, so a hand-edit
that puts an unexpected string there won't drop the row, but
it'll appear in the Short Term bucket until corrected.

Stored list order is preserved on read and write — assignments
within a bucket render in the order they appear in the file.
The server normalises null fields to empty strings on both
read and write so the on-disk file stays free of `null` noise.
On write the server stamps the schema version, normalises
fields, and uses temp-then-rename for atomic replacement.

### Notes (the `.md` files)

A note is a single `.md` file at any depth in the vault folder.
Frontmatter format and the well-known fields are documented in
[notes.md](notes.md#file-on-disk-model).

### Asset folders (`<NoteName>.assets/`)

Each note that uploads an asset gets its own asset folder
*next to* the note file, named `<note basename>.assets`. So a
note `My Note.md` gets a folder `My Note.assets/`.

- Filenames inside are URL-segment-encoded for markdown
  references (spaces become `%20`, etc.) so `![]()` works
  without quoting.
- Conflicts on upload (same filename twice) get a numeric
  suffix: `photo.png`, `photo (2).png`, etc.
- The folder is created lazily on first asset upload for that
  note. Empty asset folders aren't auto-created; deleting a
  note doesn't remove its asset folder (queue: cleanup pass).

A note's body references its assets relatively:
`![alt](My%20Note.assets/photo.png)`. This means a vault
folder is **portable** — copy or move the whole vault folder
elsewhere and references stay intact.

### Folder covers

A folder can have a single cover image rendered above the search
on the Folder view (see [frontend.md § Folder view](frontend.md#folder-view)).
Storage is a hidden dotfile at the folder root: `<folder>/.folder-cover.<ext>`
with `<ext>` one of `png`, `jpg`, `gif`, `webp`, `bmp`, `svg`. The
vault root counts as a folder for this purpose — its cover lives at
`<vault>/.folder-cover.<ext>` directly.

- **Moves with the folder for free.** A folder rename / move is a
  `Directory.Move` on the on-disk folder; the cover comes along.
  No id mapping, no descendant-cover synchronisation.
- **Invisible to listings.** The folder-listing code only enumerates
  `*.md` files and non-`.notesapp`/`.assets` subdirectories, so the
  dotfile doesn't appear in the UI.
- **Not counted as user-visible content.** The "is folder empty"
  check that gates `DELETE /folder` only counts `*.md` files and
  non-`.notesapp` subfolders. A cover-only folder stays deletable;
  the cover gets nuked along with the folder.
- **At most one per folder.** Uploading a new cover deletes any
  prior `.folder-cover.*` sibling so the folder never holds two
  covers at once. The atomic temp-then-rename pattern matches note
  assets.
- **Backed up like any other vault file** — backups are a plain
  copy of DataRoot, so covers ride along.

## server.db (server-wide SQLite)

The server-wide database. Tables:

| Table | What |
|---|---|
| `Users` | All user accounts (any role). |
| `Sessions` | Active and expired session records. |
| `Vaults` | Vault rows pointing to on-disk folders. |
| `VaultPermissions` | (UserId, VaultId, Role) — the access-control table. |
| `AuditEvents` | Append-only audit log entries. |
| `__EFMigrationsHistory` | EF Core's own migration bookkeeping. |

Migrations apply automatically at server startup. The DB is in
WAL mode for concurrent reads during writes. There's no
external maintenance you need to do; SQLite VACUUM is not
scheduled.

## index.db (per-vault SQLite + FTS5)

One per vault, in `<vault>/.notesapp/index.db`. Tables:

| Table | What |
|---|---|
| `notes` | One row per note: path, title, body_text, frontmatter, mtimes. |
| `tags` | (note_path, tag) join table; cascades on note delete. |
| `notes_fts` | FTS5 virtual table. External-content over `notes` (no doubled body storage). |

Schema is versioned via SQLite's `PRAGMA user_version`. The
current version is **1**. If the constant is bumped in code,
the indexer drops + rebuilds the index from disk on next open.
That's the supported way to invalidate everyone's index after
a schema change.

The index is **derived state** — every cell can be reconstructed
by re-reading the `.md` files. Losing the index is recoverable
(rebuild via the search UI's "Rebuild index" button or
`POST /api/vaults/{id}/index/rebuild`). Losing a vault folder
is not.

## Backups

Backup target is a path the user configures (`Backup.TargetPath`
under appsettings, set via the tray's Backups tab). It can be
local (`D:\Backups\NoteControl\`) or UNC (`\\nas\backups\notecontrol\`).

Each backup creates a folder under the target named with a
timestamp:

```
{TargetPath}/
├── 2026-05-04T03-30-00Z/
│   ├── backup.manifest.json    ← what's in this backup
│   ├── server.db               ← copied from DataRoot
│   ├── .server/                ← copied from DataRoot
│   ├── <Vault A>/              ← copied as-is, including .notesapp/
│   └── <Vault B>/
└── 2026-05-05T03-30-00Z/
    └── ...
```

A backup is a **plain copy** of DataRoot at the moment the
backup ran — no proprietary archive format. You can browse it,
copy individual files out of it, restore one file by hand. The
manifest is a JSON file with the run id, source DataRoot, total
bytes, vault list, and timestamps; future "restore" UIs can
read it without parsing the folder structure.

Retention: configurable per Backup options. Pruning runs at the
**end** of a successful backup only — never at the start. So a
failed backup never destroys prior backups.

The backup runner takes a per-vault read lock to prevent
torn copies of `index.db`. Notes themselves are file-level
copies; concurrent writes during the copy could in principle
result in a backup with a half-written `.md` file, but the
window is small (`File.Copy` is fast on local disks) and the
markdown file is the user's data — losing one in-flight edit
in a backup is acceptable.

## Logs

Two distinct log streams:

| Path | What |
|---|---|
| `C:\ProgramData\NoteControl\logs\notecontrol-{date}.log` | Server-side Serilog rolling files. One per day, retained 30 days by default. Settings: `Logging.MinimumLevel`, `Logging.RetainDays`. |
| `%LOCALAPPDATA%\NoteControl\tray-crash-{date}.log` | Tray's own diagnostic log. Per-day rolling, 7-day retention. INFO + CRASH levels. Lives in the user profile, not %ProgramData%, so it survives uninstall. |

Server logs hold structured Serilog events: HTTP requests,
database operations, audit-event writes, error stacks. Tray
logs hold tray-specific lifecycle events (startup, auth path
results, unhandled exceptions).

## What's NOT in DataRoot

Things you might expect to find but won't:

- **Compiled binaries** — those live in `C:\Program Files\NoteControl\`
  (server.exe, tray.exe, wwwroot for the frontend bundle).
  Installer paths.
- **Caddy** — `C:\Program Files\Caddy\caddy.exe` plus
  `C:\ProgramData\NoteControl\caddy\Caddyfile` for the generated
  config. Not under DataRoot because it isn't user data.
- **Logs** — see above. Outside DataRoot deliberately, so
  log retention doesn't bloat backups.
- **`appsettings.json`** — lives next to the server exe in
  Program Files. Server reads it on startup.
- **HTTPS certificates / ACME state** — Caddy's own data
  directory (`C:\ProgramData\caddy\`), separate from
  NoteControl's.

## Permissions on disk

Default ACL behaviour (set by the installer):

- `C:\Program Files\NoteControl\` — Administrators full
  control, Users read/execute. Standard Program Files DACL.
- `C:\ProgramData\NoteControl\` — inherits standard ProgramData
  DACL (Administrators FullControl, Users Modify on the dir,
  more restrictive on contents).
- `{DataRoot}/.server/tray.token` — explicitly set: SYSTEM
  + Administrators FullControl, server's process user Read.
  See [auth.md](auth.md#local-tray-token) for the full grant
  set and why.

The server runs as **LocalSystem** in production, so it can
read/write anywhere under DataRoot regardless of the ACLs on
individual folders. The tray runs as the **interactive user**
and only needs read access to the few `.server/` files it
pokes at.
