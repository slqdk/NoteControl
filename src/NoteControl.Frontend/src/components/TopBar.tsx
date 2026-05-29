import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { AccountMenu } from './AccountMenu';
import { SearchBox } from './SearchBox';
import { VaultPicker } from './VaultPicker';
import { useIsMobile } from '../hooks/useIsMobile';
import type { VaultDto } from '../api/types';

// Ship C: NoteControl brand logo for the top-left of the topbar.
// Vite resolves SVG imports to a hashed URL at build time (no
// JSX-component magic) — `logoUrl` is a plain string we can drop
// into <img src>. The asset itself is the "brand" variant from
// the logo asset set: the full bracket-framed [NC] folder, blue.
//
// Hidden on mobile viewports via CSS to keep the cramped mobile
// topbar usable; the browser-tab favicon serves as the mobile
// brand anchor instead.
import logoUrl from '../assets/notecontrol-logo.svg';

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
   * Full list of vaults the caller can see, used by the
   * VaultPicker. When undefined or empty, the topbar's left side
   * falls back to a plain link to the active vault (if any), so the
   * user still has somewhere to click to navigate. VaultLayout
   * passes this in once its own vaultsApi.list() resolves.
   */
  vaults?: VaultDto[];
  /**
   * Signed-in user's id. Forwarded to VaultPicker so it can split
   * the list into personal (owned by this user) and shared (owned
   * by someone else) for the picker's two-zone layout. Null while
   * auth is still loading — the picker treats null as "everything
   * personal" until the real id resolves.
   */
  currentUserId: string | null;
  /**
   * Whether the active vault's role allows write operations
   * (editor or owner). Drives two pieces of UI here:
   *   - The Templates link is hidden for viewers — TemplatesPage
   *     is editing-focused (Save / Delete / Create) and 403s on
   *     every write a viewer could attempt. Hiding the link keeps
   *     the topbar honest. (Viewers can still reach the page by
   *     typing the URL; the page itself doesn't break, just every
   *     mutation fails.)
   *   - Forwarded to VaultPicker as canChangeAppearance so the
   *     right-click-to-rebrand popover doesn't open for viewers
   *     (PUT /appearance is editor-only — the popover would lead
   *     to a 403 on save). Defaults to true when no vault is in
   *     scope (the picker won't open the popover without an active
   *     vault anyway).
   */
  canEdit: boolean;
  /**
   * Callback when an entry in `vaults` was updated via the
   * appearance popover. The parent should splice the new DTO into
   * its in-memory list so re-renders pick up the new icon/colour
   * everywhere (tree row, picker, dropdown). Mobile never invokes
   * this (no appearance popover on mobile) but the prop is still
   * passed through unconditionally — VaultPicker itself decides
   * whether to use it.
   */
  onVaultUpdated?: (updated: VaultDto) => void;
  /**
   * Slot rendered between the search box and the Templates link.
   * Used by VaultLayout to inject the properties-panel toggle (ℹ️).
   * The folder-tree toggle that used to live here has been removed
   * — the tree is now always visible on desktop. Optional — pages
   * without a vault layout (vault list) leave it unset.
   */
  rightExtras?: ReactNode;
  /**
   * Slot for the settings cog, rendered BEFORE the account menu so
   * that the account menu sits at the far-right edge of the topbar.
   * Kept separate from rightExtras because Templates lives between
   * the rail-toggle slot and this one.
   *
   * Earlier (Ship 70) the cog sat AFTER the account menu; that
   * order was reverted so the account menu — the only piece tied to
   * the signed-in user — anchors the topbar's right edge.
   */
  rightSettings?: ReactNode;
}

/**
 * Top navigation bar.
 *
 * Layout right-to-left:
 *   [Account ▾]  ⚙️ (rightSettings)  [Templates]  [Widgets+ ▾]?  [ℹ️] (rightExtras)
 *
 * The account menu anchors the right edge — it's the only piece
 * tied to the signed-in user, so it stays in a stable, predictable
 * spot. The settings cog sits to its left.
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
 * been removed app-wide. The topbar's left column now holds the
 * VaultPicker whenever a `vaults` list has been loaded, in either
 * its desktop (inline pills + overflow) or mobile (single trigger
 * + dropdown) variant. Pre-load (or routes with no vault context)
 * the column is empty — the search box stays centred via the
 * topbar's grid.
 */
export function TopBar({
  vault, vaults, currentUserId, canEdit, onVaultUpdated, rightExtras, rightSettings,
}: TopBarProps) {
  const location = useLocation();
  // Drives the Widgets+ button gate. The button is meant for the
  // desktop startpage; on mobile we redirect away from /startpage
  // entirely (StartpagePage), so the button has nothing to add to.
  // Hiding it here is defensive — the redirect should already mean
  // isOnStartpage is false on mobile, but a brief mid-navigation
  // render or a multi-tab flip could otherwise show the button
  // momentarily.
  //
  // Same flag also drives the VaultPicker's `mobile` prop so the
  // picker renders as a single-trigger dropdown on narrow viewports
  // instead of the inline-pills overflow layout (which doesn't
  // physically fit alongside the search box on a phone).
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
    kind: 'rss' | 'task' | 'links' | 'motion-a' | 'motion-b' | 'motion-c' | 'motion-d',
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
          Ship C: brand logo. Always present (no click handler, no
          link wrapper — purely visual brand anchor). Sits to the
          left of the vault picker on desktop; hidden on mobile via
          CSS to leave room for the picker + search box. The width
          is fixed in CSS so the topbar's three-column grid stays
          predictable even before the vault list loads.
        */}
        <span className="nc-brand" aria-hidden="true">
          <img src={logoUrl} alt="" />
        </span>
        {/*
          Left side. Renders the VaultPicker whenever the parent has
          loaded a `vaults` list — desktop and mobile both, just in
          different visual variants:

            Desktop: inline pills with width-measured overflow.
            Mobile:  single trigger pill + dropdown of all vaults.

          Pre-load (e.g. the bare /vaults page that hasn't fetched
          the list yet, or /vaults/:id mid-fetch) we fall back to a
          plain link to the active vault, if any. The brand text
          that used to lead this row has been removed app-wide —
          when there is no active vault and no list, the left
          column simply renders nothing and the search box stays
          centred via the topbar's three-column grid.
        */}
        {vaults && vaults.length > 0 ? (
          <VaultPicker
            vaults={vaults}
            active={
              vault
                ? vaults.find((v) => v.id === vault.id) ?? null
                : null
            }
            currentUserId={currentUserId}
            canChangeAppearance={canEdit}
            onVaultUpdated={onVaultUpdated}
            mobile={isMobile}
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
        {vault && (
          <SearchBox
            vaultId={vault.id}
            vaults={vaults}
            placeholder={
              vaults && vaults.length > 1 ? 'Search notes…' : 'Search this vault…'
            }
          />
        )}
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
                    <button
                      type="button"
                      className="nc-account-item"
                      role="menuitem"
                      onClick={() => emitAddBlock('motion-d')}
                      title="Same as A, plus a motor + gear panel that converts speed/torque/current using the gear ratio, feed constant, and torque constant."
                    >
                      Calculator D · Motor / Gear + Time → Dynamics
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {vault && canEdit && (
          /*
            Templates link surfaces the per-vault template manager.
            Only visible when a vault is in scope — without one, the
            link has no destination. Hidden for viewers: the page is
            editing-focused (Save / Delete / Create) and every write
            attempt would 403; a viewer with read intent can still
            type the URL to browse templates, but the topbar
            shouldn't advertise a workflow that doesn't work for
            them.
          */
          <Link
            to={`/vaults/${vault.id}/templates`}
            className="nc-topbar-link"
            title="Manage templates"
          >
            Templates
          </Link>
        )}
        {rightSettings}
        <AccountMenu />
      </div>
    </header>
  );
}
