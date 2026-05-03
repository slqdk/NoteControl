import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { SearchBox } from './SearchBox';

interface TopBarProps {
  /** The currently-open vault, if any. */
  vault?: { id: string; name: string };
  /**
   * Slot rendered between the search box and the username. Used by
   * VaultLayout to inject the rail toggle buttons + variant picker.
   * Optional — pages without a vault layout (e.g. vault list) leave
   * it unset.
   */
  rightExtras?: ReactNode;
}

export function TopBar({ vault, rightExtras }: TopBarProps) {
  const { state, logout } = useAuth();
  const username = state.status === 'authenticated' ? state.user.username : '';

  return (
    <header className="nc-topbar">
      <div className="nc-topbar-left">
        <Link to="/vaults" className="nc-brand">
          NoteControl
        </Link>
        {vault && (
          <>
            <span className="nc-topbar-sep">/</span>
            <Link to={`/vaults/${vault.id}`} className="nc-vault-name">
              {vault.name}
            </Link>
          </>
        )}
      </div>
      <div className="nc-topbar-center">
        {vault && <SearchBox vaultId={vault.id} placeholder="Search this vault…" />}
      </div>
      <div className="nc-topbar-right">
        {rightExtras}
        {vault && (
          /*
            Templates link surfaces the per-vault template manager.
            Only visible when a vault is in scope — without one, the
            link has no destination. Plain link styling so it sits
            naturally next to the username + sign-out button.
          */
          <Link
            to={`/vaults/${vault.id}/templates`}
            className="nc-topbar-link"
            title="Manage templates"
          >
            Templates
          </Link>
        )}
        <span className="nc-username">{username}</span>
        <button
          type="button"
          className="nc-button-link"
          onClick={() => {
            void logout();
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
