# Ship 48 — PowerShell installer + uninstaller

## What this ships

A two-script installer (`installer\install.ps1` + `installer\uninstall.ps1`)
plus an updated `publish.ps1` that bundles the installer into the
dist folder. The dist folder produced by `publish.ps1 -Zip` is now
self-installable: extract the zip on a Windows machine, run
`installer\install.ps1` as Administrator, done.

This is the foundation for Ship 49 (in-app "Check for updates")
and Ship 50 (GitHub Actions release pipeline). Neither of those
needs to land before this is useful.

## What the installer does (in order)

1. Verifies it's running as Administrator. Exits with guidance otherwise.
2. Verifies it's running from a published dist folder (looks for
   `..\server\NoteControl.Server.exe` and `..\tray\NoteControl.Tray.exe`).
3. Detects whether this is a fresh install or an upgrade.
4. Stops the `NoteControlServer` service if it's running.
5. Kills the tray process if running (so we can replace its `.exe`).
6. Copies `server\` and `tray\` from the dist folder into
   `C:\Program Files\NoteControl\`.
7. Copies `VERSION.txt` and `uninstall.ps1` into the install dir
   so the uninstall path is self-contained.
8. Creates `C:\ProgramData\NoteControl\NotesData\` and
   `C:\ProgramData\NoteControl\logs\` if they don't exist. Never
   touches existing contents.
9. Registers (or updates) the `NoteControlServer` service:
   - `binPath=` points at the new server exe
   - `start=auto` so it comes up at boot
   - Description set; failure recovery configured to restart 3 times
     after 60s (the 4th failure is silent to avoid crash-loop spam)
   - Runs as LocalSystem (default).
10. Starts the service and probes `http://127.0.0.1:8080/health`
    for up to 30 seconds.
11. Adds an HKLM Run entry so the tray launches at login for any
    user on the machine.
12. Writes an Add/Remove Programs entry under
    `HKLM\...\Uninstall\NoteControl` pointing at the bundled
    uninstaller.
13. Launches the tray for the current user (so you don't have to
    log out/in to get it running right after install).
14. Writes `install.log` next to the binaries for diagnostics.

## What the uninstaller does

1. Verifies Admin.
2. Stops + deletes the service.
3. Stops the tray.
4. Removes the HKLM Run entry.
5. Removes the Add/Remove Programs entry.
6. Deletes the install dir contents.
   - **Caveat:** PowerShell holds the executing script file open,
     so when you run uninstall.ps1 from inside the install dir
     (the Add/Remove Programs flow does this), the script file
     itself can't be deleted while running. The folder is left
     in place; the script tells you exactly how to clean it up
     after exit. Annoying but correct.
7. **Vault data is preserved by default.** Pass `-RemoveData`
   to also delete `C:\ProgramData\NoteControl\`. With that switch,
   the script asks for explicit "DELETE" confirmation unless
   `-Force` is also set.

## Layout produced

```
C:\Program Files\NoteControl\
├── server\
│   ├── NoteControl.Server.exe
│   ├── appsettings.json
│   ├── wwwroot\...
│   └── ... (DLLs)
├── tray\
│   └── NoteControl.Tray.exe
├── VERSION.txt
├── install.log              ← written each run
└── uninstall.ps1            ← copy of the installer's uninstaller

C:\ProgramData\NoteControl\
├── NotesData\               ← vaults (untouched on install/upgrade)
│   └── ...
├── logs\
│   └── notecontrol-{date}.log
└── ... (.server\, etc., as before)
```

## Files in this ship

- `installer/install.ps1` — the installer (~470 lines, dense
  comments).
- `installer/uninstall.ps1` — the uninstaller (~265 lines).
- `publish.ps1` — full replacement; adds an `installer\` copy
  step and updates the post-build summary text.

## Apply order

1. Extract over repo root. The `installer\` folder is new at
   repo root; `publish.ps1` is a replacement.
2. **No code rebuild needed for this ship.** This is tooling
   only — no C# or TypeScript changed. You can run the new
   `publish.ps1` immediately to produce a dist folder that
   includes the installer.

## How to test

This is the kind of thing where you really want to test on a
machine you don't mind cleaning up. Two paths:

### A. Hot install on the dev machine (fast feedback)

```powershell
# From the repo root, in a normal PowerShell:
.\publish.ps1 -Version 0.1.0 -Zip
```

Then in an **elevated** PowerShell:

```powershell
cd .\dist\NoteControl-0.1.0\
.\installer\install.ps1
```

After it finishes:
- `services.msc` shows `NoteControlServer` as Running.
- `Get-Process NoteControl.Tray` shows the tray running.
- Tray icon visible by the clock.
- `Add/Remove Programs` lists "NoteControl 0.1.0".
- Browser at `http://localhost:8080` shows the app.

To uninstall:

```powershell
# Either:
& "C:\Program Files\NoteControl\uninstall.ps1"
# Or via the GUI (Add/Remove Programs → NoteControl → Uninstall).
```

### B. Test in-place upgrade

After step A succeeded, change something trivial, bump version,
and re-run install:

```powershell
.\publish.ps1 -Version 0.1.1 -Zip
cd .\dist\NoteControl-0.1.1\
.\installer\install.ps1
```

The installer should print "Detected existing install -- will
perform in-place upgrade.", stop the service + tray, replace
files, restart. Notes data in ProgramData stays untouched.

### C. Test data preservation on uninstall

```powershell
& "C:\Program Files\NoteControl\uninstall.ps1"
# (No -RemoveData)
```

Verify `C:\ProgramData\NoteControl\NotesData\` still exists with
your vaults intact. Re-installing should pick them right back up.

## Honest caveats

- **Couldn't run-test the PowerShell from this container.** Manual
  review only. Test on a snapshot/VM first if you can — installers
  on real Windows always have surprises. Most likely failure points:
  the `sc.exe` invocations (PowerShell + native exe + paths with
  spaces is a notorious combo) and the `Start-Process` of the tray
  inheriting an elevated token. I used the args-array form for sc.exe
  precisely because it's the most reliable; if there's still an issue
  it'll be a quoting one and probably easy to fix.

- **Assumes default port 8080 for the post-install health probe.**
  If you've already set a custom port in `Storage:DataRoot/.server/config.json`
  before the upgrade, the probe will fail (server is responding on
  the right port, just not 8080). Service is still installed correctly;
  just the probe message is misleading. Fixable later by reading
  `{DataRoot}\.server\server.url` after Kestrel binds — but for a
  fresh install the default is the right answer.

- **No code signing.** Windows Defender SmartScreen will probably
  warn on the first run ("This script is from an untrusted source").
  For a self-hosted single-user install this is fine — you wrote
  it. Code signing is a real cost (~$200/yr for a cert) and only
  matters if you redistribute publicly. Mention if/when you decide
  to sign and I'll add the signing step to publish.ps1.

- **Service runs as LocalSystem.** Per your decision in the
  prep convo. This is the same identity Ship 38 assumed. Maximum
  privileges; in exchange, no permission headaches around
  `C:\ProgramData\NoteControl\`. If you ever want to lock this
  down to NetworkService or a dedicated account, add `obj=` and
  `password=` to the sc.exe args and grant the account write on
  the data root.

- **HKLM Run launches tray for every user that logs in.** If you
  have multiple Windows users on the box, each one gets a tray
  on login. If only one ever logs in, this is invisible.
  Per-user: change `HKLM` to `HKCU` in install.ps1, but then the
  installer can only set up the tray for the user running the
  install. HKLM is the cleaner default.

- **Self-deleting uninstaller leaves its own .ps1 file.**
  Documented in the uninstall section above. The folder
  `C:\Program Files\NoteControl\` is left in place containing
  just `uninstall.ps1` and `install.log`. User can manually
  delete after the script exits, or wait until next install.

- **No rollback if install fails midway.** If the service registers
  but the health probe fails, you have a working binary install
  but a misconfigured server. The error message points at the
  log directory. Rolling back would require snapshotting the
  pre-install state, which is significantly more code. The
  probability of partial failure is low for a script with this
  shape.

## What didn't change

- C# code (server, tray).
- Frontend.
- DataRoot location, config layering, anything about the running
  app's behaviour.

## Next from the queue

- **Ship 49:** Tray "Check for updates" feature. Polls GitHub
  Releases API, shows "Update available" notification, downloads
  the new `NoteControl-{version}.zip`, extracts, runs
  `installer\install.ps1` with elevation. Closes the loop with
  this ship.
- **Ship 50:** GitHub Actions workflow for tag-triggered releases
  (auto build + auto upload to a Release on `git push --tags`).
  Optional polish; you can do releases manually until then.
- And the older queue: tray status reflects real server state,
  RSS polish, ℹ️ disable on Startpage.
