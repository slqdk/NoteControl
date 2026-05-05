import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';

import { ApiError, vaultsApi } from '../api/client';
import type { VaultDto } from '../api/types';
import { TopBar } from '../components/TopBar';
import { LAST_VAULT_LS_KEY } from '../components/VaultPicker';

/**
 * /vaults — the landing page.
 *
 * Ship 91 changed this from a static landing page into an auto-redirect
 * to the user's last-opened vault. Behaviour:
 *
 *   1. Fetch the list of vaults the user can see.
 *   2. If localStorage `nc:last-vault-id` matches one of those vaults,
 *      redirect there immediately (target is the vault's startpage,
 *      same as Ship 47).
 *   3. Otherwise, if there's at least one vault, redirect to the
 *      first one alphabetically (the list is already path-sorted
 *      server-side).
 *   4. If the user has no vaults, render the original "no vaults"
 *      empty state with guidance to ask an administrator.
 *
 * Why this instead of the old visible list:
 *   - Single-user solo dev with 3 vaults: the list page was an
 *     unnecessary stop on every login.
 *   - The picker in the topbar (Ship 91) lets the user switch
 *     vaults from any page, so a dedicated "list page" no longer
 *     earns its place in the flow.
 *
 * If you ever want to admin-browse all vaults explicitly, expose a
 * separate route (e.g. `/vaults/all`) that doesn't redirect. The
 * pre-Ship-91 list-rendering JSX is in git history.
 */
export function VaultListPage() {
  const [vaults, setVaults] = useState<VaultDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await vaultsApi.list();
        if (!cancelled) setVaults(list);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : 'Could not load vaults.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Decide AFTER the fetch resolves; before that we render a loading
  // placeholder so the user isn't briefly left at a blank screen
  // while the network round-trip happens.
  if (vaults !== null && vaults.length > 0) {
    let targetId: string | null = null;

    // Prefer the last-opened vault if it still exists.
    try {
      const stored = localStorage.getItem(LAST_VAULT_LS_KEY);
      if (stored && vaults.some((v) => v.id === stored)) {
        targetId = stored;
      }
    } catch {
      // localStorage may be disabled (private mode etc); just skip.
    }

    // Fall back to first-alpha if no usable last-id. The server
    // already orders by Path so the first entry is a sensible default.
    if (!targetId) {
      targetId = vaults[0].id;
    }

    // Same target shape as Ship 47's vault-list links: land on the
    // per-vault startpage, not the folder root. On mobile the
    // startpage redirects to the folder root via Ship 86's mobile
    // guard, so phones land on a usable navigation view.
    return <Navigate to={`/vaults/${targetId}/startpage`} replace />;
  }

  // ---- fallback render: no vaults, error, or still loading ----
  return (
    <>
      <TopBar />
      <main className="nc-page">
        <h1 className="nc-page-title">Your vaults</h1>

        {error && <div className="nc-form-error">{error}</div>}

        {vaults === null && !error && <p className="nc-empty">Loading…</p>}

        {vaults !== null && vaults.length === 0 && (
          <p className="nc-empty">
            You don&apos;t have access to any vaults yet. Ask an administrator
            to create one for you.
          </p>
        )}
      </main>
    </>
  );
}
