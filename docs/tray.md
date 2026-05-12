# Tray application

The Windows tray app is the **administrative surface** of
NoteControl. It runs as the interactive user, talks to the
server over loopback HTTP, and is the only way to do server-
admin operations like creating users, configuring the service,
running backups, or checking logs.

Read this when you're touching the tray menu, the Settings
tabs, the admin windows, the in-app updater, or the local
tray-token auth flow.

## Lifetime

The tray launches at sign-in via the registry value
`HKLM\Software\Microsoft\Windows\CurrentVersion\Run\NoteControlTray`,
written by the installer. It runs as the **interactive user**
(not elevated) and lives until the user picks "Quit Tray" or
signs out.

A single tray process per session. There is no single-instance
guard — if the user double-launches it, two tray icons appear.
This is rare in practice (the autostart entry runs once at
sign-in) and the second instance can be quit normally.

## Menu

Right-click the tray icon. Items in order:

```
[status]                       (status, disabled — live, see below)
─────────────────────────────
Open in Browser
─────────────────────────────
Users…
Vaults…
Server Settings…
Logs…
Backups…
─────────────────────────────
Start Server
Stop Server
Restart Server
─────────────────────────────
Check for updates…             (or "Update available: vX.Y.Z")
About
Quit Tray
```

Left-clicking the icon opens the web UI in the default browser
at the resolved tray URL.

The status item at the top is **live**: it reflects the actual
server state on a rolling poll. The possible labels:

| Label              | Meaning |
|--------------------|---------|
| `● Running`        | Server up and `/health` answering 200. Tray icon is **green**. |
| `● Stopped`        | Service installed but not running, OR no service and no matching process. Tray icon is **red**. |
| `◐ Starting…`      | User-initiated Start Server is in flight. Tray icon is **amber**. |
| `◐ Stopping…`      | User-initiated Stop Server is in flight. Tray icon is **amber**. |
| `◐ Restarting…`    | User-initiated Restart Server is in flight. Tray icon is **amber**. |
| `⚠ Unreachable`    | Process visible per detection but `/health` isn't answering — startup-in-progress, hung server, or zombie process. Tray icon is **grey**. |
| `● Probing…`       | Brief bootstrap state (first ~1 second after tray launch) before the first health probe lands. Tray icon is **grey**. |

The status is driven by a polling loop running every 4 seconds
for the tray's lifetime. The poll combines a lifecycle-detection
step (the same `sc.exe` + process check the Start/Stop/Restart
commands use) with a `/health` GET (1-second timeout) to decide
between Running, Unreachable, and Stopped. The icon, the status
menu item, and the tray tooltip all update together.

The three transitional states (Starting / Stopping / Restarting)
are not derived from polling — they're a manual override. When
the user clicks Start/Stop/Restart, the tray flips the monitor
into the matching transitional state immediately (icon goes
amber, label updates), suppresses polling for the duration of
the operation, then clears the override. The next poll
(≤4 seconds later) reports the real new state. This avoids a
race where a poll lands mid-restart and flickers the label
from `◐ Restarting…` to `⚠ Unreachable` and back.

## Server lifecycle controls

Start / Stop / Restart Server use `sc.exe` against the
`NoteControlServer` Windows Service. If the calling tray isn't
elevated (it never is by default), `sc.exe` returns exit code
5 (access denied) and the tray relaunches itself with `Verb=runas`
plus the args `--service-action <verb>`. The relaunched
elevated process runs ONLY the `sc.exe` call and exits with
sc's exit code; the original tray waits on it.

Two prerequisites for non-prompting start/stop:
- The `NoteControlServer` service exists and runs as
  LocalSystem (set by the installer).
- The service's DACL has been widened to allow members of
  `Authenticated Users` the start/stop rights (also set by the
  installer). Without this, every start/stop pops UAC.

The original tray's tooltip reads "Starting…" / "Stopping…" /
"Restarting…" during the operation. Restart is bounded to
60 seconds total via a `CancellationTokenSource`.

There's also a "process mode" fallback: if the service isn't
present, the tray detects an existing
`NoteControl.Server.exe` process by name and treats it as the
running server (Stop = `taskkill`; Start = launch the exe from
its install path). This path is mostly for dev — production
deployments always have the service.

## Server URL resolution

The tray reads `{DataRoot}/.server/server.url` once at startup.
The file contains the URL Kestrel is listening on for tray
purposes (always loopback, e.g. `http://127.0.0.1:8080`). If
the file is missing, the tray falls back to
`http://127.0.0.1:8080`. If `NC_DATA_ROOT` env var is set, that
overrides the default `%ProgramData%\NoteControl\NotesData`
data root lookup.

The value is read once. If the user changes the server's port
via the Settings window and restarts the server, they need to
restart the tray too to pick up the new URL.

## Auth (local-token then password)

Documented end-to-end in [auth.md](auth.md#login-flow-tray).
Summary: every admin-window open runs `EnsureLoggedInAsync`
which probes `/health`, then tries local-token auto-login,
then falls back to the interactive Login window.

The same `IAdminClient` instance lives for the tray's lifetime,
so once you're logged in, subsequent menu clicks reuse the
session without re-prompting.

## Admin windows

Each menu item that ends with `…` opens a window. Multiple
clicks on the same item bring the existing window to front
rather than opening a second instance.

### Users window
List of all users with columns: username, email, role, status,
last login, sessions count. Buttons:
- **Add user** — opens the AddUser dialog (username, email,
  role, initial password).
- **Edit** — selected row → EditUser dialog (rename, email,
  role, status).
- **Reset password** — admin-driven password reset for any
  user. Picks a new password explicitly.
- **Sessions** — opens Sessions window for the selected user.
  Lists active sessions with revoke buttons.
- **Delete** — removes the user. Refused for the last admin
  (server returns an error).

### Vaults window
List of all vaults the calling admin can see, with columns:
name, scope, owner, on-disk path, size, member count. Buttons:
- **Create vault** — opens CreateVault dialog (name, on-disk
  path, owner).
- **Register existing vault** — opens RegisterVault dialog
  (existing folder path, name, owner). Adopts a folder that
  already has notes.
- **Members** — opens VaultMembers window for the selected
  vault: list of permissions, add member by user (with role
  picker), remove member, change role.
- **Install sample data** — owner-only; populates the vault
  with a starter set of notes if it's empty.
- **Delete** — removes the vault row, permissions, and the
  on-disk folder. Confirmation requires typing the vault name.

### Server Settings window
A tabbed window. Tab order matters because users navigate by
position; the order is fixed:

1. **Storage** — DataRoot path. Read-only display
   (configurable only via appsettings.json on the server).
2. **Network** — Kestrel port, ExposeOnLan toggle, PublicUrl
   (free-text hint, used for outbound links / display only).
3. **HTTPS** — multi-line text box of public hostnames. Server
   generates a Caddyfile for these and asks Caddy to reload.
   Requires `setup-https.ps1` to have been run once to install
   Caddy.
4. **Authentication** — session timeouts, password rules,
   rate-limiting knobs, bootstrap admin section
   (display-only after first start).
5. **Email (SMTP)** — SMTP enable + host/port/security/credentials
   + From address. A "Send test email" button POSTs to
   `/api/admin/server/smtp/test`.
6. **Backups** — backup target path, daily run time, retention
   counts (daily, weekly).
7. **Logging** — minimum log level, retention days for the
   `notecontrol-*.log` rolling files.

Save persists to `appsettings.json` (server-side rewrite). Most
settings are read with `IOptionsMonitor<T>` and apply
immediately without a server restart; the exceptions are noted
in the tab's UI text where they apply (e.g. changing the port
needs a service restart).

### Logs window
Two tabs:

1. **Audit (user actions)** — paginated list of `AuditEvents`
   rows from the server DB. Filters: event type, user, vault,
   date range. Free-text filter on the JSON details.
2. **Server log (Serilog)** — tails the latest
   `notecontrol-{date}.log` file from `C:\ProgramData\NoteControl\logs\`.
   Last N lines visible; auto-refresh button reloads the tail.

### Backups window
Three sections:
- **Status** — current schedule (or "Disabled"), target path,
  latest run timestamp, retention setting.
- **Run now** — kicks off a one-off backup; progress bar +
  status text update via polling.
- **List** — table of existing backup folders under the
  target path, one row per backup with id (timestamp folder
  name), date, size, vault count. Buttons: Restore vault
  (RestoreVault dialog: pick a vault from the manifest, choose
  a target name + parent folder, restore). Delete (recursive
  folder remove).

### About window
Read-only. Shows: tray version, server version (probed via
`/health`), build date, .NET runtime version, the licence
notice, links to the project repo. A "Check for updates" button
runs the same flow as the tray menu's "Check for updates…".

## In-app updater

The tray polls a configured GitHub release feed for newer
versions. On finding one:
- The "Check for updates…" menu item changes to
  **"Update available: vX.Y.Z"**.
- Clicking it opens an UpdateWindow with release notes and an
  Install button.
- The Install button downloads the release zip, extracts to a
  temp folder, and spawns an elevated PowerShell to run the
  installer's `install.ps1`. The installer takes over from
  there: stops the service, kills the current tray process,
  copies the new binaries, restarts the service, relaunches
  the new tray.

The updater itself only triggers; the actual self-replace is
done by `installer/install.ps1`. See [installer.md](installer.md)
for what the installer guarantees about robustness during this
hand-off.

Periodic polling cadence is roughly daily; the first check
fires a couple of seconds after tray startup so the menu is
ready quickly.

## Settings persistence

The tray itself is mostly stateless across runs. Some pieces
of state outlive a single tray run:

- **Server-side configuration** (Settings window changes) — in
  `appsettings.json` on the server.
- **Last update-check result** — in memory only; re-checked
  next launch.
- **Window positions** — not persisted today; admin windows
  re-open at default positions every time.

There is no per-user "tray preferences" file.

## Diagnostic logs (the tray itself)

The tray writes diagnostic information to
`%LOCALAPPDATA%\NoteControl\tray-crash-{yyyyMMdd}.log` —
per-day rolling, 7-day retention. Levels:

- `INFO` — normal operational milestones (startup, fallback
  URL info, auth success/failure path).
- `CRASH` — unhandled exceptions in any of three channels
  (UI dispatcher, AppDomain, unobserved Task). Each entry
  includes the channel + full exception including stack.

The log is the **first place to look** when "the tray didn't
start" or "the tray prompts for password every time" — every
auth-related fallback writes a specific INFO line so the
failure path is identifiable from the log alone.

## Single-machine vs cross-machine

The tray is designed for the case where it runs on the **same
machine** as the server. Cross-machine use:
- Loopback-only paths (server URL resolution from
  `{DataRoot}/.server/server.url`, local-token auto-login,
  service start/stop) only work locally.
- Running the tray on a different Windows box than the server
  isn't supported. There's no "remote tray" mode.
