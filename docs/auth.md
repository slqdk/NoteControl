# Authentication & sessions

How NoteControl decides who's calling and what they're allowed to
do. Read this when you're touching login, sessions, CSRF,
passwords, or the bootstrap admin.

## Identities

Two roles exist: `admin` and `user`. There is no role hierarchy
beyond those two — admin can do everything a user can, plus the
admin-only operations.

A `User` row is the identity. Each row has:

- `Username` (unique, case-sensitive, used for login)
- `Email` (currently free-text — not validated for delivery)
- `Role` (`admin` or `user`)
- `Status` (`active` or `disabled`)
- A password hash (Argon2id)

There is no email-based verification or recovery flow. Password
resets happen via the tray's Users window (admin-driven), or
self-service via the web UI account menu (changes the calling
user's own password).

## Login flow (web)

1. Browser POSTs `username` + `password` to `/api/auth/login`.
2. Server checks the password against the stored Argon2id hash.
3. On success, server creates a `Session` row (random opaque
   session id, expiry, IP, user agent) and writes two cookies:
   - `nc_sid` (HttpOnly, Path=/) — opaque session id, sent on
     every request, looked up server-side.
   - `nc_csrf` (NOT HttpOnly, Path=/) — CSRF token. JS reads it
     and echoes it in the `X-CSRF-Token` header on non-GET
     requests.
4. Subsequent requests carry both. The session middleware
   resolves `nc_sid` to a `User` and a `Session`. The CSRF
   middleware checks the header equals the cookie on
   non-idempotent methods.

Cookie names + header name + timeouts are configurable via
`Auth.*` in `appsettings.json` (or via the tray's
Authentication tab).

Sessions have **two timeouts**:

- **Idle timeout** (default 720 minutes / 12 hours): a session
  expires this long after its last use.
- **Absolute timeout** (default 10080 minutes / 7 days): a
  session expires this long after creation regardless of use.

Both are configurable. Whichever expires first wins.

## Login flow (tray)

The tray prefers a non-interactive flow. On every admin-menu
click that needs the server, the tray runs:

1. If the in-memory client thinks it's already logged in, skip
   to step 5.
2. Probe `/health` over HTTP to verify the server is reachable.
   If not, surface "server doesn't appear to be running" and
   abort.
3. Try **local-token auto-login**: read `{DataRoot}/.server/tray.token`,
   POST it to `/api/auth/local-token`. The server accepts only
   loopback callers, validates the token (constant-time
   comparison), and returns a normal admin session in the same
   cookie shape as a password login. The token rotates on every
   server restart.
4. If local-token fails (file missing, ACL denies read, server
   restarted, server down), fall back to the interactive
   `LoginWindow` and POST `/api/auth/login` like the web client.
5. Open the requested admin window with the now-authenticated
   `IAdminClient`.

The tray refuses non-admin sessions: if step 3 or 4 returns a
user whose role isn't `admin`, the tray immediately calls
`/api/auth/logout` and treats it as a failure.

Tray sessions persist for the lifetime of the tray process. Quit
Tray + relaunch = fresh login. The session cookie itself outlives
the tray (it's stored in an in-memory `CookieContainer`, not on
disk), so a tray crash invalidates the session implicitly.

## Local tray token

A pre-shared secret used only on loopback to skip the password
prompt for the tray. Rules:

- Generated **fresh on every server start** (32 random bytes,
  base64url). The previous token becomes invalid the moment the
  server restarts.
- Written to `{DataRoot}/.server/tray.token` (UTF-8, no BOM, no
  trailing newline beyond what the OS adds).
- File permissions on Windows: SYSTEM (full control),
  Administrators (full control), and the server's process user
  (read). Inheritance is stripped so unrelated users on the box
  can't read the file.
- Server-side: `/api/auth/local-token` rejects any non-loopback
  caller with HTTP 403. Loopback callers send the token in the
  request body; on match the server issues a session for the
  configured `BootstrapAdmin` user (or the first active admin if
  the bootstrap user is gone).

## CSRF

Every state-changing request (POST/PUT/DELETE/PATCH) must carry
both:

- The `nc_sid` session cookie.
- The `X-CSRF-Token` header equal to the value of the `nc_csrf`
  cookie.

GET and HEAD are exempt. Endpoints that mutate via GET would be a
bug; none currently do.

The double-submit pattern means an attacker cross-origin can send
the cookie (browser does it automatically) but can't read the
cookie value (different origin) and so can't replicate it in the
header.

The cookie pair is replaced on every login and cleared on
logout.

## Password rules

Configured under `Auth.*`:

- `MinimumPasswordLength` (default 12).
- `CheckPasswordAgainstHibp` (default true): if enabled, on
  password set/change the server hashes the password with
  SHA-1, sends the first 5 hex chars of the hash to the
  haveibeenpwned k-anonymity API, and rejects matches. If the
  HIBP service is unreachable the check is **skipped silently**
  rather than blocking the user — a deliberate choice so an
  outage at HIBP doesn't lock people out of password changes.
- Hashing is Argon2id with parameters chosen at hash time and
  embedded in the encoded hash. Verification reads the
  parameters from the stored hash, so old hashes still verify
  after parameter upgrades.

## Rate limiting and lockout

Login is throttled in two dimensions:

- **Per-IP**: max `LoginAttemptsPerIpPerMinute` failed attempts
  per IP per rolling minute (default 5). Excess attempts return
  HTTP 429.
- **Per-account**: max `LoginAttemptsPerAccountPerHour` failures
  per username per hour (default 10). Hitting the limit "locks"
  the account for `AccountLockoutMinutes` (default 30 minutes).
  Subsequent login attempts during the lockout return HTTP 423
  `LoginLockedOut` regardless of password correctness.

Successful logins reset the per-account counter for that user.
Lockouts are time-based; there is no admin "unlock now" button.

## Bootstrap admin

The first time the server starts against an empty database it
creates a single admin user from `Auth:BootstrapAdmin`:

- `Username` (default `admin`)
- `Email` (default `admin@localhost`)
- `Password`: if non-empty in config, that password is used as
  the initial password (and then ideally changed). If empty, the
  server prints a one-time random password to the server log
  (Information level, message: "Bootstrap admin password
  generated") and never logs it again.

This is a one-shot operation. On subsequent starts, the
bootstrap section is checked but the admin row is left alone —
it can be renamed, disabled, or deleted, and the bootstrap path
won't recreate it. If you delete the last admin, you've locked
yourself out and the recovery is to stop the service, edit the
SQLite file by hand, and restart.

## Sessions UI

The tray's Users window lists each user's active sessions
(IP, user agent, created, last used, expiry). An admin can
revoke any session — that immediately invalidates the cookie on
the next request from that session.

A user can list and revoke their own sessions via the web UI's
account menu. Self-revocation of the current session is
equivalent to logout.

## Audit events

Auth-related events the server writes to the audit log:

- `AdminBootstrap` — bootstrap admin user created
- `LoginSuccess` — successful login (password or local-token)
- `LoginFailure` — failed login (wrong password, locked-out,
  no-such-user — the failure detail is in the JSON details
  payload)
- `LoginLockedOut` — login attempt after the account hit the
  lockout threshold
- `Logout` — explicit logout via `/api/auth/logout`
- `PasswordChanged` — password set or changed
- `SessionRevoked` — session deleted before its natural
  expiry, by admin or by the session owner

Audit events go to the `AuditEvents` table in the server DB.
Admins can query them via the tray's Logs window or via
`/api/admin/audit`.
