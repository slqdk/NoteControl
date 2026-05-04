import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { AccountMenu } from './AccountMenu';
import { SearchBox } from './SearchBox';

interface TopBarProps {
  /** The currently-open vault, if any. */
  vault?: { id: string; name: string };
  /**
   * Slot rendered between the search box and the Templates link.
   * Used by VaultLayout to inject the rail toggle buttons (📁 ℹ️).
   * Optional — pages without a vault layout (vault list) leave it
   * unset.
   */
  rightExtras?: ReactNode;
  /**
   * Ship 70: rightmost slot, rendered AFTER the account menu. Used
   * by VaultLayout to inject the settings cog. Kept separate from
   * rightExtras because the account menu sits between the two —
   * one-slot rendering would force every caller to assemble
   * ToggleRailButtons + AccountMenu + SettingsButton in the right
   * order, which is needless ceremony for a layout that only has
   * two real arrangements.
   */
  rightSettings?: ReactNode;
}

/**
 * Top navigation bar.
 *
 * Layout right-to-left:
 *   ⚙️ (rightSettings)  [Account ▾]  [Templates]  [📁 ℹ️] (rightExtras)
 *
 * The account menu is the only piece that's always present (when
 * logged in); everything else is optional and depends on whether a
 * vault is open. Pre-Ship-70, username + sign-out were inline
 * pieces of the topbar; now they're folded into AccountMenu and
 * the settings cog has been pulled out to sit beside it.
 */
export function TopBar({ vault, rightExtras, rightSettings }: TopBarProps) {
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
            naturally next to the account menu.
          */
          <Link
            to={`/vaults/${vault.id}/templates`}
            className="nc-topbar-link"
            title="Manage templates"
          >
            Templates
          </Link>
        )}
        <AccountMenu />
        {rightSettings}
      </div>
    </header>
  );
}
