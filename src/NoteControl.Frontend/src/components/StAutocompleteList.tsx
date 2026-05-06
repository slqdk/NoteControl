import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';

/**
 * F2 autocomplete popup body.
 *
 * Visually a sibling of SlashMenuList (it reuses the .nc-slash-*
 * classes for the row layout) but the behaviour differs in two
 * ways:
 *
 *   - The popup owns its own filter input. The slash menu's filter
 *     comes from text the user types AFTER the "/" trigger via
 *     @tiptap/suggestion. F2 has no such trigger; we capture
 *     keystrokes ourselves and update an internal query string.
 *
 *   - There's no submenu mode. The F2 list is flat (types + FBs
 *     in declaration mode, or declared variables in implementation
 *     mode). If we ever need grouping, this is where it would go.
 *
 * Keyboard control: the parent extension forwards keystrokes via
 * the imperative handle (same shape SlashMenuList exposes — keeps
 * the wiring familiar). The popup itself doesn't bind a keydown
 * listener; the extension does, so the editor never sees the
 * letter keys while the popup is open.
 */

export interface AutocompleteItem {
  /** Inserted at the cursor when this item is picked. */
  insertText: string;
  /** The label shown in the popup row (e.g. "TON"). */
  title: string;
  /** Smaller-font second-line label (e.g. "Function block" or
   *  "UDINT"). Optional. */
  subtitle?: string;
  /**
   * For matching: lowercase strings the filter compares against.
   * Always includes the lowercased title; the extension can add
   * synonyms (e.g. "fb", "timer") for FBs.
   */
  keywords: string[];
  /**
   * After insertion, place the caret at this offset within the
   * inserted text (0-indexed, in characters). When undefined the
   * caret lands at the end of the insertion. Used to drop the
   * cursor at the first `:=` for FB call signatures.
   */
  caretOffset?: number;
}

export interface StAutocompleteListProps {
  items: AutocompleteItem[];
  command: (item: AutocompleteItem) => void;
  /** Heading shown above the list — "Types & function blocks" or
   *  "Declared variables". Helps the user understand what mode
   *  they're in. */
  heading: string;
}

export interface StAutocompleteListHandle {
  /**
   * Called by the extension's window-level keydown listener. Returns
   * true if the popup consumed the event. The extension calls
   * preventDefault + stopPropagation when we return true so the
   * editor never sees the keystroke.
   */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export const StAutocompleteList = forwardRef(function StAutocompleteList(
  { items, command, heading }: StAutocompleteListProps,
  ref: Ref<StAutocompleteListHandle>,
) {
  // Internal filter query. Starts empty; the user types to narrow
  // down. Backspace shrinks; any letter/digit/underscore extends.
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filter items by query. Match strategy mirrors the slash menu:
  // title-prefix > title-infix > keyword-prefix > keyword-infix.
  // For autocomplete, prefix-match dominates user expectation (the
  // user types "TO" and expects TON / TOF first), so we score and
  // sort instead of using one-shot filtering.
  const filtered = filterItems(items, query);

  // Reset selection when the filtered list changes shape — common
  // case: the user typed a letter and the list shrank, the prior
  // selectedIndex now points past the end.
  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length, query]);

  // Scroll the active row into view on arrow nav.
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const el = rowRefs.current[selectedIndex];
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedIndex]);

  function pick(index: number) {
    const item = filtered[index];
    if (item) command(item);
  }

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      // Navigation keys — consume regardless of the filter list
      // being empty (Esc still needs to dismiss in that case;
      // the extension wires Esc separately).
      if (event.key === 'ArrowUp') {
        if (filtered.length > 0) {
          setSelectedIndex((s) => (s + filtered.length - 1) % filtered.length);
        }
        return true;
      }
      if (event.key === 'ArrowDown') {
        if (filtered.length > 0) {
          setSelectedIndex((s) => (s + 1) % filtered.length);
        }
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        // Tab picks the highlighted item like an IDE — useful when
        // the user typed only the first few letters and wants to
        // accept the suggestion without letting go of the keyboard.
        if (filtered.length > 0) {
          pick(selectedIndex);
        }
        return true;
      }
      if (event.key === 'Backspace') {
        setQuery((q) => q.slice(0, -1));
        return true;
      }
      // Letter / digit / underscore extends the query. Anything
      // else (punctuation, function keys, modifiers alone) the
      // popup doesn't consume.
      if (event.key.length === 1 && /^[A-Za-z0-9_]$/.test(event.key)) {
        setQuery((q) => q + event.key);
        return true;
      }
      return false;
    },
  }));

  return (
    <div className="nc-slash-menu nc-st-ac" role="listbox">
      <div className="nc-st-ac-heading">
        {heading}
        {query && <span className="nc-st-ac-query"> · {query}</span>}
      </div>
      {filtered.length === 0 && (
        <div className="nc-slash-empty">No matches</div>
      )}
      {filtered.map((item, idx) => (
        <button
          key={item.title + ':' + idx}
          ref={(el) => {
            rowRefs.current[idx] = el;
          }}
          type="button"
          role="option"
          aria-selected={idx === selectedIndex}
          className={
            idx === selectedIndex
              ? 'nc-slash-row nc-slash-row-active'
              : 'nc-slash-row'
          }
          onMouseEnter={() => setSelectedIndex(idx)}
          onMouseDown={(e) => {
            // mousedown not click — preventDefault stops the editor
            // from blurring before our handler runs (same trick the
            // slash menu uses).
            e.preventDefault();
            pick(idx);
          }}
        >
          <span className="nc-slash-icon">{shortIcon(item)}</span>
          <span className="nc-slash-text">
            <span className="nc-slash-title">{item.title}</span>
            {item.subtitle && (
              <span className="nc-slash-subtitle">{item.subtitle}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
});

/**
 * One-or-two-character glyph shown in the row's icon slot. Pulled
 * from the title for a quick visual cue: "T" for TON / TOF, "I"
 * for INT / IF, etc. Cheap, no graphics needed.
 */
function shortIcon(item: AutocompleteItem): string {
  const t = item.title.trim();
  if (t.length === 0) return '?';
  // Use the first 1-2 alpha characters, uppercased.
  const m = t.match(/[A-Za-z]{1,2}/);
  return (m ? m[0] : t.slice(0, 1)).toUpperCase();
}

/**
 * Filter + score the items against the lowercase query. Order:
 *
 *   1. Empty query → original order, no filtering.
 *   2. Title starts-with > keyword starts-with > title contains
 *      > keyword contains. Within a tier the original input
 *      order is preserved (stable sort).
 *
 * We don't fall back to fuzzy / subsequence matching — for short
 * query strings against short identifiers it's overkill and the
 * slash menu doesn't use it either.
 */
function filterItems(items: AutocompleteItem[], query: string): AutocompleteItem[] {
  if (query.length === 0) return items;
  const q = query.toLowerCase();

  type Scored = { item: AutocompleteItem; tier: number; idx: number };
  const scored: Scored[] = [];

  items.forEach((item, idx) => {
    const titleLower = item.title.toLowerCase();
    let tier = 99;
    if (titleLower.startsWith(q)) tier = 0;
    else if (item.keywords.some((k) => k.startsWith(q))) tier = 1;
    else if (titleLower.includes(q)) tier = 2;
    else if (item.keywords.some((k) => k.includes(q))) tier = 3;
    if (tier < 99) scored.push({ item, tier, idx });
  });

  scored.sort((a, b) => (a.tier - b.tier) || (a.idx - b.idx));
  return scored.map((s) => s.item);
}
