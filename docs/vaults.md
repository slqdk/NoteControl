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

## Roles

Roles on a vault, lowest to highest privilege:

- **`viewer`** — read everything, run searches, see the
  startpage. Cannot write notes, change templates, share, or
  configure.
- **`editor`** — viewer + create/update/delete notes and folders,
  edit templates, edit the startpage layout.
- **`owner`** — editor + share/unshare with other users + change
  appearance + delete the vault + rebuild the search index +
  install sample data.

The owner role is granted when the vault is created (or
registered, for an existing folder). It is **stored as a
`VaultPermission` row with role `owner`**, not derived from
`Vault.OwnerId`. The `OwnerId` column is a display label
(showing whose vault it is) and a tiebreaker for "who do we
default to in admin tooling"; effective access is always
checked against the `VaultPermissions` table.

A site-wide **server `admin`** (the role on the `User` row,
not the role on the vault) does **not** automatically have
access to all vaults — they cannot *open* someone else's vault
without a `VaultPermission` row. They *can*, however, perform
owner-level management actions (share, unshare, delete,
install sample data) on any vault, even one they have no
permission row on. This is the admin override; it bypasses the
ownership check on the management endpoints but does not
synthesise a permission row, so it does not unlock note
contents.

## Scope

A vault's `Scope` is one of:

- **`personal`** — vault folder lives under
  `users/<owner-username>/<vault-name>` relative to DataRoot.
  The default for a vault created by an ordinary user.
- **`shared`** — vault folder lives under
  `shared/<vault-name>` relative to DataRoot. Used for vaults
  meant to be shared across users from the start.

The user does **not** choose `Scope` as a free metadata label.
It is derived from the first segment of the relative path
when creating or registering the vault — `users/...` produces
a `personal` row, `shared/...` produces a `shared` row, anything
else is rejected with HTTP 400. Once written, `Scope` is
immutable from the API surface.

Both scopes share the same permission model and the same
share/unshare endpoints. The behavioural difference is the
on-disk location and the corresponding path prefix the caller
must use. The UI uses the label to group vaults visually in
lists.

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

Appearance is changed via right-click on a vault pill in the
topbar's vault picker (works on the active pill or any other
pill in the picker — the pill that was right-clicked is the
one whose appearance changes). Audit event:
`VaultAppearanceChanged`.

## Lifecycle

### Create

A vault is created in two ways, both via the tray's Vaults
window (the web UI does not currently expose vault creation):

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

Owner-or-admin. Adds or updates a `VaultPermission` row for
some other user with role `viewer` or `editor`. Self-sharing
is a no-op (you already have a permission). Unsharing is the
same endpoint with DELETE — it removes the permission row but
leaves the user account untouched.

Audit events: `VaultShared`, `VaultUnshared`.

### Sample data

Owner-or-admin. Owners (and admins acting on any vault) can
install a "sample data" pack via the Vaults window. It writes
a small set of starter notes and folders demonstrating common
content types (callouts, code blocks with ST, embedded images,
daily notes layout). Only allowed in vaults that don't already
have notes — protects against overwriting content.

Audit event: `VaultSampleDataInstalled`.

### Delete

Owner-or-admin. Drops the Vault row and the cascading
permission rows from the server DB, then **moves** the on-disk
folder to a sibling quarantine directory rather than deleting
it. The quarantine path is `<parent>/.deleted/<vault-name>-<UTC-timestamp>-<vault-id-N>/`,
where `<parent>` is the directory that contained the vault
folder. Notes inside survive intact; the vault simply becomes
invisible to NoteControl.

The Recycle Bin is deliberately **not** used: the server may
run as a Windows Service without a desktop session, where
recycle is unavailable.

The quarantine folder is **never auto-pruned**. Cleanup is a
manual operation — empty `.deleted/` by hand when you no
longer need the recoverable copies. Recovery is also manual:
move the folder back to its original path and re-register it
via the Vaults window.

Before the move, the server evicts its cached SQLite
connection on `<vault>/.notesapp/index.db` so Windows will
allow the directory rename. If something *outside* the server
(antivirus, a file-explorer preview, a future watcher) is
holding a handle inside the vault, the request fails with
HTTP 409 and an explanatory message; nothing is moved or
removed in that case, and the call can be retried.

The tray's Vaults window confirms the delete with an
OK/Cancel dialog that names the vault path and explains the
quarantine behaviour. There is no typed-name confirmation.
The web UI does not currently expose vault deletion.

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
