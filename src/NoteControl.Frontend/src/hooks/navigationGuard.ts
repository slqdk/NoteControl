/**
 * Single-slot global navigation guard.
 *
 * The editor page registers a guard while it's mounted. Any
 * component that would navigate the user away from the current
 * note (the tree, the breadcrumb, the vault picker, etc.) calls
 * `requestNavigation()` and awaits its verdict before doing the
 * actual `navigate(...)` or `<Link>` traversal.
 *
 * Why a global registry instead of a React Context?
 *
 * The places that need to consult the guard - TreeView, breadcrumb,
 * vault picker - are not necessarily descendants of EditorPage in
 * the React tree. The tree, in particular, lives inside VaultLayout
 * (which is the OUTLET PARENT of EditorPage), so the editor cannot
 * provide a context that the tree consumes. A module-level slot
 * sidesteps the tree-shape constraint cleanly.
 *
 * Why "single slot" (one guard at a time)?
 *
 * Only one editor is ever mounted at once in this app. The
 * templates page is its own route without the shared layout. There
 * is no scenario where two editors compete for the guard. The slot
 * is simpler than a stack, and a stack would need careful unmount-
 * ordering to avoid stale entries.
 *
 * Why not react-router's useBlocker?
 *
 * useBlocker requires a data router (createBrowserRouter +
 * RouterProvider). This app uses BrowserRouter, and migrating the
 * router setup just to gate navigation in one place wasn't worth
 * the blast radius. This module covers in-app clicks; browser
 * back/forward and tab close fall through to the existing
 * `beforeunload` handler in NoteEditor.
 */

export type NavigationGuardVerdict = 'allow' | 'block';

export type NavigationGuard = () => Promise<NavigationGuardVerdict>;

let activeGuard: NavigationGuard | null = null;

/**
 * Register a guard. Returns a deregister function. Calling the
 * deregister function clears the guard ONLY if it's still the
 * registered one - re-registration during a navigation race
 * shouldn't leave a stale clear behind.
 */
export function registerNavigationGuard(guard: NavigationGuard): () => void {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) {
      activeGuard = null;
    }
  };
}

/**
 * Consult the guard, if any. Resolves to:
 *   'allow' - no guard, or the guard said allow → caller should
 *             proceed with navigation.
 *   'block' - guard said block → caller should NOT navigate; the
 *             guard has already shown whatever UI it needed (e.g.
 *             a "save failed" modal) and the user is expected to
 *             interact with that.
 *
 * Catches errors from the guard and falls through to 'allow' so a
 * buggy guard can't permanently trap the user. The error is logged
 * to the console for diagnostic purposes.
 */
export async function requestNavigation(): Promise<NavigationGuardVerdict> {
  if (activeGuard === null) return 'allow';
  try {
    return await activeGuard();
  } catch (e) {
    // Don't trap the user just because the guard threw.
    // eslint-disable-next-line no-console
    console.error('Navigation guard threw:', e);
    return 'allow';
  }
}
