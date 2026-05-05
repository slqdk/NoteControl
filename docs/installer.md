# Installer

What the install / uninstall / setup scripts do, and the
contracts they uphold for things like autostart and recovery.
Read this when you're touching `installer/install.ps1`,
`installer/uninstall.ps1`, or `deploy/setup-https.ps1`.

## Three scripts, three jobs

| Script | Where | What it does |
|---|---|---|
| `installer/install.ps1` | Bundled in every release zip | Lays down a fresh install or upgrades an existing one. Handles the service, autostart, ACLs, file copies, version metadata, and tray relaunch. |
| `installer/uninstall.ps1` | Bundled, also copied next to the install on first install | Removes the service, autostart entry, ARP entry, and binaries. Leaves DataRoot alone unless `-RemoveData` is passed. |
| `deploy/setup-https.ps1` | Lives in the source repo, run manually once | Installs Caddy as a Windows service so the tray's HTTPS tab can manage it. Not part of release zips today. |

## install.ps1

### Inputs
A few key parameters (all optional, sensible defaults):
- `-InstallDir` — where the binaries go. Default
  `C:\Program Files\NoteControl`.
- `-DataRoot` — where the user's data goes. Default
  `C:\ProgramData\NoteControl\NotesData`.
- `-ServiceName` — Windows service name. Default
  `NoteControlServer`.
- `-NoTrayLaunch` — skip the post-install tray launch (used
  when invoked from the in-app updater that takes over the
  relaunch itself).

### Phases (in order)

The script runs in named phases. Each phase logs a section
header to console + `install.log`. The order matters because
each phase depends on the previous succeeding:

1. **Stopping running components** — stops the service if
   running, kills any running tray processes, waits up to 15s
   for the tray to actually exit (file locks).
2. **Copying files to InstallDir** — creates `InstallDir`
   if missing; copies `server\` and `tray\` subdirs from the
   release zip; copies `VERSION.txt` and `uninstall.ps1`.
   Failure here is fatal.
3. **Registering tray autostart** — writes the
   `HKLM\…\Run\NoteControlTray` value pointing at the new
   `tray.exe`. Done **immediately after the file copy** so
   that any later step can fail without leaving autostart in
   a stale state. The script aborts if `tray.exe` isn't
   actually on disk after the copy.
4. **Preparing data root** — creates DataRoot and the
   logs directory if missing. Existing data is left untouched.
5. **Configuring Windows service** — creates the
   `NoteControlServer` service (or updates `binPath` if it
   already exists). Runs as `LocalSystem`, auto-start.
6. **Granting service start/stop to Authenticated Users** —
   widens the service's DACL so the un-elevated tray can call
   `sc.exe start/stop` without UAC. If the DACL grant fails,
   start/stop falls back to a UAC elevation prompt — the tray
   still works, it's just chattier.
7. **Starting service** — `sc start`, then probes `/health`
   for up to 30s. Failure here doesn't abort the install
   (binaries are good); it just surfaces a warning.
8. **Registering uninstaller** — creates the Add/Remove
   Programs entry pointing at `uninstall.ps1`.
9. **Launching tray** (unless `-NoTrayLaunch`) — tries to
   launch the tray as the interactive user via Task Scheduler,
   then falls back to `Start-Process` if that doesn't work.
   On failure, the script logs a diagnostic block (is
   `tray.exe` on disk? is `HKLM\Run` correct? is there a
   recent crash log?) so the user can recover without a full
   reboot.

### Logs

Everything writes to `install.log` in the same folder as
`install.ps1`. The log streams in real time as the script
runs; on success it stays for review, on failure it's the
first place to look.

### Idempotence

`install.ps1` is **safe to re-run**. Re-running:
- Stops the service if running, copies files, restarts.
- Updates the `HKLM\Run` value (idempotent — same value
  stays the same).
- Updates the service's `binPath` if it changed (e.g. you
  moved the install to a different path).
- Doesn't touch DataRoot.

This means it works as both "fresh install" and "upgrade" with
no separate code path.

### Failure modes worth knowing

- **Tray locked**: file copy fails because the previous tray
  exe is still in use. The script waits 15s for the tray to
  exit and then continues; if the file is still locked the
  copy fails and the script aborts. Recovery: kill the
  stuck `NoteControl.Tray.exe` from Task Manager and re-run.
- **Service fails to start**: usually a misconfiguration in
  `appsettings.json` (e.g. invalid port). The script doesn't
  abort — it warns and lets the user fix the config and
  start the service manually.
- **Tray autostart launched but tray crashes**: the
  diagnostic block at step 9 looks for a recent crash log
  in `%LOCALAPPDATA%\NoteControl\` and reports it. The crash
  log itself names the failure cause.

## uninstall.ps1

### Default behaviour

Reverses what `install.ps1` did, but **leaves data alone**:
- Stops + deletes the service.
- Stops the tray if running.
- Removes `HKLM\…\Run\NoteControlTray`.
- Removes the Add/Remove Programs entry.
- Deletes `InstallDir`.

DataRoot and the logs folder are untouched. A user who
reinstalls keeps their notes.

### `-RemoveData`

With `-RemoveData`, the uninstaller also deletes
`C:\ProgramData\NoteControl\` (DataRoot, logs, the server DB,
and any local backup state). Destructive. The script prompts
for interactive confirmation unless `-Force` is also passed.

### Where it runs from

Two paths:
- **Manually from the source release zip** — passes
  `-InstallDir` explicitly.
- **From Add/Remove Programs** — Windows invokes
  `<InstallDir>\uninstall.ps1` directly. The script detects
  that it's running from inside `InstallDir` and uses its
  own folder as the default.

The script tolerates partial state: missing service, missing
`HKLM\Run` entry, missing ARP entry are all just logged as
"already gone, skipping" rather than errors. So an interrupted
install can still be cleaned up by running `uninstall.ps1`.

## setup-https.ps1

Optional. Installs Caddy as a Windows service so the tray's
HTTPS tab can manage hostnames. One-time setup; not bundled in
release zips.

### What it does

1. Copies the bundled `caddy.exe` to
   `C:\Program Files\Caddy\`.
2. Creates a Windows service named `caddy` running
   `caddy run --config C:\ProgramData\NoteControl\caddy\Caddyfile --adapter caddyfile`.
3. Opens Windows Firewall ports 80 and 443 inbound.
4. Starts the Caddy service.

### Why this isn't part of `install.ps1`

The user might not want HTTPS at all (LAN-only, behind a VPN,
behind a different reverse proxy), so we don't impose Caddy
on every install. `setup-https.ps1` is a deliberate one-time
opt-in.

### How the server interacts with Caddy

After `setup-https.ps1` has run, the server takes over Caddy
configuration:
- The server stores the list of public hostnames in its own
  `appsettings.json` under `Network.PublicHostnames`.
- On any change to that list (via the tray's HTTPS tab), the
  server regenerates `C:\ProgramData\NoteControl\caddy\Caddyfile`
  and runs `caddy reload --config <path>` to apply without a
  restart.
- The server's `CaddyConfigWriter` resolves `caddy.exe` by
  checking `C:\Program Files\Caddy\` first, then walking
  `PATH` as a fallback. Both work; the explicit-path lookup
  exists because `Program Files\Caddy` isn't on the system
  `PATH` after install.

### Caddyfile path

The Caddyfile is fixed at
`C:\ProgramData\NoteControl\caddy\Caddyfile` regardless of
where DataRoot is configured. This is intentional — the path
is hardcoded in both the server (Caddy reload command) and the
setup script (Caddy service argument); decoupling it from
DataRoot avoids the case where someone moves DataRoot and the
Caddy service can't find its config.

## Release zip layout

Produced by `publish.ps1` at the repo root. Each release zip
contains:

```
NoteControl-vX.Y.Z.zip
├── installer/
│   ├── install.ps1
│   └── uninstall.ps1
├── server/
│   ├── NoteControl.Server.exe
│   ├── NoteControl.Server.dll
│   ├── *.dll                       (dependencies)
│   ├── appsettings.json
│   └── wwwroot/                    (built frontend bundle)
└── tray/
    ├── NoteControl.Tray.exe
    ├── NoteControl.Tray.dll
    ├── *.dll                       (dependencies)
    └── Resources/
        └── tray.ico
```

`server/` and `tray/` are self-contained .NET 8 publishes for
`win-x64`. The user's machine doesn't need a .NET runtime
installed.

## In-app updater hand-off

The tray's update flow ends by spawning an elevated PowerShell
to run `installer/install.ps1` from a temp folder where the
new release zip was extracted. From the installer's
perspective this is just another invocation. The contract:

- The new tray will be launched at the end of `install.ps1`
  step 9.
- If step 9 fails, the previous tray is already dead (killed
  in step 1) and the user has to manually relaunch via the
  Start menu or sign out and back in. Step 9's diagnostic
  block tells them which.
- The `HKLM\Run` autostart is updated in step 3, so even if
  the rest of the install fails after that, the **next sign-in
  reboot will launch the new tray**. This is the contract that
  makes "broken update can be recovered by reboot" reliable.

## Common pitfalls

- **PowerShell 5.1 codepage**: install.ps1 must be ASCII-only
  unless saved with UTF-8 BOM. PS5.1 reads .ps1 files as
  Windows-1252 without a BOM, which mangles em-dashes and
  similar bytes. The current scripts are pure ASCII; keep
  them that way.
- **`sc.exe create binPath="…"` doesn't work in PowerShell**:
  PS5.1 mangles the quoting. Use `New-Service` instead.
- **DataRoot vs install dir**: don't conflate the two.
  The Caddyfile path used to (incorrectly) be derived from
  DataRoot; that broke when DataRoot wasn't the default.
  All paths to operational files (the Caddyfile in particular)
  should be hardcoded to `C:\ProgramData\NoteControl\…`, not
  derived from DataRoot.
- **Visual Studio open during dev install**: VS holds locks on
  binaries in `bin/`. If you're running `install.ps1` against
  your own dev tree, close VS first.
