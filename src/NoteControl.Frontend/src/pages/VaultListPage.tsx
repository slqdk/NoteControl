import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError, vaultsApi } from '../api/client';
import type { VaultDto } from '../api/types';
import { TopBar } from '../components/TopBar';

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

  const personal = vaults?.filter((v) => v.scope === 'personal') ?? [];
  const shared = vaults?.filter((v) => v.scope === 'shared') ?? [];

  // Ship 47: vault clicks land on the per-vault Startpage instead of
  // the folder-root listing. Done by linking to `/startpage` directly
  // here rather than redirecting the index route — the index route is
  // also reused for "click vault root in the tree", which should still
  // open the folder listing. So we change the entry-point only, not the
  // route's semantics.
  const targetFor = (vaultId: string) => `/vaults/${vaultId}/startpage`;

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

        {personal.length > 0 && (
          <section className="nc-section">
            <h2 className="nc-section-heading">Personal</h2>
            <ul className="nc-list">
              {personal.map((v) => (
                <li key={v.id}>
                  <Link to={targetFor(v.id)} className="nc-vault-link">
                    <span className="nc-vault-link-name">{v.name}</span>
                    <span className="nc-vault-link-path">{v.path}</span>
                    <span className="nc-vault-link-role">{v.role}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {shared.length > 0 && (
          <section className="nc-section">
            <h2 className="nc-section-heading">Shared</h2>
            <ul className="nc-list">
              {shared.map((v) => (
                <li key={v.id}>
                  <Link to={targetFor(v.id)} className="nc-vault-link">
                    <span className="nc-vault-link-name">{v.name}</span>
                    <span className="nc-vault-link-path">{v.path}</span>
                    <span className="nc-vault-link-role">{v.role}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}
