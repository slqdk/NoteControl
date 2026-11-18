import { Link, useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { TopBar } from '../components/TopBar';
import { AdminUsers } from '../components/admin/AdminUsers';
import { AdminVaults } from '../components/admin/AdminVaults';
import '../components/admin/admin.css';

const TABS = [
  { key: 'users', label: 'Users' },
  { key: 'vaults', label: 'Vaults' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

/**
 * /admin — server administration in the web UI (replaces the
 * Windows tray's admin windows on the Linux deployment).
 *
 * Tabs live in the query string (?tab=vaults) so a reload or a
 * bookmark lands on the same tab. Admin-only: the server enforces
 * it on every endpoint; this page just shows a message to others.
 */
export function AdminPage() {
  const { state } = useAuth();
  const [params, setParams] = useSearchParams();

  const requested = params.get('tab');
  const tab: TabKey = TABS.some((t) => t.key === requested) ? (requested as TabKey) : 'users';
  const isAdmin = state.status === 'authenticated' && state.user.role === 'admin';

  return (
    <>
      <TopBar currentUserId={null} canEdit={true} />
      <main className="nc-page nc-admin-page">
        <div className="nc-admin-header">
          <h1 className="nc-page-title">Administration</h1>
          <Link to="/vaults" className="nc-admin-back">
            ← Back to notes
          </Link>
        </div>

        {!isAdmin ? (
          <p className="nc-empty">This page is for administrators.</p>
        ) : (
          <>
            <nav className="nc-admin-tabs" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`nc-admin-tab${tab === t.key ? ' nc-admin-tab-active' : ''}`}
                  onClick={() => setParams({ tab: t.key }, { replace: true })}
                >
                  {t.label}
                </button>
              ))}
            </nav>
            {tab === 'users' && <AdminUsers />}
            {tab === 'vaults' && <AdminVaults />}
          </>
        )}
      </main>
    </>
  );
}
