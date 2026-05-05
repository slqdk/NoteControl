# NoteControl.Frontend

React + TypeScript + Vite + TipTap. The web UI for NoteControl.

This is **not** a Visual Studio project. VS2022 shows it as a Solution
Folder with a few files pinned for easy access; the actual build is
driven by npm + Vite.

## Getting started

```powershell
cd src\NoteControl.Frontend
npm install
npm run dev
```

Vite serves the app at `http://127.0.0.1:5173/` and proxies `/health`
and `/api/*` to the ASP.NET Core backend on port 8080. Start the
backend (F5 on `NoteControl.Server` in VS, or `dotnet run` in that
project directory) before visiting the dev URL.

For a one-click full-stack dev launch, run `start-dev.cmd` from the
repo root — opens both servers in their own windows and pops the
browser when Vite is ready.

## Production build

```powershell
npm run build
```

Output lands in `dist\`. The deployment script `publish.ps1` (at the
repo root) automates the full pipeline — builds the frontend,
copies the bundle into the server's `wwwroot\`, publishes the server
+ tray as self-contained win-x64, copies the installer scripts, and
produces a `dist\NoteControl-<version>.zip` ready for GitHub
Releases.

## Layout

```
src/
├── api/             API client + TS types mirroring server DTOs
├── auth/            AuthContext + RequireAuth route guard
├── components/      Shared UI: editor, top bar, tree, sticky notes,
│                    RSS blocks, properties panel, dialogs, etc.
├── editor/          TipTap extensions: slash menu, callout, code
│                    block with title, image controls, video, asset
│                    paste, table delete shortcut, ST highlighter
├── hooks/           Custom hooks (debounced save, mobile detection)
├── markdown/        tiptap-markdown configuration
├── pages/           Route targets: Login, VaultList, Folder, Editor,
│                    Startpage, Templates
├── settings/        User-tunable defaults (appearance, note
│                    defaults, tree behaviour) persisted to
│                    localStorage
├── tree/            Tree state + per-vault tree appearance theming
├── util/            id helpers, vault appearance lookup
├── utils/           time formatting, daily-note display in Danish,
│                    drag-and-drop helpers
├── App.tsx          Route table
├── main.tsx         Entry point
├── global.d.ts      Ambient TS declarations
├── index.css        CSS reset
└── styles.css       App styles (4k+ lines, single source of truth)
```

(The split between `util/` and `utils/` is historical accident, not
intent. Future cleanup: pick one and merge.)

## Notes for editing the code

- All API calls go through `src/api/client.ts`. Don't call `fetch()`
  directly elsewhere — the client wraps CSRF, 401 handling, and
  error parsing.
- DTOs in `src/api/types.ts` are hand-maintained mirrors of the C#
  records in `NoteControl.Shared`. Property names are camelCase to
  match the server's JSON casing (System.Text.Json default).
- The TipTap markdown extension config lives in
  `src/markdown/markdownExtension.ts`. Keep loaders and savers using
  the same options so round-trip stays byte-stable.
- Slash-menu commands are configured in `src/editor/slashMenuItems.ts`
  and rendered by `SlashMenuExtension.ts` + `SlashMenuList.tsx`.
- Daily-note Danish display lives in `src/utils/dailyNoteDisplay.ts`.
- Code block syntax highlighting uses lowlight; ST keywords are
  registered via `src/editor/structuredText.ts`.
