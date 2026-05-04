import { useCallback, useState } from 'react';

/**
 * Persisted appearance settings for the folder tree.
 *
 * Two axes:
 *   - `fontStack`: full CSS font-family value (matching the per-note
 *     FONT_OPTIONS list). Empty string = "use the CSS default" (the
 *     tree inherits whatever the app body uses).
 *   - `fontSize`: integer px in 10–32, matching the per-note Font size
 *     range. null = "use the CSS default".
 *
 * Both are global (per-browser, in localStorage), like the tree
 * variant in treeStyles.ts.
 *
 * Why localStorage and not the server? The tree variant is also
 * client-only — it's a personal display preference, not a property
 * of the vault. Keeps the server out of UI bookkeeping.
 *
 * Re-using FONT_OPTIONS from EditableNoteAppearance.tsx ties the
 * tree's font choices to the same list users see for individual
 * notes. If we add a new font option there, the tree picker gets it
 * automatically — single source of truth.
 */

export const TREE_FONT_SIZE_MIN = 10;
export const TREE_FONT_SIZE_MAX = 32;

const STORAGE_KEY_FONT = 'nc.treeFontStack';
const STORAGE_KEY_SIZE = 'nc.treeFontSize';

/** Re-export so the picker doesn't have to import from a sibling. */
export { FONT_OPTIONS } from '../components/EditableNoteAppearance';

export interface TreeAppearance {
  /** Empty string means "default". */
  fontStack: string;
  /** null means "default". */
  fontSize: number | null;

  setFontStack: (stack: string) => void;
  setFontSize: (size: number | null) => void;
}

function loadFontStack(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_FONT);
    if (typeof raw === 'string') {
      // We don't strictly validate against FONT_OPTIONS — a value
      // saved before a font was removed from the list shouldn't
      // crash. The picker will fall back to "Default" in that case
      // (see fontStackToId in EditableNoteAppearance), but the
      // saved stack still gets applied to the tree. Acceptable
      // failure mode.
      return raw;
    }
  } catch {
    /* ignore */
  }
  return '';
}

function saveFontStack(stack: string): void {
  try {
    if (stack === '') {
      // Cleaner storage: remove the key rather than persist an
      // empty string. Same observable behaviour either way, but
      // localStorage stays tidy.
      localStorage.removeItem(STORAGE_KEY_FONT);
    } else {
      localStorage.setItem(STORAGE_KEY_FONT, stack);
    }
  } catch {
    /* ignore */
  }
}

function loadFontSize(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SIZE);
    if (raw === null || raw === '') return null;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return null;
    if (n < TREE_FONT_SIZE_MIN || n > TREE_FONT_SIZE_MAX) return null;
    return n;
  } catch {
    return null;
  }
}

function saveFontSize(size: number | null): void {
  try {
    if (size === null) {
      localStorage.removeItem(STORAGE_KEY_SIZE);
    } else {
      localStorage.setItem(STORAGE_KEY_SIZE, String(size));
    }
  } catch {
    /* ignore */
  }
}

/**
 * Stateful hook used by VaultLayout. Owns the values + setters,
 * persists changes to localStorage on the spot.
 *
 * Cross-tab sync isn't wired up. If the user opens two tabs and
 * changes the font in one, the other won't see it until the next
 * full reload. Same trade-off the tree variant makes; not worth a
 * `storage` event listener for a global personal preference.
 */
export function useTreeAppearance(): TreeAppearance {
  const [fontStack, setFontStackState] = useState<string>(() => loadFontStack());
  const [fontSize, setFontSizeState] = useState<number | null>(() => loadFontSize());

  const setFontStack = useCallback((stack: string) => {
    setFontStackState(stack);
    saveFontStack(stack);
  }, []);

  const setFontSize = useCallback((size: number | null) => {
    setFontSizeState(size);
    saveFontSize(size);
  }, []);

  return { fontStack, fontSize, setFontStack, setFontSize };
}

/**
 * Convenience: build the inline style object the TreeView's root
 * <div> applies. Both keys are conditional — leaving them undefined
 * means "no inline value set", which lets the variant CSS rule's
 * own font-size win.
 */
export function buildTreeStyle(
  fontStack: string,
  fontSize: number | null,
): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (fontStack) style.fontFamily = fontStack;
  if (fontSize !== null) style.fontSize = `${fontSize}px`;
  return style;
}
