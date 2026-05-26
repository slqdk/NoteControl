# NoteControl documentation

Living reference for what NoteControl actually does today. Each
document describes behaviour and contracts — what's observable to
a user or a caller — not how it's implemented internally.

---

## For Claude (or any AI assistant) reading this

If you're an AI helping with code changes, **read this section first**.

### How to use these docs

1. The user will ask for a change in some area (auth, the
   editor, the tray, etc.).
2. **Before writing any code, fetch the matching doc(s) from the
   "Documents" table below** using their raw GitHub URLs (also
   listed below). Use the dispatch hints to pick the right
   doc(s).
3. Read the doc. The doc tells you what the current observable
   behaviour is — that's the contract you're modifying.
4. Make the change. If the change alters behaviour described in
   the doc, **update the doc in the same ship** as the code
   change. Out-of-date docs are bugs.
5. If the doc and the code disagree, surface it before acting —
   don't silently make either match the other.

Don't fetch all 9 docs up front. Fetch only what's relevant.
Most changes touch one doc, sometimes two.

### Raw URLs (use these for fetching)

```
Index:         https://raw.githubusercontent.com/slqdk/NoteControl/master/docs/README.md
architecture:  https://raw.githubusercontent.com/slqdk/NoteControl/master/docs/architecture.md
auth:          https://raw.githubusercontent.com/slqdk/NoteControl/master/docs/auth.md
vaults:        https://raw.githubusercontent.com/slqdk/NoteControl/master/docs/vaults.md
notes:         https://raw.githubusercontent.com/slqdk/NoteControl/master/docs/notes.md
frontend:      https://raw.githubusercontent.com/slqdk/NoteControl/master/docs/frontend.md
st-sandbox:    https://raw.githubusercontent.com/slqdk/NoteControl/master/docs/st-sandbox.md
tray:          https://raw.githubusercontent.com/slqdk/NoteControl/master/docs/tray.md
api:           https://raw.githubusercontent.com/slqdk/NoteControl/master/docs/api.md
storage:       https://raw.githubusercontent.com/slqdk/NoteControl/master/docs/storage.md
installer:     https://raw.githubusercontent.com/slqdk/NoteControl/master/docs/installer.md
```

If a fetch returns a 404 the file may not be pushed yet — ask
the user to confirm rather than guessing the contents.

### Working agreement (project ground rules)

Things that bite if you forget:

- **Ship complete files inside a zip**, not patches. The user
  extracts over the repo. Don't ask them to find lines and
  edit by hand.
- **PowerShell scripts**: ASCII-only with **UTF-8 BOM**. PS5.1
  reads `.ps1` as Windows-1252 without a BOM, which mangles
  any non-ASCII byte (em-dashes, accented letters). If the
  file is pure ASCII, BOM is optional but harmless. When in
  doubt, write the BOM.
- **C# files**: UTF-8 *without* BOM. Em-dashes and Danish
  letters in comments are fine.
- **Markdown / TS / TSX / JSON**: UTF-8, LF line endings.
- **Always be honest about caveats.** Document trade-offs,
  browser-compat issues, and known limitations in the ship
  README. Don't oversell.
- **Default to simple.** This is a solo-dev codebase. Prefer
  one-file solutions over architectural ceremony. Add
  complexity only when it pays off.
- **Code style**: nullable reference types, implicit usings,
  EF Core migrations applied at startup. Frontend TypeScript
  strict, React hooks. Comments are dense — explain "why",
  not "what".

### Build / test commands

Run on the dev machine (TwinCAT) from the repo root:

```powershell
# Build the .NET solution. Use this for the C# smoke test
# before declaring code "compiles".
dotnet build NoteControl.sln -c Debug

# Run the frontend dev server (hot-reload). Frontend changes
# don't need a server rebuild.
cd src\NoteControl.Frontend
npm run dev

# Smoke-test the tray locally (after dotnet build)
.\src\NoteControl.Tray\bin\Debug\net8.0-windows\NoteControl.Tray.exe

# Read the tray's diagnostic crash log (since Ship 96)
Get-Content "$env:LOCALAPPDATA\NoteControl\tray-crash-$(Get-Date -Format yyyyMMdd).log"

# Build a release zip (refuses with -Release if the working
# tree is dirty — commit first, or drop -Release for a local
# test build).
.\publish.ps1 -Version 0.X.Y -Release
```

Server logs on production live at:

```
C:\ProgramData\NoteControl\logs\notecontrol-{date}.log
```

The tray's diagnostic log lives at:

```
%LOCALAPPDATA%\NoteControl\tray-crash-{date}.log
```

(Per-day rolling, 7-day retention, INFO + CRASH levels.)

### Two machines to keep distinct

- **TwinCAT** = dev machine. Source repo lives here. Visual
  Studio builds here. `npm run dev` runs here for live frontend.
- **lightserver** = production-like server box. Compiled
  binaries deployed here via `installer\install.ps1`. The
  `NoteControlServer` Windows Service runs here as LocalSystem.
  External access via `gv38.slq.dk:2424` / HTTPS hostnames
  managed in the tray's HTTPS tab.

If you're touching deployment, the deployment scripts run on
**lightserver**, not TwinCAT. Code changes are built on TwinCAT
and shipped to lightserver as binaries.

### Active queue

The doc set describes steady-state behaviour. The active queue
of "what's broken right now" lives in the chat handoff document
the user gives you (or the project's persistent instructions).
**Read the queue before assuming any documented behaviour is
correct in the current build** — if there's an open bug for
some area, the docs may describe the *intended* behaviour while
reality differs.

When in doubt, ask the user.

---

## For humans

### When to update these docs

Update the relevant doc **before or with the code change** that
changes behaviour. The docs are the spec; the code matches the
docs. If a doc is out of date, the code review missed a step.

### Documents

| Doc | Read this when… |
|---|---|
| [architecture.md](architecture.md) | Touching anything that crosses process boundaries (server, tray, frontend, Caddy) or wondering where something belongs. |
| [auth.md](auth.md) | Changing login, sessions, CSRF, password rules, the bootstrap admin, the local tray token, or any `/api/auth/*` endpoint. |
| [vaults.md](vaults.md) | Changing how vaults are created, owned, shared, or how their visual identity (icon, colour) works. |
| [notes.md](notes.md) | Changing notes, folders, daily notes, templates, drag-and-drop, the editor, the slash menu, paste handling, or the tree view. |
| [frontend.md](frontend.md) | Changing routes, top-bar layout, the properties panel, sticky notes, RSS blocks, the startpage, settings, keyboard shortcuts, or the appearance system. |
| [st-sandbox.md](st-sandbox.md) | Changing the in-browser Structured Text runtime: the run modal, the parser/interpreter under `src/runtime/`, value pills, poking, the permissive-unknown model, or the built-in FBs (TON/TOF/R_TRIG/F_TRIG). |
| [tray.md](tray.md) | Changing the tray menu, the Settings tabs, the Users/Vaults/Logs/Backups admin windows, the tray's update mechanism, or the local tray token flow. |
| [api.md](api.md) | Adding, removing, or changing the shape of an HTTP endpoint. (Documents only behavioural contract — exact JSON shapes live in `NoteControl.Shared/`.) |
| [storage.md](storage.md) | Changing the on-disk file layout, the per-vault `.notesapp/` index DB, the `.server/` folder, asset storage, or anything under DataRoot. |
| [installer.md](installer.md) | Changing `installer/install.ps1`, `installer/uninstall.ps1`, the Windows service registration, the `HKLM\Run` autostart, or `setup-https.ps1`. |
| [NoteControl-Spec.md](NoteControl-Spec.md) | (Historical only — the v0.1 design-phase document. Don't update.) |

### What's NOT in these docs

By design:

- **Implementation details.** Class names, internal helpers,
  private design decisions. Read the source for those —
  comments in code are dense and explain "why". The docs
  explain "what".
- **Roadmaps and intentions.** Future features go in the
  active queue (chat handoff), not docs.
- **Migration history.** Git log is the source of truth for
  "when did this land".
- **Tutorials or how-to guides.** Future concern; this is a
  reference, not a manual.

### Conventions

- **"User"** = the human running the app. **"Caller"** =
  anything hitting an API (frontend, tray, curl).
- **Markdown** files, line-wrapped at ~72 cols where practical
  so diffs read cleanly in `git diff`.
- **No version numbers in body text** unless tied to a
  specific observable behaviour (e.g. "the schema version is
  1"). Versions go in the changelog/release notes, not the
  spec.
