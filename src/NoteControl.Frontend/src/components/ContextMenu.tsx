import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * One row in a context menu. A divider is rendered when label is null.
 *
 * disabled items render in muted colour and don't fire onClick. Used
 * for "coming soon" items whose backend isn't wired yet — discoverable
 * but inert.
 *
 * Ship 85: mobileHidden flags items that don't make sense on a phone
 * — e.g. "Properties" for a folder (no mobile UI exists for it),
 * or actions that depend on desktop-only capabilities. The item is
 * still rendered into the DOM but CSS hides it at ≤768px so the
 * menu shrinks to just the items that work. The flag stays opt-in;
 * by default everything renders.
 */
export interface ContextMenuItem {
  /** Null label means "render a divider here". */
  label: string | null;
  onClick?: () => void;
  disabled?: boolean;
  /** Tooltip on hover — useful for explaining why a disabled item is disabled. */
  hint?: string;
  /** Optional accelerator hint shown right-aligned (e.g. "Del", "F2"). */
  accelerator?: string;
  /** Ship 85: hide on mobile (≤768px) via CSS. See class
      `.nc-context-item-mobile-hidden` in styles.css. */
  mobileHidden?: boolean;
}

export interface ContextMenuProps {
  /** Cursor coordinates from the triggering MouseEvent. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Renders an absolutely-positioned menu at (x, y). Closes on:
 *   - clicking outside
 *   - pressing Escape
 *   - clicking a non-disabled item (after firing its onClick)
 *
 * Position is clamped to the viewport so a right-click near the edge
 * doesn't render the menu off-screen. The clamp uses the menu's actual
 * measured width/height after first render, falling back to estimates.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click. Ship 85: pointerdown (not mousedown)
  // so iOS Safari fires reliably on tap-then-scroll outside —
  // mousedown sometimes doesn't fire on iOS when a touch turns
  // into a scroll gesture. pointerdown handles both touch and
  // mouse start unconditionally. Firing on -down (rather than
  // -up) matches native context menu dismissal behaviour.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onClose]);

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Position-clamping. Measure after mount, then nudge if off-screen.
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const overflowX = Math.max(0, rect.right - window.innerWidth + 4);
    const overflowY = Math.max(0, rect.bottom - window.innerHeight + 4);
    if (overflowX > 0 || overflowY > 0) {
      el.style.left = `${x - overflowX}px`;
      el.style.top = `${y - overflowY}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      className="nc-context-menu"
      role="menu"
      style={{ left: x, top: y }}
    >
      {items.map((item, idx) => {
        if (item.label === null) {
          return <div key={`divider-${idx}`} className="nc-context-divider" role="separator" />;
        }
        // Ship 85: tack on .nc-context-item-mobile-hidden when the
        // item has the mobileHidden flag. CSS hides it at ≤768px.
        // The dividers around it stay visible — minor visual cost
        // but avoids a more complex hide-the-divider-too rule.
        const itemClass =
          'nc-context-item' +
          (item.mobileHidden ? ' nc-context-item-mobile-hidden' : '');
        return (
          <button
            key={`${item.label}-${idx}`}
            type="button"
            className={itemClass}
            role="menuitem"
            disabled={item.disabled}
            title={item.hint}
            onClick={() => {
              if (item.disabled) return;
              item.onClick?.();
              onClose();
            }}
          >
            <span className="nc-context-label">{item.label}</span>
            {item.accelerator && (
              <span className="nc-context-accel">{item.accelerator}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Convenience: small hook that owns the open/close state of a context
 * menu. Returns the props you spread on <ContextMenu /> when open is
 * true, plus an opener you call from onContextMenu handlers.
 */
export interface UseContextMenuReturn<T> {
  open: boolean;
  x: number;
  y: number;
  payload: T | null;
  show: (e: React.MouseEvent, payload: T) => void;
  hide: () => void;
}

export function useContextMenu<T>(): UseContextMenuReturn<T> {
  const [state, setState] = useState<{ open: boolean; x: number; y: number; payload: T | null }>(
    { open: false, x: 0, y: 0, payload: null },
  );

  return {
    open: state.open,
    x: state.x,
    y: state.y,
    payload: state.payload,
    show: (e, payload) => {
      e.preventDefault();
      e.stopPropagation();
      setState({ open: true, x: e.clientX, y: e.clientY, payload });
    },
    hide: () => setState((s) => ({ ...s, open: false, payload: null })),
  };
}

// Re-export ReactNode to satisfy unused import linters in some configs
// (we don't actually use it in component signatures here, but keeping
// the type accessible from callers is convenient.)
export type { ReactNode };
