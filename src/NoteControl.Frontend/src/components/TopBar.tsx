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
   * Kept as the loose `{id,name}` shape (not a full VaultDto) for
   * back-compat with callers that don't have the full DTO on hand.
   * The picker uses this only to highlight which inline pill is
   * "active"; appearance fields come from the matching entry inside
   * `vaults`.
   */
  vault?: { id: string; name: string };
  /**
   * Full list of vaults the caller can see, used by the desktop
   * VaultPicker. When undefined or empty, the topbar's left side
   * falls back to a plain link to the active vault (if any), so the
   * user still has somewhere to click to navigate. VaultLayout
   * passes this in once its own vaultsApi.list() resolves.
   */
  vaults?: VaultDto[];
  /**
   * Callback when an entry in `vaults` was updated via the
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
   * Rightmost slot, rendered AFTER the account menu. Used by
   * VaultLayout to inject the settings cog. Kept separate from
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
 * The Widgets+ button only renders when the current route is a
 * vault's startpage. It hosts the "add a block" dropdown that
 * earlier lived as a floating + button on the canvas itself —
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
 *
 * Brand text: the previous "NoteControl /" lead-in on the left has
 * been removed app-wide. The topbar's left column now holds either
 * the desktop vault picker (when a `vaults` list has been loaded)
 * or, on mobile / pre-load, just the active vault's name as a
 * direct link. On routes with no vault context (the vault list
 * page's empty state, mid-load shells), the left column is empty —
 * the search box stays centred via the topbar's grid.
 */
export function TopBar({
  vault, vaults, onVaultUpdated, rightExtras, rightSettings,
}: TopBarProps) {
  const location = useLocation();
  // Drives the Widgets+ button gate. The button is meant for the
  // desktop startpage; on mobile we redirect away from /startpage
  // entirely (StartpagePage), so the button has nothing to add to.
  // Hiding it here is defensive — the redirect should already mean
  // isOnStartpage is false on mobile, but a brief mid-navigation
  // render or a multi-tab flip could otherwise show the button
  // momentarily.
  const isMobile = useIsMobile();

  // Match `/vaults/:id/startpage` or `/vaults/:id/dashboards/:dashboardId`
  // (with optional trailing slash). Path-string check rather than
  // route-match because TopBar isn't inside the route tree where
  // matchPath is convenient, and the path shape is stable
  // (DashboardPage owns it, with StartpagePage as the legacy
  // single-canvas redirect). The regex tolerates both forms so the
  // Widgets+ button stays visible while the user is on any dashboard,
  // not just the post-redirect one.
  const isOnStartpage =
    /\/vaults\/[^/]+\/(startpage|dashboards\/[^/]+)\/?$/.test(
      location.pathname,
    );

  // Widgets+ dropdown state.
  const [widgetsOpen, setWidgetsOpen] = useState(false);
  // When the user picks "Motion" we swap the dropdown contents in
  // place to show the per-mode entries with a "← Back" row at the
  // top — same pattern as the slash menu's Templates submenu, so the
  // dropdown UI stays consistent. Null = main menu.
  const [widgetsSubmenu, setWidgetsSubmenu] = useState<'motion' | null>(null);
  const widgetsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!widgetsOpen) return;
    // pointerdown not mousedown — see AccountMenu / ContextMenu /
    // SearchBox for the rationale (iOS Safari + tap-then-scroll).
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
  // next page until they clicked elsewhere. Also reset the submenu so
  // the next open starts at the main menu.
  useEffect(() => {
    if (!isOnStartpage && widgetsOpen) setWidgetsOpen(false);
  }, [isOnStartpage, widgetsOpen]);

  // Reset submenu whenever the dropdown closes — next open starts
  // at the main menu, never mid-submenu (would surprise the user).
  useEffect(() => {
    if (!widgetsOpen) setWidgetsSubmenu(null);
  }, [widgetsOpen]);

  // Helper that fires the add-block event and closes the dropdown.
  // The event name is namespaced (nc:...) so we don't collide with
  // anything else that might bubble up. Kinds are extended for the
  // motion calculator submenu — see DashboardPage's bridge for the
  // full list.
  function emitAddBlock(
    kind: 'rss' | 'task' | 'links' | 'motion-a' | 'motion-b' | 'motion-c',
  ) {
    window.dispatchEvent(
      new CustomEvent('nc:add-startpage-block', { detail: { kind } }),
    );
    setWidgetsOpen(false);
  }

  return (
    <header className="nc-topbar">
      <div className="nc-topbar-left">
        {/*
          Left side has two layouts:

          Desktop with vaults loaded: the VaultPicker. It renders
          every vault as a pill (in original order) and folds
          whichever pills don't fit in the available width into a
          dropdown. See VaultPicker.tsx for the overflow algorithm.

          Mobile, OR desktop before `vaults` has loaded (e.g. the
          bare /vaults page that hasn't fetched the list yet): a
          plain link to the active vault, if any. The brand text
          that used to lead this row has been removed app-wide —
          when there is no active vault and no list, the left
          column simply renders nothing and the search box stays
          centred via the topbar's three-column grid.
        */}
        {!isMobile && vaults && vaults.length > 0 ? (
          <VaultPicker
            vaults={vaults}
            active={
              vault
                ? vaults.find((v) => v.id === vault.id) ?? null
                : null
            }
            onVaultUpdated={onVaultUpdated}
          />
        ) : (
          vault && (
            <Link to={`/vaults/${vault.id}`} className="nc-vault-name">
              {vault.name}
            </Link>
          )
        )}
      </div>
      <div className="nc-topbar-center">
        {vault && <SearchBox vaultId={vault.id} placeholder="Search this vault…" />}
      </div>
      <div className="nc-topbar-right">
        {rightExtras}

        {isOnStartpage && !isMobile && (
          /*
            Widgets+ dropdown. Mirrors AccountMenu's click-outside /
            Escape pattern. We use the same .nc-account-popover
            styles so all topbar dropdowns feel like one menu
            system, customised slightly via .nc-widgets-* for the
            icon glyphs in front of each item.
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
                {widgetsSubmenu === null && (
                  <>
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
                    <button
                      type="button"
                      className="nc-account-item"
                      role="menuitem"
                      onClick={() => setWidgetsSubmenu('motion')}
                      aria-haspopup="menu"
                    >
                      {/* Submenu — clicking opens the per-mode list in
                          the same dropdown rather than navigating to a
                          new page. The chevron mirrors the slash-menu
                          convention for "this opens a submenu". */}
                      📈 Motion ▸
                    </button>
                  </>
                )}
                {widgetsSubmenu === 'motion' && (
                  <>
                    <button
                      type="button"
                      className="nc-account-item"
                      role="menuitem"
                      onClick={() => setWidgetsSubmenu(null)}
                    >
                      ← Back
                    </button>
                    <button
                      type="button"
                      className="nc-account-item"
                      role="menuitem"
                      onClick={() => emitAddBlock('motion-a')}
                      title="You know travel time + distance. Solve for velocity, acc, jerk."
                    >
                      Calculator A · Time → Dynamics
                    </button>
                    <button
                      type="button"
                      className="nc-account-item"
                      role="menuitem"
                      onClick={() => emitAddBlock('motion-b')}
                      title="You know acc/dec/jerk + max velocity. Solve for motion timings."
                    >
                      Calculator B · Dynamics → Time
                    </button>
                    <button
                      type="button"
                      className="nc-account-item"
                      role="menuitem"
                      onClick={() => emitAddBlock('motion-c')}
                      title="You know dynamics + distance + total time. Solve for peak velocity."
                    >
                      Calculator C · Dynamics + Limits → Velocity
                    </button>
                  </>
                )}
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
