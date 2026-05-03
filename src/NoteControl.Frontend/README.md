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

Vite serves the app at `http://127.0.0.1:5173/` and proxies
`/health` and `/api/*` to the ASP.NET Core backend on port 8080. Start
the backend (F5 on `NoteControl.Server` in VS, or `dotnet run` in that
project directory) before visiting the dev URL.

## Production build

```powershell
npm run build
```

Output lands in `dist\`. The deployment step (added in a later
milestone) copies this folder into `NoteControl.Server\wwwroot\` so the
backend serves it as static files over HTTPS.

## Layout

```
src/
├── api/             API client + TS types mirroring server DTOs
├── auth/            AuthContext + RequireAuth route guard
├── components/      Editor, search box, top bar, note list, status indicator
├── markdown/        tiptap-markdown configuration
├── pages/           Login, vault list, folder, editor
├── utils/           Helpers (time formatting, etc.)
├── App.tsx          Route table
├── main.tsx         Entry point
├── index.css        CSS reset (from step 1)
└── styles.css       App styles
```

## What's implemented (as of step 6)

- Login / logout with CSRF double-submit and session cookies
- Vault picker (lists every vault the user has any role on)
- Folder view: subfolders, notes in folder, recently-updated across
  descendants
- TipTap rich-text editor with markdown round-trip
- 2-second auto-save with ETag concurrency and 412-conflict surfacing
- Live search (debounced) with snippet highlighting
- Light + dark via `prefers-color-scheme`

## Notes for editing the code

- All API calls go through `src/api/client.ts`. Don't call `fetch()`
  directly elsewhere — the client wraps CSRF, 401 handling, and error
  parsing.
- DTOs in `src/api/types.ts` are hand-maintained mirrors of the C#
  records in `NoteControl.Shared`. Property names are PascalCase to
  match the server's default JSON casing.
- The TipTap markdown extension config lives in
  `src/markdown/markdownExtension.ts`. Keep loaders and savers using
  the same options so round-trip stays byte-stable.
