import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { AccountMenu } from './AccountMenu';
import { SearchBox } from './SearchBox';
import { VaultPicker } from './VaultPicker';
import { useIsMobile } from '../hooks/useIsMobile';
import type { VaultDto } from '../api/types';

interface TopBarProps {
  /**
   * The currently-open vault, if any.
   *
   * Ship 91: kept as the loose `{id,name}` shape (not a full
   * VaultDto) for back-compat with callers that don't have the
   * full DTO on hand. The picker uses this only to highlight
   * which inline pill is "active"; appearance fields come from
   * the matching entry inside `vaults`.
   */
  vault?: { id: string; name: string };
  /**
   * Ship 91: full list of vaults the caller can see, used by the
   * desktop VaultPicker. When undefined or empty, we fall back to
   * the pre-Ship-91 brand+vault-name span (e.g. on the vault list
   * page where vaults haven't been loaded into a layout yet).
   * VaultLayout passes this in once its own vaultsApi.list() resolves.
   */
  vaults?: VaultDto[];
  /**
   * Ship 91: callback when an entry in `vaults` was updated via the
   * appearance popover. The parent should splice the new DTO into
   * its in-memory list so re-renders pick up the new icon/colour
   * everywhere (tree row, picker, dropdown).
   */
  onVaultUpdated?: (updated: VaultDto) => void;
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
   * rightExtras because the account menu sits between the two.
   */
  rightSettings?: ReactNode;
}

/**
 * Top navigation bar.
 *
 * Layout right-to-left:
 *   ⚙️ (rightSettings)  [Account ▾]  [Templates]  [Widgets+ ▾]?  [📁 ℹ️] (rightExtras)
 *
 * The Widgets+ button (Ship 78) only renders when the current route
 * is a vault's startpage. It hosts the "add a block" dropdown that
 * pre-Ship-78 lived as a floating + button on the canvas itself —
 * which got in the way of canvas content. The TopBar is the natural
 * home: always visible, never overlapping content. Clicking an item
 * fires a window event (nc:add-startpage-block) that StartpagePage
 * listens for. We use a global event rather than lifting state up
 * because the topbar and startpage are otherwise unrelated, and the
 * event API stays minimal (one event, three kinds).
 *
 * The account menu is the only piece that's always present (when
 * logged in); everything else is optional and depends on whether a
 * vault is open.
 */
export function TopBar({
  vault, vaults, onVaultUpdated, rightExtras, rightSettings,
}: TopBarProps) {
  const location = useLocation();
  // Ship 86: drives the Widgets+ button gate. The button is meant
  // for the desktop startpage; on mobile we redirect away from
  // /startpage entirely (StartpagePage), so the button has nothing
  // to add to. Hiding it here is defensive — the redirect should
  // already mean isOnStartpage is false on mobile, but a brief
  // mid-navigation render or a multi-tab flip could otherwise
  // show the button momentarily.
  const isMobile = useIsMobile();

  // Match `/vaults/:id/startpage` (with optional trailing slash). We
  // do this as a path-string check rather than a route-match because
  // TopBar isn't inside the route tree where matchPath is convenient,
  // and the path shape is stable (StartpagePage owns it). Using
  // endsWith handles both `/vaults/abc/startpage` and the trailing-
  // slash variant some routers normalize to.
  const isOnStartpage =
    /\/vaults\/[^/]+\/startpage\/?$/.test(location.pathname);

  // Widgets+ dropdown state.
  const [widgetsOpen, setWidgetsOpen] = useState(false);
  const widgetsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!widgetsOpen) return;
    // Ship 85: pointerdown not mousedown — see AccountMenu / ContextMenu
    // / SearchBox for the rationale (iOS Safari + tap-then-scroll).
    function onDocDown(e: PointerEvent) {
      if (
        widgetsRef.current &&
        !widgetsRef.current.contains(e.target as Node)
      ) {
        setWidgetsOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setWidgetsOpen(false);
    }
    document.addEventListener('pointerdown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [widgetsOpen]);

  // If the user navigates AWAY from the startpage while the dropdown
  // is open, close it. Otherwise it'd briefly hang in the air on the
  // next page until they clicked elsewhere.
  useEffect(() => {
    if (!isOnStartpage && widgetsOpen) setWidgetsOpen(false);
  }, [isOnStartpage, widgetsOpen]);

  // Helper that fires the add-block event and closes the dropdown.
  // The event name is namespaced (nc:...) so we don't collide with
  // anything else that might bubble up.
  function emitAddBlock(kind: 'rss' | 'task' | 'links') {
    window.dispatchEvent(
      new CustomEvent('nc:add-startpage-block', { detail: { kind } }),
    );
    setWidgetsOpen(false);
  }

  return (
    <header className="nc-topbar">
      <div className="nc-topbar-left">
        {/*
          Ship 91: the topbar's left side has two layouts.

          Desktop: a vault picker (inline pills if ≤3 vaults, dropdown
          otherwise) replacing the pre-Ship-91 "NoteControl / <vault>"
          plain text. The picker renders the brand-as-home-link
          implicitly via clicking on a non-active pill.

          Mobile: the original brand link is hidden (Ship 81 CSS) and
          the vault name is shown alongside the `/` separator in a
          small one-line topbar. The picker would crowd the topbar's
          one-line layout, so we keep the simple text on phones.

          When `vaults` isn't supplied (e.g. the bare /vaults page
          before VaultLayout loads), we render the legacy brand+
          vault-name on desktop too so the topbar still works.
        */}
        {!isMobile && vaults && vaults.length > 0 ? (
          <>
            <Link to="/vaults" className="nc-brand">
              NoteControl
            </Link>
            <span className="nc-topbar-sep">/</span>
            <VaultPicker
              vaults={vaults}
              active={
                vault
                  ? vaults.find((v) => v.id === vault.id) ?? null
                  : null
              }
              onVaultUpdated={onVaultUpdated}
            />
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
      <div className="nc-topbar-center">
        {vault && <SearchBox vaultId={vault.id} placeholder="Search this vault…" />}
      </div>
      <div className="nc-topbar-right">
        {rightExtras}

        {isOnStartpage && !isMobile && (
          /*
            Widgets+ dropdown. Mirrors AccountMenu's
            click-outside / Escape pattern. We use the same
            .nc-account-popover styles so all topbar dropdowns
            feel like one menu system, customised slightly via
            .nc-widgets-* for the icon glyphs in front of each
            item.
          */
          <div ref={widgetsRef} className="nc-variant-picker">
            <button
              type="button"
              className="nc-topbar-link"
              onClick={() => setWidgetsOpen((v) => !v)}
              title="Add a widget to the startpage"
              aria-haspopup="menu"
              aria-expanded={widgetsOpen}
            >
              Widgets+
            </button>
            {widgetsOpen && (
              <div className="nc-account-popover" role="menu">
                <button
                  type="button"
                  className="nc-account-item"
                  role="menuitem"
                  onClick={() => emitAddBlock('rss')}
                >
                  📡 RSS feed
                </button>
                <button
                  type="button"
                  className="nc-account-item"
                  role="menuitem"
                  onClick={() => emitAddBlock('task')}
                >
                  📌 Task area
                </button>
                <button
                  type="button"
                  className="nc-account-item"
                  role="menuitem"
                  onClick={() => emitAddBlock('links')}
                >
                  🔗 Links
                </button>
              </div>
            )}
          </div>
        )}

        {vault && (
          /*
            Templates link surfaces the per-vault template manager.
            Only visible when a vault is in scope — without one, the
            link has no destination.
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
