# NoteControl documentation

This is the **living reference** for what NoteControl actually does.
Each document describes behaviour and contracts — what's observable
to a user or a caller — not how it's implemented internally.

## When to update these docs

Update the relevant doc **before or with the code change** that
changes behaviour. The docs are the spec; the code matches the
docs. If a doc is out of date the code review missed a step.

The previous spec (`NoteControl-Spec.md`) is a v0.1 design
document, kept as historical record. Don't update it; treat it as
read-only history.

## What's in each doc

| Doc | Read this when… |
|---|---|
| [architecture.md](architecture.md) | You're touching anything that crosses process boundaries (server, tray, frontend, Caddy) or wondering where something belongs. |
| [auth.md](auth.md) | You're changing login, sessions, CSRF, password rules, the bootstrap admin, the local tray token, or any `/api/auth/*` endpoint. |
| [vaults.md](vaults.md) | You're changing how vaults are created, owned, shared, or how their visual identity (icon, colour) works. |
| [notes.md](notes.md) | You're changing notes, folders, daily notes, templates, drag-and-drop, the editor, the slash menu, paste handling, or the tree view. |
| [frontend.md](frontend.md) | You're changing routes, top-bar layout, the properties panel, sticky notes, RSS blocks, the startpage, settings, keyboard shortcuts, or the appearance system. |
| [tray.md](tray.md) | You're changing the tray menu, the Settings tabs, the Users/Vaults/Logs/Backups admin windows, the tray's update mechanism, or the local tray token flow. |
| [api.md](api.md) | You're adding, removing, or changing the shape of an HTTP endpoint. (Documents only behavioural contract — exact JSON shapes live in `NoteControl.Shared/`.) |
| [storage.md](storage.md) | You're changing the on-disk file layout, the per-vault `.notesapp/` index DB, the `.server/` folder, asset storage, or anything under DataRoot. |
| [installer.md](installer.md) | You're changing `installer/install.ps1`, `installer/uninstall.ps1`, the Windows service registration, the `HKLM\Run` autostart, or `setup-https.ps1`. |
| [NoteControl-Spec.md](NoteControl-Spec.md) | (Historical only — don't update.) |

## What's NOT in these docs

By design:

- **Implementation details.** Class names, internal helpers,
  private design decisions. Read the source for those — comments
  in code are dense and explain "why". The docs explain "what".
- **Roadmaps and intentions.** Future features go in the active
  queue (chat handoff), not docs.
- **Migration history.** Git log is the source of truth for "when
  did this land".
- **Tutorials or how-to guides.** Future concern; this is a
  reference, not a manual.

## Conventions

- **"User"** = the human running the app. **"Caller"** = anything
  hitting an API (frontend, tray, curl).
- **Markdown** files, line-wrapped at ~72 cols where practical so
  diffs read cleanly in `git diff`.
- **No version numbers in body text** unless tied to a specific
  observable behaviour (e.g. "the schema version is 1"). Versions
  go in the changelog/release notes, not the spec.
