# Vaults

A vault is one folder of markdown notes plus a small index DB.
Vaults are the unit of access control: you grant or remove
permissions on a whole vault.

## Concepts

- **Vault row**: a record in the server DB referencing a folder
  on disk by absolute path. Has a `Name` (human label), `OwnerId`
  (the User that originally created or registered it),
  `IconKey` + `ColorKey` (visual identity), and a `Scope`
  (`personal` or `shared`).
- **Vault folder**: the folder on disk holding the notes. May
  live anywhere the server process can read/write — the user
  picks the path when creating or registering the vault. Each
  vault folder contains a `.notesapp/` subfolder with the index
  DB and templates.
- **Vault permission**: a row mapping a User to a Vault with a
  role. Each user-vault pair has at most one permission row.
- **Dashboards**: each vault holds one or more named dashboards
  — free-floating canvases of widgets (RSS feeds, task areas,
  link blocks). Persisted in
  `{vault}/.notesapp/startpage.json`. See
  [storage.md](storage.md#startpagejson-schema) for the on-disk
  shape and [frontend.md](frontend.md#dashboards) for the UI.

## Roles

Roles on a vault, lowest to highest privilege:

- **`viewer`** — read everything (notes, folders, search,
  templates, assignments). Cannot write anything. The web UI
  hides every write affordance for a viewer-role vault: no
  dashboards section in the tree, no Daily Note + / "+" / Widgets+
  / Templates / Add-assignment buttons, every Properties field
  rendered disabled, editor in read-only mode. Opening a viewer
  vault lands on the folder root rather than a dashboard.
- **`editor`** — viewer + create/update/delete notes and folders,
  edit templates, add/rename/delete dashboards and edit their
  layout.
- **`owner`** — editor + share/unshare with other users + change
  appearance + delete the vault + rebuild the search index +
  install sample data.

The UI hiding is a **convenience**, not a security boundary —
the server gates every write endpoint on the caller's role
regardless of what the client sends. If a request bypasses the
hidden UI (URL navigation, scripted call, stale cached view),
the API still returns 403.

The owner role is granted when the vault is created (or
registered, for an existing folder). It is **stored as a
`VaultPermission` row with role `owner`**, not derived from
`Vault.OwnerId`. The `OwnerId` column is a display label
(showing whose vault it is) and a tiebreaker for "who do we
default to in admin tooling"; effective access is always
checked against the `VaultPermissions` table.

A site-wide **server `admin`** (the role on the `User` row,
not the role on the vault) does **not** automatically have
access to all vaults. Admins manage users, can see audit
events, can run backups — but to *open* someone else's vault
they need a `VaultPermission` row giving them a role on it.

## Scope

A vault's `Scope` is one of:

- **`personal`** (default) — created with a single owner
  permission.  Visible only to that owner unless they share it.
- **`shared`** — semantically the same; the difference is just
  the metadata label, used by the UI to group vaults in lists.

There is no behavioural difference; share/unshare works the
same way for both. The label is a hint to the user about how
the vault is being used.

## Identity (icon + colour)

Each vault has a visible icon and a colour. Both come from
fixed palettes:

- **Icons** (12 emoji): 📁 📓 🛠 🔧 💼 ✏️ 📊 🏠 🎓 🎨 🔬 📐
- **Colours** (8 names): `blue`, `green`, `orange`, `purple`,
  `red`, `teal`, `amber`, `pink`

If a vault has no `IconKey` / `ColorKey` set, the UI falls back
to a deterministic auto-pick based on a hash of the vault's id,
so every vault always has *some* visual identity.

The server validates writes against the same palettes — sending
an unknown icon or colour returns HTTP 400. The frontend
`VaultPicker` fixture must stay in lockstep with the server's
allow-list.

Appearance is changed via right-click on the active vault pill
in the topbar. Audit event: `VaultAppearanceChanged`.

## Lifecycle

### Create

A vault is created in two ways, both via the web UI's vault
list page (or the tray's Vaults window):

- **Create new**: server creates the on-disk folder, creates
  the `.notesapp/` subfolder, and adds the Vault row + owner
  permission. If the folder already exists with content, this
  is rejected — use Register instead.
- **Register existing**: server adopts an existing folder
  (e.g. an old vault from a previous install or a folder
  copied from another machine). It creates `.notesapp/` if
  missing and indexes whatever notes are already in the
  folder.

Both paths default the owner to the calling user. An admin
can create a vault on behalf of another user (target owner
chosen in the dialog).

Audit events: `VaultCreated`, `VaultRegistered`.

### Sharing

Owner-only. Adds or updates a `VaultPermission` row for some
other user with role `viewer` or `editor`. Self-sharing is a
no-op (you already have a permission). Unsharing is the same
endpoint with DELETE — it removes the permission row but
leaves the user account untouched.

Audit events: `VaultShared`, `VaultUnshared`.

### Sample data

Owners can install a "sample data" pack into a vault via the
Vaults window. It writes a small set of starter notes and
folders demonstrating common content types (callouts, code
blocks with ST, embedded images, daily notes layout). Only
allowed in vaults that don't already have notes — protects
against overwriting content.

Audit event: `VaultSampleDataInstalled`.

### Delete

Owner-only. Deletes the Vault row, the permission rows, and
*the on-disk folder including all notes and the index DB*.
There is no soft-delete; the only way back is from a backup.
The UI confirms with a typed-name confirmation
("type the vault name to delete"). Sample data installed in
the vault is also lost.

Audit event: `VaultDeleted`.

## Appearance per-user (vs per-vault)

Vault icon and colour are **per-vault**, stored on the Vault
row. Every user who can see the vault sees the same identity.
This is intentional — recognising vaults at a glance works
better when the icon/colour is consistent across the team.

Per-user UI preferences (tree variant, top-bar position,
sticky note default colour, app frame width) live in the
client's localStorage, separate from vault appearance.

## Last-opened persistence

The web UI remembers the last vault you opened across sessions
in localStorage under `nc:last-vault-id`. Visiting `/vaults`
redirects to that vault if it's still accessible. If the vault
has been deleted or your access revoked, the redirect is
silently dropped and you stay on the vault list page.

The tray does not have an equivalent — it always opens the
admin window the user clicked.
