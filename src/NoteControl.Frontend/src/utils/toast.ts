/**
 * Imperative toast helper. One-line API:
 *
 *   showToast("Template saved");
 *
 * Renders a small fixed-position bubble at the bottom-right of the
 * viewport for ~3 seconds, then fades out. Clicking dismisses
 * immediately.
 *
 * Why imperative (not a React component)? Toasts are a stateless
 * side effect — there's no component tree concern, no shared
 * state, no need for context or providers. A plain function that
 * appends a div to body is the simplest thing that works and
 * avoids forcing every caller to wire up a provider in the React
 * tree. The single-toast-at-a-time policy (newer toast replaces
 * older) is also the simplest behaviour and matches the user's
 * expectation: a brief acknowledgement, not a notification feed.
 *
 * Style hooks live in styles.css under `.nc-toast` — the helper
 * only sets layout-affecting inline styles (position) so the rest
 * (typography, colour, shadow, animation) can be themed without
 * editing this file.
 */

let activeToast: HTMLDivElement | null = null;
let activeTimer: number | null = null;

export function showToast(message: string, durationMs = 3000): void {
  // Dismiss any existing toast before showing the new one.
  // Stacking multiple toasts would obscure the editor in cases
  // where actions fire close together (e.g. rapid save-selection
  // clicks); the user gets only the latest message.
  dismiss();

  const el = document.createElement('div');
  el.className = 'nc-toast';
  el.textContent = message;
  el.setAttribute('role', 'status');     // accessibility: announce
  el.setAttribute('aria-live', 'polite');
  // Inline positioning — the rest is in CSS.
  el.style.position = 'fixed';
  el.style.bottom = '24px';
  el.style.right = '24px';
  el.style.zIndex = '2000';

  el.addEventListener('click', dismiss);
  document.body.appendChild(el);
  activeToast = el;

  activeTimer = window.setTimeout(dismiss, durationMs);
}

function dismiss(): void {
  if (activeTimer !== null) {
    window.clearTimeout(activeTimer);
    activeTimer = null;
  }
  if (activeToast) {
    const toRemove = activeToast;
    activeToast = null;
    // Tiny fade-out delay if the CSS sets transition; otherwise
    // the element vanishes immediately. Either way, dismiss is
    // fast.
    toRemove.classList.add('nc-toast-leaving');
    window.setTimeout(() => {
      if (toRemove.parentNode) {
        toRemove.parentNode.removeChild(toRemove);
      }
    }, 150);
  }
}
