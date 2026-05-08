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
 */
export function StartpagePage() {
  const { vaultId } = useParams<{ vaultId: string }>();
  // Pull the outlet context so the type check doesn't drift if the
  // layout shape changes; the value isn't used in render directly.
  useOutletContext<VaultLayoutContext>();

  const [firstDashboardId, setFirstDashboardId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!vaultId) return;
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
  }, [vaultId]);

  if (!vaultId) return null;

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
  return (
    <div className="nc-page">
      <p className="nc-empty">Loading…</p>
    </div>
  );
}
