import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';

import type { SlashMenuItem } from '../editor/slashMenuItems';

export interface SlashMenuListProps {
  /** The items to display when no submenu is active. */
  items: SlashMenuItem[];
  /**
   * Called when the user picks a non-submenu item. The picked item
   * carries the command that will be run with the editor + the
   * trigger range.
   */
  command: (item: SlashMenuItem) => void;
}

export interface SlashMenuListHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

/**
 * Slash menu popup body.
 *
 * Two modes:
 *   - "main"     : the items prop, as filtered by the user's typing
 *   - "submenu"  : a static list bound to a submenu item; the user
 *                  picked something with `submenuItems` set, and we
 *                  swapped the displayed list to those items.
 *
 * When in submenu mode, filter typing is ignored — the user picked
 * the submenu and is now navigating it. They can press Esc or pick
 * the "← Back" row to return to the main list.
 *
 * Click selects items directly; keyboard input flows in through the
 * imperative handle (forwarded by the suggestion plugin).
 */
export const SlashMenuList = forwardRef(function SlashMenuList(
  { items, command }: SlashMenuListProps,
  ref: Ref<SlashMenuListHandle>,
) {
  // When non-null, we're in submenu mode; render these items
  // instead of the main `items` prop.
  const [submenuItems, setSubmenuItems] = useState<SlashMenuItem[] | null>(null);

  const visibleItems = submenuItems ?? items;
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Refs for scroll-into-view on arrow navigation.
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Reset selection when the visible item set changes — happens
  // on filter typing in main mode and on entering/exiting submenu.
  useEffect(() => {
    setSelectedIndex(0);
  }, [visibleItems]);

  // Scroll the active row into view when arrow-key navigation moves
  // the selection past the visible window.
  useEffect(() => {
    const el = rowRefs.current[selectedIndex];
    if (el) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [selectedIndex]);

  function selectItem(index: number) {
    const item = visibleItems[index];
    if (!item) return;

    if (item.isBack) {
      // Return to main mode. Selection resets via items-change effect.
      setSubmenuItems(null);
      return;
    }

    if (item.submenuItems) {
      // Enter submenu mode with this item's children.
      setSubmenuItems(item.submenuItems());
      return;
    }

    // Normal action — let the suggestion plugin's command callback
    // run the item's command (which consumes the trigger range and
    // inserts content).
    command(item);
  }

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (visibleItems.length === 0) {
        return event.key === 'Escape';
      }
      if (event.key === 'ArrowUp') {
        setSelectedIndex((s) => (s + visibleItems.length - 1) % visibleItems.length);
        return true;
      }
      if (event.key === 'ArrowDown') {
        setSelectedIndex((s) => (s + 1) % visibleItems.length);
        return true;
      }
      if (event.key === 'Enter') {
        selectItem(selectedIndex);
        return true;
      }
      // Esc: if we're in a submenu, back out to main list. If
      // we're in main mode, let the suggestion plugin handle it
      // (which closes the popup entirely).
      if (event.key === 'Escape' && submenuItems !== null) {
        setSubmenuItems(null);
        return true;
      }
      return false;
    },
  }));

  if (visibleItems.length === 0) {
    return (
      <div className="nc-slash-menu nc-slash-menu-empty">
        <div className="nc-slash-empty">No matches</div>
      </div>
    );
  }

  return (
    <div className="nc-slash-menu" role="listbox">
      {visibleItems.map((item, idx) => (
        <button
          key={item.title}
          ref={(el) => {
            rowRefs.current[idx] = el;
          }}
          type="button"
          role="option"
          aria-selected={idx === selectedIndex}
          className={
            (idx === selectedIndex
              ? 'nc-slash-row nc-slash-row-active'
              : 'nc-slash-row') + (item.isBack ? ' nc-slash-row-back' : '')
          }
          onMouseEnter={() => setSelectedIndex(idx)}
          onMouseDown={(e) => {
            // mousedown not click — preventDefault stops the editor
            // from blurring before our handler runs.
            e.preventDefault();
            selectItem(idx);
          }}
        >
          <span className="nc-slash-icon">{item.icon}</span>
          <span className="nc-slash-text">
            <span className="nc-slash-title">{item.title}</span>
            {item.subtitle && (
              <span className="nc-slash-subtitle">{item.subtitle}</span>
            )}
          </span>
          {/* Indicate items with a submenu via a chevron on the right. */}
          {item.submenuItems && <span className="nc-slash-chevron">▶</span>}
        </button>
      ))}
    </div>
  );
});
