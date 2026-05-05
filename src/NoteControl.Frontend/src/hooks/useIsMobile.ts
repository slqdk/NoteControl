import { useEffect, useState } from 'react';

/**
 * Ship 81 — Mobile shell.
 *
 * Returns true when the viewport is at or below the mobile breakpoint
 * (≤768px wide). Updates live as the viewport changes — rotating a
 * tablet, dragging the window edge in DevTools' device toolbar, or
 * resizing a real browser window all flip the value.
 *
 * Why a hook and not a CSS-only media query: the layout needs to know
 * the viewport class at the JSX level, not just the CSS level. On
 * mobile we force the tree visible (regardless of the user's persisted
 * desktop preference) and hide the props panel entirely, which means
 * VaultLayout has to render different JSX, not just style it
 * differently. CSS alone can't conditionally render a component.
 *
 * Why 768px: standard mobile/tablet cutoff matching most CSS
 * frameworks (Tailwind's `md`, Bootstrap's `md` breakpoint). Captures
 * phones in landscape and 8" tablets in portrait while leaving 10"+
 * tablets and laptops on the desktop layout. Same value used by the
 * matching media query block in styles.css — keep them in sync.
 *
 * Why matchMedia and not innerWidth + resize: matchMedia fires only
 * when the boolean answer changes, not on every pixel of resize.
 * Cheaper, fewer renders, no debounce dance needed.
 *
 * SSR safety: guards against window being undefined (the codebase is
 * SPA-only so this shouldn't matter, but it's two lines of defence
 * for free if someone ever pre-renders).
 */
export const MOBILE_BREAKPOINT_PX = 768;

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`);
    // Initial sync in case the SSR-default differed from runtime —
    // belt-and-braces; setIsMobile is a no-op if the value matches.
    setIsMobile(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // Modern API. addListener is the deprecated path; not needed for
    // any browser this app supports (Chromium 78+, Firefox 78+).
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
