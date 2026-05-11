/**
 * DEPRECATED — kept as an empty module for one ship cycle so the
 * file's continued presence in the repo doesn't surprise anyone
 * grepping for it. Safe to delete in a follow-up cleanup ship.
 *
 * Originally exposed `colorForName(name)` — a deterministic hash
 * from folder names to one of the 8 vault palette colours, used
 * by the mobile redesign's round-button navigation row. The user
 * found the per-folder colours noisy and asked for a single
 * neutral grey across all folder circles. The colour decision is
 * now baked directly into CSS (.nc-mobile-nav-btn-circle-folder
 * in styles.css), so this helper is unused.
 *
 * No exports — if anything still imports from this file, tsc will
 * tell us. Better than silently re-exporting a no-op function
 * that callers depend on by accident.
 */
export {};
