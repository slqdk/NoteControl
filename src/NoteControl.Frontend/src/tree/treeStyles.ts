/**
 * Visual variants for the tree view and properties panel.
 *
 * - 'compact'     — Windows 7 / Windows XP Explorer feel.
 *                   Tight rows (~22px), small chevrons, dotted indent
 *                   guides, dense info, monochrome icons.
 *
 * - 'comfortable' — Windows 11 Explorer feel.
 *                   Larger rows (~30px), bigger touch targets, no
 *                   indent guides, rounded hover backgrounds, more
 *                   whitespace.
 *
 * Adding more variants later (e.g. 'mac-finder') is a matter of:
 *   1. add the value here
 *   2. add a CSS block in styles.css matching `.nc-tree.<variant>`
 *   3. (optional) add a label in VARIANT_LABELS for the picker
 *
 * The variant is persisted in localStorage so the user's choice
 * survives reloads.
 */

export type TreeVariant = 'compact' | 'comfortable';

export const ALL_VARIANTS: readonly TreeVariant[] = ['compact', 'comfortable'] as const;

export const VARIANT_LABELS: Record<TreeVariant, string> = {
  compact: 'Compact (Win7-style)',
  comfortable: 'Comfortable (Win11-style)',
};

const STORAGE_KEY = 'nc.treeVariant';

/**
 * Read the persisted variant. Defaults to 'comfortable' for first-time
 * users — modern OSes nudged people toward the larger touch-friendly
 * style, so it's the safer first impression.
 *
 * Wrapped in try/catch because some browsers (private mode, embedded
 * webviews) throw on localStorage access. Falling back to the default
 * is always safe.
 */
export function loadVariant(): TreeVariant {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'compact' || raw === 'comfortable') {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return 'comfortable';
}

export function saveVariant(variant: TreeVariant): void {
  try {
    localStorage.setItem(STORAGE_KEY, variant);
  } catch {
    /* ignore */
  }
}
