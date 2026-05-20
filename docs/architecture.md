# Architecture

The 50,000-foot view of how NoteControl is put together. Read this
when you're crossing process boundaries or trying to figure out
where new code belongs.

## What runs where

NoteControl is **one Windows machine** running three or four
processes:

| Process | What it is | Lifetime |
|---|---|---|
| **Server** (`NoteControl.Server.exe`) | ASP.NET Core 8 + Kestrel + EF Core + SQLite + Serilog. Hosts the API and serves the built frontend bundle from `wwwroot/`. | Windows Service named `NoteControlServer` (auto-start, runs as `LocalSystem`). |
| **Tray** (`NoteControl.Tray.exe`) | WPF desktop app with a system-tray icon. Talks to the server over HTTP for admin operations. Manages the in-app updater and the lifecycle of the server service. | Per-user, launched at sign-in via `HKLM\…\Run\NoteControlTray`. Runs as the interactive user, not elevated. |
| **Caddy** (`caddy.exe`, optional) | Reverse proxy in front of Kestrel. Handles HTTPS termination via Let's Encrypt for any hostnames the user adds in the tray's HTTPS tab. | Windows Service named `caddy` (auto-start). Only present when the user has run `setup-https.ps1`. |
| **Frontend** | React + TypeScript SPA built with Vite. Bundled at build-time into `wwwroot/`; not a separate process at runtime. In dev, runs as `npm run dev` (Vite) on a separate port and proxies `/api`/`/health` to the server. | Dev only: separate `node` process via `npm run dev`. Production: just static files. |

There is intentionally **no separate database server**. SQLite
files live next to the data they belong to, which keeps the
deployment to "copy the install dir, copy the data folder."

## How they talk

```
   Browser  ────────► Caddy (443) ────► Kestrel (8080) ────► Server
   (any host)         optional                                process
                                                                │
   Tray ──────────────────────────► Kestrel (loopback) ────────┤
   (loopback only,                                              │
    same machine)                                               ▼
                                                          DataRoot/
```

- **Frontend → Server**: HTTPS (or HTTP if no Caddy) on whatever
  hostname/port the user configures. CORS is not used; the
  frontend is served by the same origin as the API.
- **Tray → Server**: HTTP on `127.0.0.1:<port>`, where `<port>`
  comes from `{DataRoot}/.server/server.url` (the tray reads this
  file at startup).
- **Caddy → Kestrel**: HTTP on loopback. Caddy adds TLS, public
  hostnames, optional rate-limiting. Kestrel still listens on
  loopback only when Caddy is present.
- **Tray → server.exe**: the tray uses `sc.exe` (or
  `Process.Start` for the fallback "run from anywhere" mode) to
  start/stop/restart the service. UAC prompts surface when the
  caller isn't elevated, with one auto-elevation re-entry path
  (the tray relaunches itself with `--service-action <verb>`).

## How a typical user request flows

User opens a vault in the browser:

1. Browser loads `https://gv38.slq.dk/vaults/<id>` (or whatever
   hostname they configured).
2. Caddy terminates TLS, forwards to Kestrel on loopback.
3. Kestrel routes via `Program.cs` middleware: HTTPS redirect
   (if configured), session cookie auth, CSRF check (for
   non-GET), endpoint authorization, then handler.
4. Handler queries SQLite (server DB for users/vaults/sessions,
   per-vault index DB for note metadata) and the file system
   (per-vault notes folder for note bodies).
5. JSON response goes back the same way.

Note bodies are **read straight off disk** on demand — no caching
layer. The per-vault `.notesapp/index.db` only contains metadata
(path, title, mtime, frontmatter, FTS-indexed body text); the
authoritative body is the markdown file itself.

## Security headers

The server emits a fixed set of security headers on every
response, set in middleware in `Program.cs`. These are part of
the process-boundary contract: the frontend assumes them and
will break in subtle ways if they're loosened or tightened.

The Content-Security-Policy is the load-bearing one. Current
directives, with rationale for the non-obvious ones:

- `default-src 'self'` — everything not otherwise specified
  comes from our own origin only.
- `script-src 'self'` — no inline scripts, no third-party JS.
  The frontend bundle is built by Vite ahead of time; the
  app does not need eval or remote script loads.
- `style-src 'self' 'unsafe-inline'` — `'unsafe-inline'`
  because React inline `style={…}` attributes and the
  TipTap-rendered editor surface emit inline `style`
  attributes that would otherwise be blocked. Stylesheets
  themselves are bundle files served from `/assets/`.
- `connect-src 'self' https://raw.githubusercontent.com
  https://api.github.com https://github.com` — `'self'`
  for our own API. The three GitHub hosts are widened in
  for the TcPOU-from-GitHub import (the editor's "import a
  PLC POU from a GitHub URL" path). Without explicit
  `connect-src`, the browser falls back to `default-src
  'self'` and blocks the fetch before the request ever
  leaves the browser. Tighter widening than the wildcard
  used in `img-src`: exact hosts only, no other URLs are
  allowed. If TcPOU import needs to support other code
  hosts later, either add them here or route through a
  server-side proxy and remove this widening.
- `img-src 'self' data: https:` — `'self'` covers note assets
  served via `/api/.../asset`. `data:` lets us inline SVG
  icons and the favicon-data path. `https:` was opened up
  for the link-preview feature (open-graph image URLs in
  third-party domains); the trade-off is documented in the
  link-preview code.
- `font-src 'self' data:` — `'self'` covers the bundled font
  files (Vite resolves them under `/assets/`). The `data:`
  source is required because the KaTeX stylesheet inlines
  ONE of its fonts (`KaTeX_Size3`, used for large delimiters
  like big parens and the bars of multi-line fractions) as a
  base64 `data:font/woff2;base64,…` URI in the CSS itself
  rather than as a separate file. Without `data:` here, the
  browser blocks that font load, falls back to the default
  math glyphs, and KaTeX layout collapses (fractions render
  on one line, large brackets render at character height).
  This is upstream KaTeX behaviour we don't control; we
  don't serve KaTeX from a CDN, so no further URL allowlist
  is needed.
- `media-src 'self'` — for inline video assets.
- `object-src 'none'` — no plugins.
- `frame-ancestors 'none'` — the app can't be iframed.
- `base-uri 'self'` — `<base href>` can't be redirected.

The server also sets `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, and
`X-Frame-Options: DENY` (redundant with `frame-ancestors` but
kept for older clients). HSTS is set when HTTPS is enabled.

If you find yourself wanting to loosen a directive, add a
comment in `Program.cs` next to the change explaining what
broke and what you're letting in. The CSP block is intentionally
verbose with inline comments so future readers know what each
allowance is paying for.

## Layering

The repo has four .NET projects:

```
NoteControl.Shared      DTOs only — types crossing the wire
       ▲
       │ project ref
       │
NoteControl.Server  ◄── NoteControl.Tray
       ▲
       │ project ref
       │
NoteControl.Tests   (xUnit, server-side tests only)
```

`NoteControl.Tray` references `NoteControl.Shared` for the API
DTO shapes — but **not** `NoteControl.Server`. The tray talks to
the server only over HTTP, never via in-process calls.

The frontend is a fifth top-level under `src/NoteControl.Frontend/`,
but it's not a .NET project — it's an npm/Vite project. VS shows
it as a Solution Folder.

## Deployment shapes

The same source code can run in three configurations:

1. **Dev (F5)**: Server + Tray launched from VS. Both run as the
   developer's user. The server uses `dev-data/` as its
   `DataRoot`. The frontend runs separately via `npm run dev`
   and proxies API calls to the server.
2. **Production, single machine**: The `installer/install.ps1`
   script lays down compiled binaries in `C:\Program Files\NoteControl`,
   creates the `NoteControlServer` Windows Service running as
   LocalSystem, registers the tray for autostart via `HKLM\Run`,
   and creates `DataRoot` at `C:\ProgramData\NoteControl\NotesData`.
3. **Production with HTTPS**: As above, plus the user runs
   `installer/setup-https.ps1` once to install Caddy as a service
   and adds public hostnames in the tray's HTTPS tab. Caddy
   reloads automatically when hostnames change.

The "self-hosted, single Windows machine, single end user" model
is the primary target. Multi-user (different humans, same server)
is supported but secondary; a second user just gets their own
`User` row and can be granted access to vaults via permissions.

## Two machines to keep distinct (development convention)

- **TwinCAT** = dev box. Source repo lives here. VS builds here.
- **lightserver** = production-like server box. Compiled binaries
  deployed here. The server service runs here.

This is just the user's setup, not a project requirement.
Everything works on a single machine too.
