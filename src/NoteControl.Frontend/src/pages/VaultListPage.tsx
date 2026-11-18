import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';

import { ApiError, vaultsApi } from '../api/client';
import type { VaultDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { TopBar } from '../components/TopBar';
import { LAST_VAULT_LS_KEY } from '../components/VaultPicker';
import '../components/admin/admin.css';

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
 *   4. If the user has no vaults, render an empty state with a
 *      "create your first vault" form (any user may create their own
 *      personal vault at users/<username>/<name>) and, for admins, a
 *      link to Administration.
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

    // Resolve which role the caller has on the picked vault — drives
    // the landing-page choice. The dashboards section is hidden
    // entirely for viewer-role users (per the role-gating ship), so
    // auto-landing them on /startpage (which then redirects to the
    // first dashboard) would surface a section they shouldn't see.
    // StartpagePage itself also has a viewer→folder redirect as
    // defence-in-depth; this check just saves one redirect hop on the
    // way in.
    const pickedVault = vaults.find((v) => v.id === targetId) ?? null;
    const pickedIsViewer = pickedVault?.myRole === 'viewer';

    // Editors / owners: land on the per-vault startpage (which
    // redirects to the first dashboard). On mobile the startpage
    // page itself redirects to the folder root via Ship 86's mobile
    // guard, so phones land on a usable navigation view anyway.
    //
    // Viewers: land directly on the folder root. No dashboards UI
    // to land on.
    const target = pickedIsViewer
      ? `/vaults/${targetId}`
      : `/vaults/${targetId}/startpage`;
    return <Navigate to={target} replace />;
  }

  // ---- fallback render: no vaults, error, or still loading ----
  return (
    <>
      {/* No vault is in scope on this fallback render (we're either
          loading the list, the list is empty, or an error happened
          before redirect could fire), so currentUserId doesn't need
          to be resolved for picker grouping — the picker won't even
          render without a `vaults` list. We pass null and canEdit
          true (the safe default that matches VaultLayout's optimistic
          stance); without an active vault the role gate is moot
          anyway. The Templates link inside TopBar is wrapped in
          `vault && canEdit && …`, so no vault means no link
          regardless of canEdit. */}
      <TopBar currentUserId={null} canEdit={true} />
      <main className="nc-page">
        <h1 className="nc-page-title">Your vaults</h1>

        {error && <div className="nc-form-error">{error}</div>}

        {vaults === null && !error && <p className="nc-empty">Loading…</p>}

        {vaults !== null && vaults.length === 0 && (
          <FirstVault onCreated={(v) => setVaults([v])} />
        )}
      </main>
    </>
  );
}

/**
 * Empty state: create a personal vault. Also points users at the
 * one-line reason they might not see existing vaults (nobody has
 * shared one with them) and admins at Administration.
 */
function FirstVault({ onCreated }: { onCreated: (v: VaultDto) => void }) {
  const { state } = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.status !== 'authenticated') return null;
  const user = state.user;
  const trimmed = name.trim();
  const invalid = /[/\\]/.test(trimmed) || trimmed === '.' || trimmed === '..';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || invalid) return;
    setBusy(true);
    setError(null);
    try {
      const v = await vaultsApi.create({ path: `users/${user.username}/${trimmed}`, name: trimmed });
      // Setting the list makes the page redirect into the new vault.
      onCreated(v);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the vault.');
      setBusy(false);
    }
  };

  return (
    <>
      <p className="nc-empty">
        You don&apos;t have any vaults yet. Create a personal one below, or ask
        another user to share theirs with you.
        {user.role === 'admin' && (
          <>
            {' '}
            Users and shared vaults are managed under{' '}
            <Link to="/admin">Administration</Link>.
          </>
        )}
      </p>
      <form className="nc-vault-create" onSubmit={(e) => void submit(e)}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Vault name, e.g. Notes"
          aria-label="New vault name"
          autoFocus
        />
        <button type="submit" className="nc-btn nc-btn-primary" disabled={busy || !trimmed || invalid}>
          {busy ? 'Creating…' : 'Create vault'}
        </button>
      </form>
      {invalid && <div className="nc-form-error">{'The name cannot contain / or \\.'}</div>}
      {error && <div className="nc-form-error">{error}</div>}
    </>
  );
}
