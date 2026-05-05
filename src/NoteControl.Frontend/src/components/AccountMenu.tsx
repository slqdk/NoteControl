import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../auth/AuthContext';

/**
 * Ship 70: account button in the topbar. Replaces the previous
 * inline username + "Sign out" pair with a single 👤 button that
 * opens a dropdown showing:
 *   - the username (small, muted)
 *   - a sign-out button
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
 */
export function AccountMenu() {
  const { state, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

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

  const username = state.status === 'authenticated' ? state.user.username : '';

  // Hide the menu entirely when not authenticated. The TopBar
  // already only renders this in the logged-in shell, but we
  // still defend — auth-context flips can race the unmount.
  if (state.status !== 'authenticated') return null;

  return (
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
  );
}
