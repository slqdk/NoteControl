import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import { DebugLogViewer } from './DebugLogViewer';
import {
  entryCount,
  isRecording,
  start as startRecording,
  stop as stopRecording,
  subscribe as subscribeRecorder,
} from '../util/debugRecorder';

/**
 * Ship 70: account button in the topbar. Replaces the previous
 * inline username + "Sign out" pair with a single 👤 button that
 * opens a dropdown showing:
 *   - the username (small, muted)
 *   - a sign-out button
 *   - (admin only) debug recording controls + log viewer launcher
 *
 * Designed to grow: the user mentioned more items will land here
 * later (profile / preferences / theme / shortcuts). The render
 * below uses a list of menu rows so adding entries is just adding
 * another <button> or <Link>. No need to refactor when the menu
 * graduates to 5 items.
 *
 * Open/close UX matches the existing settings cog popover:
 *   - click the button to toggle
 *   - click anywhere outside to close
 *   - press Escape to close
 *   - signing out closes implicitly (auth state changes; the
 *     whole topbar re-renders without a vault context anyway)
 *
 * Styling reuses .nc-toggle (the button) + .nc-variant-picker
 * (positioning anchor) + a new .nc-account-popover (the
 * dropdown panel). Sharing the toggle button class keeps the
 * three icons (📁 ℹ️ 👤) visually identical.
 *
 * --- Debug recording (admin only) ---
 *
 * Admins see two extra rows: a toggle for "Debug recording" and a
 * launcher for the log viewer. The toggle flips the recorder
 * on/off; the launcher opens a full-screen overlay listing the
 * captured entries with a Copy-as-JSON button. See
 * util/debugRecorder.ts for what gets captured and why.
 *
 * Gating is by client-side role check — admin users get the
 * affordance, others don't. Anyone with devtools can flip the
 * recorder via window.__ncDebug.start() regardless; that's fine
 * because the recorder doesn't grant any new access (it just
 * captures traffic the user could already see in DevTools'
 * Network tab).
 */
export function AccountMenu() {
  const { state, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Re-render when the recorder's state or buffer changes, so the
  // "Debug recording: ON/OFF" row and the entry-count label stay
  // in sync. Cheap: the recorder fires notify() at human-click
  // cadence, not per-frame.
  const [, force] = useState(0);
  useEffect(() => subscribeRecorder(() => force((n) => n + 1)), []);

  // Click-outside + Escape close. Mirrors the cog popover's
  // approach: one effect that owns the listeners, attached only
  // while open.
  //
  // Ship 85: pointerdown instead of mousedown. iOS Safari doesn't
  // always fire mousedown on tap-then-scroll outside the menu,
  // which left the menu stuck open until a real tap landed.
  // pointerdown fires on touchstart unconditionally, so the
  // menu dismisses as soon as the user starts a gesture outside.
  // Desktop mouse behaviour is unchanged — pointerdown also fires
  // for mouse left-button down.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (state.status !== 'authenticated') return null;

  const username = state.user.username;
  const isAdmin = state.user.role === 'admin';
  const recording = isRecording();
  const count = entryCount();

  return (
    <>
      <div ref={wrapRef} className="nc-variant-picker">
        <button
          type="button"
          className="nc-toggle"
          onClick={() => setOpen((v) => !v)}
          title={`Account (${username})`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Account menu"
        >
          👤
        </button>
        {open && (
          <div className="nc-account-popover" role="menu">
            <div className="nc-account-username" title={username}>
              {username}
            </div>

            {isAdmin && (
              <>
                <button
                  type="button"
                  className="nc-account-item"
                  role="menuitem"
                  onClick={() => {
                    if (recording) {
                      stopRecording();
                    } else {
                      startRecording();
                    }
                    // Don't close the menu — the user often wants
                    // to flip Start, then immediately go View log.
                  }}
                  title={
                    recording
                      ? 'Stop capturing frontend events'
                      : 'Start capturing frontend events for diagnostics'
                  }
                >
                  Debug recording: {recording ? 'ON' : 'OFF'}
                </button>
                <button
                  type="button"
                  className="nc-account-item"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    setViewerOpen(true);
                  }}
                >
                  View log ({count})
                </button>
                <div className="nc-account-divider" aria-hidden="true" />
              </>
            )}

            <button
              type="button"
              className="nc-account-item"
              role="menuitem"
              onClick={() => {
                // Close eagerly so the popover doesn't briefly
                // hover over the redirected login screen. logout()
                // is fire-and-forget; auth state propagation handles
                // the rest of the UI.
                setOpen(false);
                void logout();
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </div>
      {viewerOpen && <DebugLogViewer onClose={() => setViewerOpen(false)} />}
    </>
  );
}
