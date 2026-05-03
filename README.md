# NoteControl

A self-hosted, multi-user notes app for Windows. Notes are plain
markdown files on disk, one folder per vault — open them in any
editor, sync them with any tool, back them up by copying a folder.
The app is just a friendly UI on top.

---

## What it looks like

<!--
    Drop screenshots into docs/screenshots/ and reference them here.
    Suggested shots:
      - The editor with a daily note open
      - The Startpage with RSS blocks + task areas
      - The tray menu
      - The Server Settings window
-->
*(Screenshots coming soon — drop them in `docs/screenshots/` and edit
this section.)*

---

## Why

Most notes apps lock your data inside their database, sync service,
or proprietary file format. Move on, lose access. The cost of "I'll
just try this app" is high.

NoteControl tries the opposite trade: every note is a `.md` file
in a folder you own, attachments are stored next to their note in a
`{name}.assets/` sibling folder, and backups are folder copies. If
this project disappears tomorrow, your notes are still there in
plain text, indexed by Windows Search like any other folder.

The app adds: a TipTap-based WYSIWYG editor with live markdown
round-trip, multi-user access over HTTPS, full-text search via
SQLite FTS5, daily-notes templates, RSS feed widgets, and a
Windows tray for admin/server-control without a browser.

---

## Architecture at a glance

```
┌──────────────────────────────────────────────────────┐
│ Windows host                                         │
│                                                      │
│  ┌────────────────┐       ┌──────────────────────┐   │
│  │ Tray           │       │ Server               │   │
│  │ (WPF +         │       │ (ASP.NET Core 8 +    │   │
│  │  H.NotifyIcon) │──────►│  EF Core + SQLite +  │   │
│  │ Admin windows  │ HTTP  │  Serilog)            │   │
│  └────────────────┘       │ runs as Windows Svc  │   │
│                           └──────────┬───────────┘   │
│                                      ▼               │
│                     C:\ProgramData\NoteControl\      │
│                       NotesData\                     │
│                         users\<name>\<vault>\        │
│                         shared\<vault>\              │
│                       logs\                          │
│                       .server\  (db, csrf key, etc.) │
└──────────────────────────────────────────────────────┘
            ▲
            │ HTTPS via Caddy (optional)
   ┌────────┴────────┐
   │ Browser (any device on the LAN) │
   └─────────────────────────────────┘
```

The frontend is React + Vite + TipTap, built into a static bundle
and served from the same Kestrel process that runs the API. One
URL, one port, no separate dev servers in production.

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Server | ASP.NET Core 8, EF Core, SQLite, Serilog |
| Tray | WPF (.NET 8), H.NotifyIcon.Wpf |
| Frontend | React + Vite + TipTap + DOMPurify, TypeScript strict |
| Search | SQLite FTS5 |
| Reverse proxy (optional) | Caddy (for HTTPS / Let's Encrypt) |
| Storage | Plain markdown files on disk + per-vault SQLite index |

---

## Install (binary)

The fastest way to try NoteControl on a Windows machine.

1. Go to [Releases](../../releases/latest) and download
   `NoteControl-<version>.zip`.
2. Extract anywhere (e.g. your Downloads folder).
3. Open an **elevated PowerShell** (right-click PowerShell →
   *Run as administrator*) and run:
   ```powershell
   cd path\to\extracted\NoteControl-<version>
   .\installer\install.ps1
   ```
4. The installer:
   - Copies binaries to `C:\Program Files\NoteControl\`
   - Registers `NoteControlServer` as a Windows service (auto-start)
   - Adds the tray to HKLM Run (launches at login for any user)
   - Creates an Add/Remove Programs entry
   - Probes `http://127.0.0.1:8080/health` to verify the service is up
5. Open http://localhost:8080 in your browser. Default login is
   created from the tray (right-click tray icon → Users…).

### Updating

Once installed, the tray polls GitHub Releases once per day. When
a newer version is published, you'll see *"Update available: X.Y.Z"*
in the tray menu. Click it → release notes + Install button →
elevated PowerShell runs the new installer → service restarts →
new tray launches. About 30 seconds end-to-end, no reboot needed.

You can also re-run a fresh `installer\install.ps1` from a newer
release zip; the installer detects the existing install and
performs an in-place upgrade. Vault data under
`C:\ProgramData\NoteControl\` is never touched by the installer.

### Uninstall

- Add/Remove Programs → NoteControl → Uninstall, **OR**
- Elevated PowerShell: `& "C:\Program Files\NoteControl\uninstall.ps1"`

By default, vault data is preserved. Pass `-RemoveData` to also
delete `C:\ProgramData\NoteControl\` (you'll be asked to type
"DELETE" to confirm).

---

## Build from source

You'll need:

- Windows 10/11
- Visual Studio 2022 with the *.NET desktop development* and
  *ASP.NET and web development* workloads
- .NET 8 SDK (comes with VS2022)
- Node.js 20+ and npm

Then:

```powershell
git clone https://github.com/<your-fork>/NoteControl.git
cd NoteControl
git submodule update --init --recursive  # if any (currently none)
```

Open `NoteControl.sln` in Visual Studio. The four projects are:

| Project | What it does |
|---------|--------------|
| `NoteControl.Server` | The ASP.NET Core 8 server. F5 to run. |
| `NoteControl.Tray`   | The WPF tray. Set as startup project alongside the server for full local testing. |
| `NoteControl.Shared` | DTOs shared between server and tray. |
| `NoteControl.Tests`  | xUnit tests (server-side). |

The frontend is a separate npm project; see
[`src/NoteControl.Frontend/README.md`](src/NoteControl.Frontend/README.md)
for its dev workflow.

### Producing a release zip

From the repo root, in PowerShell:

```powershell
.\publish.ps1 -Version 0.1.0 -Zip
```

This builds the frontend, publishes the server (self-contained
win-x64) with the frontend inlined into `wwwroot/`, publishes the
tray, copies the installer scripts, and produces
`dist\NoteControl-0.1.0.zip`. Upload that as a release asset on
GitHub and the in-app updater will pick it up.

See [`docs/NoteControl-Spec.md`](docs/NoteControl-Spec.md) for the
full design document, and [`CHANGELOG.md`](CHANGELOG.md) for
feature history.

---

## Where things live on disk

| Path | What's there |
|------|--------------|
| `C:\Program Files\NoteControl\` | Binaries (server, tray, installer scripts) |
| `C:\ProgramData\NoteControl\NotesData\` | Vault folders. **This is your data — back this up.** |
| `C:\ProgramData\NoteControl\NotesData\users\<name>\<vault>\` | A user's personal vault. |
| `C:\ProgramData\NoteControl\NotesData\shared\<vault>\` | Shared vaults across users. |
| `C:\ProgramData\NoteControl\NotesData\.server\` | Server state: db, CSRF key, tray.token, server.url |
| `C:\ProgramData\NoteControl\logs\` | Daily Serilog files |

Inside each vault:

```
MyVault/
├── note-at-root.md
├── note-at-root.assets/
│   └── pasted-image.png
├── Subfolder/
│   └── another-note.md
└── .notesapp/
    ├── index.db                 (per-vault search index, regenerable)
    ├── templates/
    ├── trash/                   (deleted notes, kept for recovery)
    ├── startpage.json           (RSS blocks + task areas)
    └── config.json              (optional per-vault config)
```

A backup is `xcopy MyVault MyBackup /e`. Restore is the reverse.
The `.notesapp/index.db` is rebuildable from the markdown files —
deleting it triggers a full re-index on next vault open.

---

## Caveats and known limitations

- **Project maturity.** Actively developed, tested by one person.
  Solid for personal use, but not battle-tested across many
  machines. Bug reports are welcome via GitHub Issues.
- **Windows-only.** Server, tray, and installer all assume Windows.
  No plans for cross-platform.
- **Desktop-first UI.** The frontend works on phones but isn't
  tuned for touch. Keyboard + mouse is the design target.
- **Single-machine deployment.** No cluster mode, no shared storage,
  no replication. One Windows host runs the server; clients are
  browsers on the LAN.
- **HTTPS via Caddy.** The server itself only speaks HTTP. For
  HTTPS / Let's Encrypt, drop a Caddy reverse proxy in front (see
  [`deploy/`](deploy/)).
- **Self-signed code.** The installer scripts and exes aren't code-
  signed. Windows SmartScreen will warn on first run. Expected for
  a free, self-hosted app — you wrote (or read) the scripts, so
  trust them on that basis.

---

## License

<!--
    If you picked MIT (the default for "I have no preference"):
      keep this section. Add a LICENSE file with the MIT text.
    If you picked something else, replace this paragraph and the
    LICENSE file accordingly.
-->
MIT — see [`LICENSE`](LICENSE).

---

## Project history

See [`CHANGELOG.md`](CHANGELOG.md) for the per-feature ship history.
The full design document is in [`docs/NoteControl-Spec.md`](docs/NoteControl-Spec.md).
