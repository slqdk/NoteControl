import { useEffect, useState } from 'react';
import { Navigate, useOutletContext, useParams } from 'react-router-dom';

import { ApiError, startpageApi } from '../api/client';
import type { VaultLayoutContext } from '../components/VaultLayout';

/**
 * Legacy /vaults/:vaultId/startpage route handler.
 *
 * Pre-dashboards this was the per-vault startpage canvas. Now the
 * canvas lives at /vaults/:vaultId/dashboards/:dashboardId — one
 * URL per dashboard. This component exists only to redirect the
 * old URL to the first dashboard, so existing links keep working:
 *
 *   - The tray's "open vault" menu hard-codes /startpage.
 *   - VaultListPage's auto-redirect lands users here after pick.
 *   - User bookmarks made before the multi-dashboard ship.
 *
 * We fetch the config once to discover the first dashboard's id,
 * then Navigate(replace) to its URL. Failure cases:
 *   - Load fails → render an error message; the user can pick a
 *     vault again from the tree.
 *   - Config has zero dashboards → shouldn't happen (the server
 *     seeds one), but if it does we render a fallback message
 *     rather than redirect-loop.
 *
 * This is a transient page — once everyone's bookmarks update,
 * the route can be removed. It's small enough to leave in for now.
 *
 * --------------------------------------------------------------
 * Viewer behaviour
 *
 * Viewers (canEdit=false on the active vault) get redirected to
 * the folder root instead of a dashboard. The dashboards UI is
 * hidden entirely for viewer-role users per the user's request —
 * no dashboards section in the tree, no Widgets+ button, no
 * canvas route. Auto-landing them on a dashboard would surface a
 * section they shouldn't see and would also trigger the spurious
 * 403 that was the original bug (PUT /startpage/config is editor-
 * only, and any block-edit save through useDashboards.patch-
 * Dashboard would fail). Folder root is the right landing surface
 * for read-only navigation.
 *
 * We wait for `vault` to resolve before deciding — otherwise a
 * brief null-vault window would route everyone to the dashboard
 * branch first and then redirect viewers a second time. That
 * extra hop is harmless but flashes the dashboards UI briefly on
 * slow loads.
 */
export function StartpagePage() {
  const { vaultId } = useParams<{ vaultId: string }>();
  const ctx = useOutletContext<VaultLayoutContext>();

  const [firstDashboardId, setFirstDashboardId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Whether the active vault is a viewer-role vault. While
  // ctx.vault is still null (mid-load), we hold off rendering
  // either redirect target and show a loading state instead — a
  // single render-cycle delay is cheaper than redirecting twice.
  const vault = ctx.vault;
  const isViewer = vault !== null && vault.myRole === 'viewer';
  const vaultRoleKnown = vault !== null;

  useEffect(() => {
    // Viewers never need the dashboards config — they don't land
    // on a dashboard. Skip the fetch for them. (The fetch is
    // viewer-allowed, so it wouldn't fail; it's just wasted bytes.)
    if (!vaultId || isViewer) return;
    let cancelled = false;
    setError(null);
    setFirstDashboardId(null);
    (async () => {
      try {
        const dto = await startpageApi.getConfig(vaultId);
        if (cancelled) return;
        const first = dto.dashboards[0];
        if (!first) {
          setError(
            'No dashboards found for this vault. Try reloading.',
          );
          return;
        }
        setFirstDashboardId(first.id);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof ApiError
              ? e.message
              : 'Could not load dashboards.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId, isViewer]);

  if (!vaultId) return null;

  // Viewer branch: redirect to the folder root. Replace so the
  // back button doesn't bring them back to this transient URL.
  if (vaultRoleKnown && isViewer) {
    return <Navigate to={`/vaults/${vaultId}`} replace />;
  }

  if (error) {
    return (
      <div className="nc-page">
        <div className="nc-form-error">{error}</div>
      </div>
    );
  }

  if (firstDashboardId) {
    return (
      <Navigate
        to={`/vaults/${vaultId}/dashboards/${firstDashboardId}`}
        replace
      />
    );
  }

  // Loading — same minimal shell as DashboardPage's loading state.
  // Covers both "waiting for vault metadata to know the role" and
  // "waiting for dashboards config (editor branch only)".
  return (
    <div className="nc-page">
      <p className="nc-empty">Loading…</p>
    </div>
  );
}
