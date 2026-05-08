import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { VaultDto } from '../api/types';
import { VaultAvatar } from './VaultAvatar';
import { VaultAppearancePopover } from './VaultAppearancePopover';

/**
 * Topbar vault picker (desktop only).
 *
 * Replaces the pre-Ship-91 "/Beckhoff" plain text in the topbar's
 * left side. The picker renders vaults as inline pills (avatar +
 * name) and folds whichever pills don't fit into a dropdown.
 *
 * Overflow model (replaces the older ≤3 / >3 fixed threshold):
 *   - Render every pill that fits in the available container
 *     width, in the original `vaults` order.
 *   - When some pills don't fit, append a "+N ▾" trigger that
 *     opens a dropdown listing only the overflow vaults (not the
 *     ones already visible — no duplicates).
 *   - The active vault is treated like any other pill for layout
 *     purposes; if there isn't room, it ends up in the dropdown.
 *     We highlight the trigger with the active styling so the user
 *     can still see "your current vault is in here."
 *
 * Width measurement uses an off-screen mirror div containing every
 * pill at its natural width. We read offsetWidth on layout, compute
 * how many pills fit (accounting for the trigger button when there
 * is overflow), and re-render. A ResizeObserver on the visible
 * container re-runs the calculation on viewport / app-frame width
 * changes.
 *
 * Right-clicking the active vault's pill (whether visible or in
 * the dropdown row) opens the appearance popover (icon + colour
 * pickers). Mobile bypasses this whole component (TopBar gates on
 * !isMobile and the desktop CSS hides .nc-vault-picker for safety).
 *
 * "Last opened" memory: the picker writes localStorage
 * `nc:last-vault-id` whenever the active vault flips. The
 * VaultListPage reads it on mount to redirect to the previous
 * vault; the picker itself doesn't read it.
 */
export const LAST_VAULT_LS_KEY = 'nc:last-vault-id';

/**
 * Width budget the algorithm reserves for the "+N ▾" trigger when
 * there is overflow. Slightly larger than typical (~52-60px) so
 * we don't end up in a thrashy "fits with trigger / doesn't fit
 * without it" oscillation when the user resizes by one pixel at a
 * time. Errs on the side of one fewer visible pill.
 */
const TRIGGER_RESERVE_PX = 72;

/**
 * Inter-pill gap that matches the CSS gap on .nc-vault-picker.
 * Kept in sync manually — if you change the CSS gap, change this.
 * The mirror's getBoundingClientRect-based measurement already
 * handles per-pill margin/padding; this constant is only the
 * inter-element spacing the parent flex container adds.
 */
const PILL_GAP_PX = 4;

export interface VaultPickerProps {
  /** All vaults the user can see (already filtered by the API). */
  vaults: VaultDto[];
  /** The currently-open vault, or null on the landing page. */
  active: VaultDto | null;
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
  onVaultUpdated,
}: VaultPickerProps) {
  // How many leading pills currently fit in the visible row. The
  // remainder go into the overflow dropdown.
  //
  // Initial value is 0 (pessimistic): on first paint we render
  // nothing visible, then the layout effect immediately measures
  // and corrects to the real count before the browser paints.
  // Starting at vaults.length would briefly let all pills overflow
  // their container on narrow budgets — a one-frame flash where
  // labels visually escape past the search box. Pessimistic-zero
  // means the first paint shows just the "+N ▾" trigger and any
  // pills that fit appear on the very next render. That's a less
  // disturbing transition than an overflow flash.
  const [fitCount, setFitCount] = useState<number>(0);

  // Whether the overflow dropdown is currently open.
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Right-click appearance popover state. We track which vault was
  // right-clicked + the cursor coordinates so the popover anchors
  // there. Only the ACTIVE vault can be customised — right-clicking
  // a non-active pill does nothing (browser context menu shows).
  const [appearancePopover, setAppearancePopover] = useState<
    { vault: VaultDto; x: number; y: number } | null
  >(null);

  // The visible container we're measuring against. The mirror sits
  // inside it (absolutely positioned + visually hidden) so the
  // width calculation is against exactly the same flex context the
  // visible pills will be laid out in.
  const containerRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

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

  // Width-based overflow recompute. Runs:
  //   - On mount (initial measure).
  //   - When the vault list changes (IDs or names — both affect
  //     the rendered widths).
  //   - When the container's clientWidth changes (window resize,
  //     app-frame width preference change, sibling layout shifts).
  //
  // We measure the mirror's child elements rather than the visible
  // pills because the visible row may already be cropped by a stale
  // fitCount — measuring it would feedback-loop into "fits because
  // it's already collapsed". The mirror always renders all pills.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const mirror = mirrorRef.current;
    if (!container || !mirror) return;

    function recompute() {
      if (!container || !mirror) return;
      const budget = container.clientWidth;
      // Measure each mirror pill at its natural width.
      const pills = Array.from(mirror.children) as HTMLElement[];
      if (pills.length === 0) {
        setFitCount(0);
        return;
      }

      // Greedy fit: walk pills left-to-right, accumulate widths +
      // gaps. For every pill that isn't the LAST in the list,
      // reserve the trigger width too — because if THIS pill is
      // the cutoff we'll need a trigger to follow it. The last pill
      // never needs a trigger (nothing left to overflow).
      let acc = 0;
      let fit = 0;
      for (let i = 0; i < pills.length; i++) {
        const isLast = i === pills.length - 1;
        const pillW = pills[i].offsetWidth;
        const gap = i > 0 ? PILL_GAP_PX : 0;
        const overhead = isLast ? 0 : TRIGGER_RESERVE_PX + PILL_GAP_PX;
        if (acc + gap + pillW + overhead <= budget) {
          acc += gap + pillW;
          fit = i + 1;
        } else {
          break;
        }
      }
      setFitCount(fit);
    }

    // First pass: synchronous so the browser doesn't paint with
    // a stale fitCount on initial mount.
    recompute();

    // Watch for container resize. ResizeObserver fires async via a
    // microtask, which is fine for ongoing updates.
    const ro = new ResizeObserver(() => {
      // Wrap in rAF to avoid the "ResizeObserver loop completed"
      // warning some browsers emit when state updates inside the
      // RO callback synchronously trigger another resize.
      requestAnimationFrame(recompute);
    });
    ro.observe(container);
    return () => {
      ro.disconnect();
    };
    // We re-run when the vaults list identity changes — covers add,
    // remove, rename, and appearance changes (all of which can
    // shift pill widths). active.id is also a dependency because
    // the active styling can change a pill's width slightly (border
    // doesn't, but a future style change might).
  }, [vaults, active?.id]);

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

  if (vaults.length === 0) return null;

  // Helper: render one pill (used by both the visible row, the
  // mirror, and the dropdown rows aren't pills — they have a
  // separate row markup, see below).
  function renderPill(v: VaultDto, isActive: boolean, key?: string) {
    return (
      <Link
        key={key ?? v.id}
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
  }

  // Sliced view based on the most recent measurement. fitCount is
  // clamped against vaults.length for safety against stale updates.
  const safeFit = Math.max(0, Math.min(fitCount, vaults.length));
  const visiblePills = vaults.slice(0, safeFit);
  const overflowPills = vaults.slice(safeFit);
  const hasOverflow = overflowPills.length > 0;
  // Whether the active vault is in the overflow set — drives the
  // trigger button's "active" highlight so the user can see at a
  // glance that their current vault is hidden in the dropdown.
  const activeIsHidden =
    !!active
    && hasOverflow
    && overflowPills.some((v) => v.id === active.id);

  return (
    <div
      className="nc-vault-picker"
      ref={containerRef}
    >
      {visiblePills.map((v) =>
        renderPill(v, !!active && active.id === v.id),
      )}

      {hasOverflow && (
        <div className="nc-vault-picker-overflow" ref={dropdownRef}>
          <button
            type="button"
            className={
              'nc-vault-pill nc-vault-overflow-trigger'
              + (activeIsHidden ? ' nc-vault-pill-active' : '')
            }
            onClick={() => setDropdownOpen((v) => !v)}
            onContextMenu={(e) => {
              // If the active vault is in the overflow set, allow
              // right-click on the trigger to open the appearance
              // popover for it — same UX as if its pill were
              // visible. For non-active overflow we do nothing (the
              // user has to open the dropdown and right-click the
              // specific row).
              if (activeIsHidden && active) {
                handleContextMenu(e, active);
              }
            }}
            aria-haspopup="menu"
            aria-expanded={dropdownOpen}
            title={
              activeIsHidden && active
                ? `${active.name} (${overflowPills.length} more)`
                : `${overflowPills.length} more vault${overflowPills.length === 1 ? '' : 's'}`
            }
          >
            {/*
              We show the count rather than the active vault's
              avatar even when active is hidden. Showing the avatar
              would help recognition but mismatches the "+N more"
              convention — and the surrounding pills already give
              the user context. If recognition becomes a complaint,
              we can swap to a "[avatar] +N" hybrid later.
            */}
            <span className="nc-vault-overflow-count">
              +{overflowPills.length}
            </span>
            <span className="nc-vault-pill-caret" aria-hidden="true">▾</span>
          </button>
          {dropdownOpen && (
            <div className="nc-vault-picker-menu" role="menu">
              {overflowPills.map((v) => (
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
                  {/* path shown muted so the user can distinguish
                      vaults with the same display name (e.g.
                      "Personal" under different users in admin
                      mode). */}
                  <span className="nc-vault-picker-menu-path">{v.path}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {/*
        Off-screen measurement mirror. Holds every vault's pill at
        natural width. Visually hidden from the user (pointer-events
        none, aria-hidden, transform off-canvas) but laid out by the
        browser so offsetWidth reads correctly. We position it
        absolutely so it doesn't push the visible pills around.

        Why not just measure the visible pills: the visible row may
        already be cropped to fitCount — measuring it would feedback
        into "fits because it's already collapsed." The mirror is
        the source of truth for natural pill widths.
      */}
      <div
        ref={mirrorRef}
        className="nc-vault-picker-mirror"
        aria-hidden="true"
      >
        {vaults.map((v) =>
          renderPill(v, !!active && active.id === v.id, `mirror-${v.id}`),
        )}
      </div>

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
