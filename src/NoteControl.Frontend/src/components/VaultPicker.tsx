import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { VaultDto } from '../api/types';
import { VaultAvatar } from './VaultAvatar';
import { VaultAppearancePopover } from './VaultAppearancePopover';

/**
 * Topbar vault picker.
 *
 * Replaces the pre-Ship-91 "/Beckhoff" plain text in the topbar's
 * left side. The picker renders vaults as inline pills (avatar +
 * name) and folds whichever pills don't fit into a dropdown.
 *
 * Two render modes:
 *
 *   Desktop (default, mobile=false). Personal-then-shared layout:
 *   - The vault list is split by ownership relative to the signed-in
 *     user (props.currentUserId): vaults the user owns are PERSONAL;
 *     vaults shared with the user by someone else go to SHARED.
 *   - PERSONAL vaults render as inline pills with the existing
 *     width-measured overflow algorithm: every pill that fits the
 *     available container width is shown; the rest fold into a
 *     "+N ▾" dropdown trigger.
 *   - SHARED vaults (if any) collapse into a single trailing trigger
 *     at the right end of the personal row:
 *       - Active vault is personal (or none) → trigger is labelled
 *         "Shared ▾" with the count, in the default pill style.
 *       - Active vault is shared             → trigger shows that
 *         shared vault's avatar + name + ▾ in the active pill style,
 *         so the user always sees which vault they're in.
 *     Clicking it toggles a dropdown listing every shared vault.
 *   - Right-clicking the active vault's pill (whether visible, in
 *     the personal overflow dropdown, or in the shared dropdown)
 *     opens the appearance popover — but only when canChangeAppearance
 *     is true (owners + editors per the server's editor-or-above gate
 *     on PUT /appearance).
 *   - When the user has zero shared vaults the layout collapses to
 *     exactly what it rendered pre-this-ship (personal pills + the
 *     personal overflow trigger), so existing single-user setups see
 *     no visual change.
 *
 *   Mobile (mobile=true). Single-trigger dropdown:
 *   - One trigger button rendered: the active vault as a pill
 *     (avatar + name + caret). Tapping toggles a dropdown that
 *     lists all vaults, ordered personal-first then shared so the
 *     ownership grouping still reads top-down even without the
 *     desktop's spatial split. A small "Shared" subheading separates
 *     the two groups when both are non-empty.
 *   - No width-measurement / mirror / overflow algorithm — the
 *     trigger is always a single pill, and the dropdown always
 *     holds the full list.
 *   - No appearance popover — touch has no right-click, and
 *     vault customisation is a desktop workflow per frontend.md
 *     "desktop-first" stance.
 *   - When there's no active vault (mid-load) the trigger renders
 *     a generic "Vaults ▾" label.
 *
 * "Last opened" memory: the picker writes localStorage
 * `nc:last-vault-id` whenever the active vault flips. The
 * VaultListPage reads it on mount to redirect to the previous
 * vault; the picker itself doesn't read it. Same in both modes.
 */
export const LAST_VAULT_LS_KEY = 'nc:last-vault-id';

/**
 * Width budget the algorithm reserves for the personal "+N ▾"
 * trigger when there is overflow. Slightly larger than typical
 * (~52-60px) so we don't end up in a thrashy "fits with trigger /
 * doesn't fit without it" oscillation when the user resizes by one
 * pixel at a time. Errs on the side of one fewer visible pill.
 *
 * Desktop-only — the mobile branch doesn't measure.
 */
const TRIGGER_RESERVE_PX = 72;

/**
 * Width budget reserved for the Shared trigger (the right-end
 * pill) when it would be rendered. Wider than TRIGGER_RESERVE_PX
 * because in the active-shared case the trigger shows the active
 * shared vault's name + avatar, not just a small "+N" — the worst
 * case (longest name) needs more room. 200px covers most names
 * comfortably; longer names will text-truncate inside the pill.
 *
 * The shared dropdown is open-on-click, so a too-wide reserve only
 * costs a personal pill or two; a too-tight reserve clips the
 * active-shared label, which reads worse.
 */
const SHARED_TRIGGER_RESERVE_PX = 200;

/**
 * Inter-pill gap that matches the CSS gap on .nc-vault-picker.
 * Kept in sync manually — if you change the CSS gap, change this.
 * The mirror's getBoundingClientRect-based measurement already
 * handles per-pill margin/padding; this constant is only the
 * inter-element spacing the parent flex container adds.
 *
 * Desktop-only.
 */
const PILL_GAP_PX = 4;

export interface VaultPickerProps {
  /** All vaults the user can see (already filtered by the API). */
  vaults: VaultDto[];
  /** The currently-open vault, or null on the landing page. */
  active: VaultDto | null;
  /**
   * The signed-in user's id. Used to split vaults into PERSONAL
   * (owned by this user) vs SHARED (owned by someone else but
   * shared with the caller). Null while auth is still loading or
   * when the picker is mounted from a non-authenticated context;
   * in that case every vault is treated as personal — i.e. the
   * pre-Ship behaviour, all pills in one row with the existing
   * overflow algorithm. As soon as the real id resolves the picker
   * re-renders and the split takes effect.
   */
  currentUserId: string | null;
  /**
   * Whether the right-click "appearance popover" should be reachable
   * on the active vault. The server gates PUT /api/vaults/{id}/appearance
   * on editor-or-above; this prop should be wired to
   * `vault.myRole !== 'viewer'`. When false, right-click on the
   * active pill falls through to the browser's native context menu
   * (no popover renders), and the popover never appears even if
   * onVaultUpdated is wired.
   */
  canChangeAppearance: boolean;
  /**
   * Callback when a vault's appearance has been changed via the
   * right-click popover. The parent should splice the updated DTO
   * into its in-memory `vaults` list so other UI sees the change
   * without a refetch. Never invoked on mobile (no appearance
   * popover there) and never invoked when canChangeAppearance is
   * false (no popover renders).
   */
  onVaultUpdated?: (updated: VaultDto) => void;
  /**
   * When true, render the simplified single-trigger dropdown
   * variant suitable for narrow viewports. Defaults to false
   * (desktop inline-pills + overflow).
   */
  mobile?: boolean;
}

export function VaultPicker({
  vaults,
  active,
  currentUserId,
  canChangeAppearance,
  onVaultUpdated,
  mobile = false,
}: VaultPickerProps) {
  // Split vaults into personal (caller owns) vs shared (someone
  // else owns but caller has a permission row). When currentUserId
  // is null we fall back to "everything is personal" — preserves
  // the pre-Ship layout during the brief AuthContext mount window
  // and avoids a flicker as the picker re-splits on auth resolve.
  const { personalVaults, sharedVaults } = useMemo(() => {
    if (!currentUserId) {
      return { personalVaults: vaults, sharedVaults: [] as VaultDto[] };
    }
    const personal: VaultDto[] = [];
    const shared: VaultDto[] = [];
    for (const v of vaults) {
      if (v.ownerId === currentUserId) personal.push(v);
      else shared.push(v);
    }
    return { personalVaults: personal, sharedVaults: shared };
  }, [vaults, currentUserId]);

  const hasShared = sharedVaults.length > 0;
  const activeIsShared =
    !!active && sharedVaults.some((v) => v.id === active.id);

  // How many leading PERSONAL pills currently fit in the visible
  // row. The remainder go into the overflow dropdown. Desktop only
  // — the mobile branch ignores this value.
  //
  // Initial value is 0 (pessimistic): on first paint we render
  // nothing visible, then the layout effect immediately measures
  // and corrects to the real count before the browser paints.
  // Starting at vaults.length would briefly let all pills overflow
  // their container on narrow budgets — a one-frame flash where
  // labels visually escape past the search box. Pessimistic-zero
  // means the first paint shows just the overflow trigger and any
  // pills that fit appear on the very next render. That's a less
  // disturbing transition than an overflow flash.
  const [fitCount, setFitCount] = useState<number>(0);

  // Personal-overflow dropdown open/close. Distinct from the shared
  // dropdown (below) — they can open independently and the active
  // states don't interfere.
  const [personalDropdownOpen, setPersonalDropdownOpen] = useState(false);
  const personalDropdownRef = useRef<HTMLDivElement>(null);

  // Shared dropdown open/close.
  const [sharedDropdownOpen, setSharedDropdownOpen] = useState(false);
  const sharedDropdownRef = useRef<HTMLDivElement>(null);

  // Mobile dropdown (single trigger, all vaults). Reuses
  // sharedDropdownRef on mobile is wrong (different anchor); give
  // it its own ref so outside-click works whichever mode rendered.
  const mobileDropdownRef = useRef<HTMLDivElement>(null);
  const [mobileDropdownOpen, setMobileDropdownOpen] = useState(false);

  // Right-click appearance popover state (desktop only). We track
  // which vault was right-clicked + the cursor coordinates so the
  // popover anchors there. Only the ACTIVE vault can be customised
  // — right-clicking a non-active pill does nothing (browser
  // context menu shows). Mobile never sets this. Also gated by
  // canChangeAppearance: viewers see the native browser menu on
  // right-click instead.
  const [appearancePopover, setAppearancePopover] = useState<
    { vault: VaultDto; x: number; y: number } | null
  >(null);

  // Visible container + mirror for the desktop measurement loop.
  // Mobile attaches its own ref for outside-click via mobileDropdownRef
  // and ignores these.
  const containerRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  // Persist the active vault as "last opened" so the landing page
  // can redirect there next session. Only writes when active flips
  // — re-renders without an active change don't churn localStorage.
  // Same behaviour in both modes.
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

  // Outside-click + Escape close. One effect per open dropdown so
  // each gets its own ref check (clicking the shared trigger while
  // the personal dropdown is open should close only the personal
  // one, etc.). Same pattern as AccountMenu / SearchBox / TopBar
  // Widgets+ (Ship 85).
  useEffect(() => {
    if (!personalDropdownOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (
        personalDropdownRef.current &&
        !personalDropdownRef.current.contains(e.target as Node)
      ) {
        setPersonalDropdownOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPersonalDropdownOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [personalDropdownOpen]);

  useEffect(() => {
    if (!sharedDropdownOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (
        sharedDropdownRef.current &&
        !sharedDropdownRef.current.contains(e.target as Node)
      ) {
        setSharedDropdownOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSharedDropdownOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [sharedDropdownOpen]);

  useEffect(() => {
    if (!mobileDropdownOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (
        mobileDropdownRef.current &&
        !mobileDropdownRef.current.contains(e.target as Node)
      ) {
        setMobileDropdownOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMobileDropdownOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [mobileDropdownOpen]);

  // Width-based overflow recompute. DESKTOP ONLY — the mobile branch
  // doesn't measure or fold. Runs:
  //   - On mount (initial measure).
  //   - When the vault list changes (IDs or names — both affect
  //     the rendered widths).
  //   - When the container's clientWidth changes (window resize,
  //     app-frame width preference change, sibling layout shifts).
  //
  // We measure the mirror's child elements rather than the visible
  // pills because the visible row may already be cropped by a stale
  // fitCount — measuring it would feedback-loop into "fits because
  // it's already collapsed". The mirror always renders every PERSONAL
  // pill (the shared pills don't participate in the overflow
  // algorithm — they're behind the trailing trigger). The budget
  // also reserves space for the shared trigger when shared.length > 0,
  // so personal pills don't get pushed under the shared trigger.
  useLayoutEffect(() => {
    if (mobile) return;
    const container = containerRef.current;
    const mirror = mirrorRef.current;
    if (!container || !mirror) return;

    function recompute() {
      if (!container || !mirror) return;
      // Subtract the shared trigger's reserved width from the
      // available budget so personal pills don't crowd it.
      const sharedReserve = hasShared
        ? SHARED_TRIGGER_RESERVE_PX + PILL_GAP_PX
        : 0;
      const budget = container.clientWidth - sharedReserve;
      // Measure each mirror pill at its natural width.
      const pills = Array.from(mirror.children) as HTMLElement[];
      if (pills.length === 0) {
        setFitCount(0);
        return;
      }

      // Greedy fit: walk pills left-to-right, accumulate widths +
      // gaps. For every pill that isn't the LAST in the personal
      // list, reserve the personal-overflow trigger width too —
      // because if THIS pill is the cutoff we'll need a trigger
      // to follow it. The last pill never needs an overflow
      // trigger (nothing left to overflow within personal).
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
    // Re-run when the personal vault list identity changes, the
    // hasShared flag flips (controls the reserved budget), or the
    // active vault changes (the active pill may render slightly
    // differently due to the active border / weight).
  }, [personalVaults, active?.id, mobile, hasShared]);

  // Right-click handler. Only fires the appearance popover when the
  // RIGHT-clicked vault is the ACTIVE one AND the caller can change
  // appearance (editor or owner). For non-active vaults or viewers
  // we let the browser's native context menu through (boring but
  // harmless). Desktop only.
  function handleContextMenu(e: React.MouseEvent, vault: VaultDto) {
    if (!canChangeAppearance) return;
    if (active && vault.id === active.id) {
      e.preventDefault();
      setAppearancePopover({ vault, x: e.clientX, y: e.clientY });
    }
  }

  // ---------- Render ----------

  if (vaults.length === 0) return null;

  // -------------------- MOBILE branch --------------------
  //
  // Single trigger button (the active vault as a pill, with a
  // caret) that opens a dropdown listing every vault. No width
  // measurement, no mirror, no overflow algorithm — the narrow
  // viewport always wants the dropdown.
  //
  // The trigger is a <button> rather than a <Link>: we want the
  // tap to open the dropdown, not navigate. To switch to the
  // currently-active vault, the user picks it from the dropdown
  // (which closes and Link-navigates as expected — even when they
  // pick the same vault, that's a no-op navigation, harmless).
  //
  // Dropdown content: personal vaults first, then (if both groups
  // are non-empty) a small "Shared" subheading and the shared
  // vaults. The visual grouping replaces the desktop's spatial
  // split — same information, vertical layout.
  if (mobile) {
    const triggerLabel = active?.name ?? 'Vaults';
    return (
      <div
        className="nc-vault-picker nc-vault-picker-mobile"
        ref={mobileDropdownRef}
      >
        <button
          type="button"
          className={
            'nc-vault-pill nc-vault-mobile-trigger'
            + (active ? ' nc-vault-pill-active' : '')
          }
          onClick={() => setMobileDropdownOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={mobileDropdownOpen}
          title={
            active
              ? `${active.name} — tap to switch vault`
              : 'Pick a vault'
          }
        >
          {active && <VaultAvatar vault={active} size={22} />}
          <span className="nc-vault-pill-label">{triggerLabel}</span>
          <span className="nc-vault-pill-caret" aria-hidden="true">▾</span>
        </button>
        {mobileDropdownOpen && (
          <div className="nc-vault-picker-menu" role="menu">
            {personalVaults.map((v) => (
              <Link
                key={v.id}
                to={`/vaults/${v.id}`}
                className={
                  'nc-vault-picker-menu-item'
                  + (active?.id === v.id ? ' nc-vault-picker-menu-item-active' : '')
                }
                role="menuitem"
                onClick={() => setMobileDropdownOpen(false)}
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
            {hasShared && personalVaults.length > 0 && (
              /* Visual divider between the personal and shared
                 groups. Uses the menu-item base class for spacing
                 but is a non-interactive label. */
              <div
                className="nc-vault-picker-menu-heading"
                aria-hidden="true"
              >
                Shared
              </div>
            )}
            {sharedVaults.map((v) => (
              <Link
                key={v.id}
                to={`/vaults/${v.id}`}
                className={
                  'nc-vault-picker-menu-item'
                  + (active?.id === v.id ? ' nc-vault-picker-menu-item-active' : '')
                }
                role="menuitem"
                onClick={() => setMobileDropdownOpen(false)}
                title={`Shared by ${v.ownerUsername}`}
              >
                <VaultAvatar vault={v} size={22} />
                <span className="nc-vault-picker-menu-name">{v.name}</span>
                <span className="nc-vault-picker-menu-path">
                  by {v.ownerUsername}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  // -------------------- DESKTOP branch --------------------

  // Helper: render one pill. Used by both the visible row and the
  // measurement mirror. (Dropdown rows have different markup —
  // they're full-width menu items with path lines, not pills.)
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
  // clamped against personalVaults.length for safety against stale
  // updates.
  const safeFit = Math.max(0, Math.min(fitCount, personalVaults.length));
  const visiblePersonal = personalVaults.slice(0, safeFit);
  const overflowPersonal = personalVaults.slice(safeFit);
  const hasPersonalOverflow = overflowPersonal.length > 0;
  // Whether the active vault is in the personal overflow set —
  // drives the personal-overflow trigger button's "active"
  // highlight so the user can see at a glance that their current
  // vault is hidden in that dropdown. (The shared trigger has its
  // own active state, handled below.)
  const activeIsInPersonalOverflow =
    !!active
    && !activeIsShared
    && hasPersonalOverflow
    && overflowPersonal.some((v) => v.id === active.id);

  return (
    <div
      className="nc-vault-picker"
      ref={containerRef}
    >
      {visiblePersonal.map((v) =>
        renderPill(v, !!active && active.id === v.id),
      )}

      {hasPersonalOverflow && (
        <div
          className="nc-vault-picker-overflow"
          ref={personalDropdownRef}
        >
          <button
            type="button"
            className={
              'nc-vault-pill nc-vault-overflow-trigger'
              + (activeIsInPersonalOverflow ? ' nc-vault-pill-active' : '')
            }
            onClick={() => setPersonalDropdownOpen((v) => !v)}
            onContextMenu={(e) => {
              // If the active vault is in the personal overflow set,
              // allow right-click on the trigger to open the appearance
              // popover for it — same UX as if its pill were visible.
              // For non-active overflow we do nothing (the user has to
              // open the dropdown and right-click the specific row).
              // Still gated on canChangeAppearance (viewers don't get
              // the popover even via the trigger).
              if (activeIsInPersonalOverflow && active) {
                handleContextMenu(e, active);
              }
            }}
            aria-haspopup="menu"
            aria-expanded={personalDropdownOpen}
            title={
              activeIsInPersonalOverflow && active
                ? `${active.name} (${overflowPersonal.length} more)`
                : `${overflowPersonal.length} more vault${overflowPersonal.length === 1 ? '' : 's'}`
            }
          >
            <span className="nc-vault-overflow-count">
              +{overflowPersonal.length}
            </span>
            <span className="nc-vault-pill-caret" aria-hidden="true">▾</span>
          </button>
          {personalDropdownOpen && (
            <div className="nc-vault-picker-menu" role="menu">
              {overflowPersonal.map((v) => (
                <Link
                  key={v.id}
                  to={`/vaults/${v.id}`}
                  className={
                    'nc-vault-picker-menu-item'
                    + (active?.id === v.id ? ' nc-vault-picker-menu-item-active' : '')
                  }
                  role="menuitem"
                  onClick={() => setPersonalDropdownOpen(false)}
                  onContextMenu={(e) => handleContextMenu(e, v)}
                >
                  <VaultAvatar vault={v} size={22} />
                  <span className="nc-vault-picker-menu-name">{v.name}</span>
                  <span className="nc-vault-picker-menu-path">{v.path}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {hasShared && (
        /*
          Trailing Shared dropdown. Two visual modes:
            - Active vault is NOT a shared one → trigger reads
              "Shared ▾" with the count tucked next to the avatar
              slot (a small "🤝" glyph stands in for the avatar
              since the trigger represents a group, not one vault).
            - Active vault IS a shared one → trigger shows that
              vault's avatar + name + caret in the active pill
              style. Same affordance as a normal active pill plus
              a caret to flag that more shared vaults sit behind it.

          Right-click on the active-shared trigger opens the
          appearance popover for that vault (if canChangeAppearance)
          — same UX as a normal active pill.
        */
        <div
          className="nc-vault-picker-overflow nc-vault-picker-shared"
          ref={sharedDropdownRef}
        >
          <button
            type="button"
            className={
              'nc-vault-pill nc-vault-shared-trigger'
              + (activeIsShared ? ' nc-vault-pill-active' : '')
            }
            onClick={() => setSharedDropdownOpen((v) => !v)}
            onContextMenu={(e) => {
              if (activeIsShared && active) {
                handleContextMenu(e, active);
              }
            }}
            aria-haspopup="menu"
            aria-expanded={sharedDropdownOpen}
            title={
              activeIsShared && active
                ? `${active.name} — shared by ${active.ownerUsername}`
                : `${sharedVaults.length} vault${sharedVaults.length === 1 ? '' : 's'} shared with you`
            }
          >
            {activeIsShared && active ? (
              <>
                <VaultAvatar vault={active} size={22} />
                <span className="nc-vault-pill-label">{active.name}</span>
              </>
            ) : (
              <>
                <span
                  className="nc-vault-shared-glyph"
                  aria-hidden="true"
                >
                  🤝
                </span>
                <span className="nc-vault-pill-label">
                  Shared
                </span>
                <span className="nc-vault-overflow-count">
                  +{sharedVaults.length}
                </span>
              </>
            )}
            <span className="nc-vault-pill-caret" aria-hidden="true">▾</span>
          </button>
          {sharedDropdownOpen && (
            <div className="nc-vault-picker-menu" role="menu">
              {sharedVaults.map((v) => (
                <Link
                  key={v.id}
                  to={`/vaults/${v.id}`}
                  className={
                    'nc-vault-picker-menu-item'
                    + (active?.id === v.id ? ' nc-vault-picker-menu-item-active' : '')
                  }
                  role="menuitem"
                  onClick={() => setSharedDropdownOpen(false)}
                  onContextMenu={(e) => handleContextMenu(e, v)}
                  title={`Shared by ${v.ownerUsername}`}
                >
                  <VaultAvatar vault={v} size={22} />
                  <span className="nc-vault-picker-menu-name">{v.name}</span>
                  {/* "by <owner>" replaces the muted path for shared
                      rows — the owner is the more useful disambiguator
                      when the user opens this dropdown ("which vault
                      did Jacob share?" vs "what's the on-disk path?"). */}
                  <span className="nc-vault-picker-menu-path">
                    by {v.ownerUsername}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {/*
        Off-screen measurement mirror. Holds every PERSONAL vault's
        pill at natural width (shared vaults don't participate in the
        overflow algorithm — they're behind the trailing shared
        trigger which is reserved separately). Visually hidden from
        the user (pointer-events none, aria-hidden, transform
        off-canvas) but laid out by the browser so offsetWidth reads
        correctly. We position it absolutely so it doesn't push the
        visible pills around.

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
        {personalVaults.map((v) =>
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
