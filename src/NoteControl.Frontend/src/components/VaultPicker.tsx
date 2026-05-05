import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { VaultDto } from '../api/types';
import { VaultAvatar } from './VaultAvatar';
import { VaultAppearancePopover } from './VaultAppearancePopover';

/**
 * Ship 91 — Topbar vault picker (desktop only).
 *
 * Replaces the pre-Ship-91 "/Beckhoff" plain text in the topbar's
 * left side. Two modes based on vault count:
 *
 *   ≤3 vaults: render every vault as an inline pill (avatar + name).
 *              The active one is visually highlighted; clicking any
 *              pill navigates to that vault.
 *
 *   >3 vaults: render only the active vault as a pill with a small
 *              ▾ caret; clicking opens a dropdown listing all vaults
 *              with their avatars + names. The active row is marked.
 *
 * Right-clicking the active vault's pill opens the appearance
 * popover (icon + colour pickers). Right-click is the desktop-only
 * affordance — mobile bypasses this whole component (TopBar's
 * existing brand+vault-name span renders instead, and Ship 87
 * collapses the topbar accordingly).
 *
 * "Last opened" memory: the picker writes localStorage
 * `nc:last-vault-id` whenever a vault is selected. The
 * VaultListPage reads it on mount to redirect away from the
 * landing page. The picker itself doesn't read it — the active
 * vault comes from the parent (VaultLayout already has the
 * resolved vault).
 */
export const LAST_VAULT_LS_KEY = 'nc:last-vault-id';

export interface VaultPickerProps {
  /** All vaults the user can see (already filtered by the API). */
  vaults: VaultDto[];
  /** The currently-open vault, or null on the landing page. */
  active: VaultDto | null;
  /**
   * Threshold above which the picker switches to dropdown mode.
   * Default 3 per the user's spec; exposed for future tuning.
   */
  inlineThreshold?: number;
  /**
   * Callback when a vault's appearance has been changed via the
   * right-click popover. The parent should splice the updated DTO
   * into its in-memory `vaults` list so other UI sees the change
   * without a refetch.
   */
  onVaultUpdated?: (updated: VaultDto) => void;
}

export function VaultPicker({
  vaults,
  active,
  inlineThreshold = 3,
  onVaultUpdated,
}: VaultPickerProps) {
  // Whether the dropdown (>3-vaults mode) is currently open.
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Right-click appearance popover state. We track which vault was
  // right-clicked + the cursor coordinates so the popover anchors
  // there. Only the ACTIVE vault (the one currently open) can be
  // customised — right-clicking a non-active pill navigates as
  // normal would.
  const [appearancePopover, setAppearancePopover] = useState<
    { vault: VaultDto; x: number; y: number } | null
  >(null);

  // Persist the active vault as "last opened" so the landing page
  // can redirect there next session. Only writes when active flips
  // — re-renders without an active change don't churn localStorage.
  useEffect(() => {
    if (active) {
      try {
        localStorage.setItem(LAST_VAULT_LS_KEY, active.id);
      } catch {
        // Ignore quota / disabled-storage errors silently. The
        // picker still works; it just won't remember across
        // sessions for this user. Not worth surfacing to the UI.
      }
    }
  }, [active]);

  // Outside-click + Escape close for the dropdown. Same pattern as
  // AccountMenu / SearchBox / TopBar Widgets+ (Ship 85).
  useEffect(() => {
    if (!dropdownOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setDropdownOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [dropdownOpen]);

  // Right-click handler. Only fires the appearance popover when the
  // RIGHT-clicked vault is the ACTIVE one — for other vaults we let
  // the browser's native context menu through (boring but harmless).
  function handleContextMenu(e: React.MouseEvent, vault: VaultDto) {
    if (active && vault.id === active.id) {
      e.preventDefault();
      setAppearancePopover({ vault, x: e.clientX, y: e.clientY });
    }
  }

  // ---------- Render ----------

  // Empty state: no vaults yet. The TopBar renders our brand link
  // separately so we don't need to handle "no vaults" specially —
  // just render nothing.
  if (vaults.length === 0) return null;

  // Helpers shared between both modes.
  const renderPillAvatar = (v: VaultDto, isActive: boolean) => (
    <Link
      to={`/vaults/${v.id}`}
      className={
        'nc-vault-pill'
        + (isActive ? ' nc-vault-pill-active' : '')
      }
      onContextMenu={(e) => handleContextMenu(e, v)}
      title={v.name}
    >
      <VaultAvatar vault={v} size={22} />
      <span className="nc-vault-pill-label">{v.name}</span>
    </Link>
  );

  // Inline mode: ≤3 vaults shown side by side.
  if (vaults.length <= inlineThreshold) {
    return (
      <div className="nc-vault-picker nc-vault-picker-inline">
        {vaults.map((v) => renderPillAvatar(v, active?.id === v.id))}
        {appearancePopover && (
          <VaultAppearancePopover
            vault={appearancePopover.vault}
            x={appearancePopover.x}
            y={appearancePopover.y}
            onClose={() => setAppearancePopover(null)}
            onUpdated={(updated) => {
              onVaultUpdated?.(updated);
              setAppearancePopover(null);
            }}
          />
        )}
      </div>
    );
  }

  // Dropdown mode: >3 vaults. Render the active one (or "Pick…" if
  // none active) as a button that opens a dropdown listing all
  // vaults.
  return (
    <div className="nc-vault-picker nc-vault-picker-dropdown" ref={dropdownRef}>
      <button
        type="button"
        className="nc-vault-pill nc-vault-pill-active"
        onClick={() => setDropdownOpen((v) => !v)}
        onContextMenu={(e) => active && handleContextMenu(e, active)}
        aria-haspopup="menu"
        aria-expanded={dropdownOpen}
        title={active ? active.name : 'Pick a vault'}
      >
        {active
          ? <VaultAvatar vault={active} size={22} />
          : <span className="nc-vault-pill-placeholder-avatar">📁</span>}
        <span className="nc-vault-pill-label">
          {active ? active.name : 'Pick a vault'}
        </span>
        <span className="nc-vault-pill-caret" aria-hidden="true">▾</span>
      </button>
      {dropdownOpen && (
        <div className="nc-vault-picker-menu" role="menu">
          {vaults.map((v) => (
            <Link
              key={v.id}
              to={`/vaults/${v.id}`}
              className={
                'nc-vault-picker-menu-item'
                + (active?.id === v.id ? ' nc-vault-picker-menu-item-active' : '')
              }
              role="menuitem"
              onClick={() => setDropdownOpen(false)}
              onContextMenu={(e) => handleContextMenu(e, v)}
            >
              <VaultAvatar vault={v} size={22} />
              <span className="nc-vault-picker-menu-name">{v.name}</span>
              {/* path shown muted on the right so the user can
                  distinguish vaults with the same display name (e.g.
                  Personal under different users in admin mode). */}
              <span className="nc-vault-picker-menu-path">{v.path}</span>
            </Link>
          ))}
        </div>
      )}
      {appearancePopover && (
        <VaultAppearancePopover
          vault={appearancePopover.vault}
          x={appearancePopover.x}
          y={appearancePopover.y}
          onClose={() => setAppearancePopover(null)}
          onUpdated={(updated) => {
            onVaultUpdated?.(updated);
            setAppearancePopover(null);
          }}
        />
      )}
    </div>
  );
}
