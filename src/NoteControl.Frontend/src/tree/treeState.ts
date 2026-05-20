import { useCallback, useEffect, useState } from 'react';

import { notesApi } from '../api/client';
import type { FolderListingDto } from '../api/types';

/**
 * Persistent UI state for one vault's tree + rails.
 *
 * Why scope to vault id? Different vaults have totally different folder
 * structures, and remembering "Projects/Q4 was expanded" makes no sense
 * if you switch to a different vault. Each vault gets its own keyspace.
 *
 * Layout of the keys we write to localStorage:
 *
 *   nc.tree.<vaultId>.expanded      JSON string array of folder paths
 *   nc.layout.treeVisible           "1" | "0"  (global, not per-vault)
 *   nc.layout.propsVisible          "1" | "0"  (global)
 *   nc.layout.treeWidth             integer pixels
 *   nc.layout.propsWidth            integer pixels
 *
 * The rail visibility/width keys are global because it's about the
 * user's screen and preference, not their per-vault filing.
 */

const TREE_EXPANDED_KEY = (vaultId: string) => `nc.tree.${vaultId}.expanded`;

// ----------------------------------------------------------- expanded set

/** Internal helper: read+parse the expanded set from localStorage. */
function readExpanded(vaultId: string): Set<string> {
  try {
    const raw = localStorage.getItem(TREE_EXPANDED_KEY(vaultId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((x): x is string => typeof x === 'string'));
    }
  } catch {
    /* ignore corrupt entries */
  }
  return new Set();
}

function writeExpanded(vaultId: string, set: Set<string>): void {
  try {
    localStorage.setItem(TREE_EXPANDED_KEY(vaultId), JSON.stringify([...set]));
  } catch {
    /* ignore — quota exhaustion etc. */
  }
}

/**
 * Hook that owns:
 *   - expanded: the set of currently-expanded folder paths
 *   - childrenByPath: lazy-loaded folder listings per path
 *   - loadingByPath: which folders are currently fetching
 *   - errorByPath: which folders failed to load (and why)
 *
 * The root listing (folderPath="") is always loaded eagerly because
 * the tree starts by showing the root's contents. Subfolders only
 * load when the user clicks to expand them.
 */
export interface TreeData {
  expanded: ReadonlySet<string>;
  childrenByPath: ReadonlyMap<string, FolderListingDto>;
  loadingByPath: ReadonlySet<string>;
  errorByPath: ReadonlyMap<string, string>;

  toggle: (folderPath: string) => void;
  /** Force a fresh load of one folder (e.g. after a CRUD action). */
  refresh: (folderPath: string) => Promise<void>;
}

export function useTreeData(vaultId: string): TreeData {
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpanded(vaultId));
  const [childrenByPath, setChildrenByPath] = useState<Map<string, FolderListingDto>>(
    new Map(),
  );
  const [loadingByPath, setLoadingByPath] = useState<Set<string>>(new Set());
  const [errorByPath, setErrorByPath] = useState<Map<string, string>>(new Map());

  // Reset when vault changes — new vault means new persisted expanded set
  // and a totally fresh child cache.
  useEffect(() => {
    setExpanded(readExpanded(vaultId));
    setChildrenByPath(new Map());
    setLoadingByPath(new Set());
    setErrorByPath(new Map());
  }, [vaultId]);

  // Persist whenever expanded changes.
  useEffect(() => {
    writeExpanded(vaultId, expanded);
  }, [vaultId, expanded]);

  /**
   * Load (or reload) one folder's children. Idempotent — if a load is
   * already in flight for this path, second call is a no-op.
   */
  const loadFolder = useCallback(
    async (folderPath: string): Promise<void> => {
      if (loadingByPath.has(folderPath)) return;

      setLoadingByPath((prev) => {
        const next = new Set(prev);
        next.add(folderPath);
        return next;
      });
      setErrorByPath((prev) => {
        if (!prev.has(folderPath)) return prev;
        const next = new Map(prev);
        next.delete(folderPath);
        return next;
      });

      try {
        const listing = await notesApi.listFolder(vaultId, folderPath);
        setChildrenByPath((prev) => {
          const next = new Map(prev);
          next.set(folderPath, listing);
          return next;
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to load folder.';
        setErrorByPath((prev) => {
          const next = new Map(prev);
          next.set(folderPath, message);
          return next;
        });
      } finally {
        setLoadingByPath((prev) => {
          const next = new Set(prev);
          next.delete(folderPath);
          return next;
        });
      }
    },
    [vaultId, loadingByPath],
  );

  // Always load the root listing on mount / vault change.
  //
  // Ship 92 bugfix: includes `childrenByPath` in the dep list so the
  // effect refires AFTER the reset effect (above) clears the cache.
  // Pre-Ship-92 the deps were `[vaultId]` only. When vaultId changed:
  //   - Render 2 ran with vault A's stale cache — the .has('') check
  //     was true, so we SKIPPED the load.
  //   - The reset effect then queued setChildrenByPath(new Map()),
  //     and on render 3 the cache was empty — but vaultId hadn't
  //     changed since render 2, so the [vaultId]-only dep didn't
  //     fire the effect again.
  //   - Result: empty tree, no in-flight load. The user saw "tree
  //     not showing" until they navigated away and back.
  // Adding childrenByPath to the deps means render 3 (with the empty
  // map) DOES re-fire the effect; the .has('') check is now false,
  // and the load kicks off correctly.
  //
  // The internal `loadingByPath.has('')` guard prevents double-fires
  // during normal operation — when a load is already in flight,
  // additional cache-shape changes (e.g. a sibling folder finishing
  // its load) won't trigger a second root fetch.
  useEffect(() => {
    if (!childrenByPath.has('') && !loadingByPath.has('')) {
      void loadFolder('');
    }
    // We deliberately omit loadFolder from deps — including it would
    // re-fire whenever loadingByPath changes (because loadFolder closes
    // over it), causing extra root reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId, childrenByPath]);

  // Restore previously-expanded folders by lazily fetching their children
  // on mount. We do this serially-but-async so a deeply-nested expanded
  // state doesn't blast the API with parallel calls.
  //
  // Ship 92 bugfix: includes `expanded` in the dep list so the effect
  // refires after the reset effect swaps in the new vault's expanded
  // set. Pre-Ship-92 the deps were [vaultId] only, which had the same
  // stale-closure bug as the root-load effect: render 2 ran with vault
  // A's expanded set still in scope, render 3 had the new set but the
  // [vaultId]-only dep didn't re-fire.
  //
  // Adding `expanded` to deps means the effect ALSO refires on user-
  // initiated toggle (every expand/collapse mutates the set). That's
  // OK because `loadFolder` is internally idempotent — it skips when
  // the path is already loaded/loading. The extra runs are tiny: an
  // O(expanded.size) loop with all-skip on every toggle. Cheap.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const path of expanded) {
        if (cancelled) return;
        if (!childrenByPath.has(path) && !loadingByPath.has(path)) {
          await loadFolder(path);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId, expanded]);

  // Eager one-level pre-fetch (Ship N: empty-folder gray-out).
  //
  // Whenever a folder's children land in `childrenByPath`, kick off
  // listings for each of its direct subfolders. This is what enables
  // the tree to know, BEFORE the user expands a folder, whether it's
  // empty — so empty folders can be greyed out as a "don't bother"
  // signal. Without this pre-fetch, emptiness is only known after a
  // first manual expand.
  //
  // Scope: ONE LEVEL only. We don't recursively pre-fetch the
  // grandchildren — that would fan out exponentially. When the user
  // expands a folder, ITS children become "newly loaded" and this
  // effect fires again to pre-fetch THEIR subfolders. Sequential
  // walking through the listing keeps per-burst load to N small
  // requests in series rather than N parallel hits.
  //
  // Cost model: when the root listing has K top-level folders, this
  // effect fires K listing calls in series shortly after mount. With
  // small folders (< 100 ms server-side each) the user sees the tree
  // settle into its "known empty" state within a second or two on a
  // healthy LAN. On a slow link it just takes longer; nothing breaks,
  // the folders just look un-greyed for a bit.
  //
  // Idempotence is delegated to loadFolder, which short-circuits on
  // both "already loaded" and "load in flight" — so this effect can
  // fire as often as it likes without triggering duplicate requests.
  //
  // The dep list is [vaultId, childrenByPath]: every time a new
  // listing lands the cache reference changes (we always return a
  // new Map from setChildrenByPath), so this effect re-runs and
  // discovers the new subfolders to peek at.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Snapshot the current listings so iteration is stable even if
      // childrenByPath updates mid-loop (the next render will refire
      // the effect with the new snapshot anyway).
      const entries = Array.from(childrenByPath.values());
      for (const listing of entries) {
        if (cancelled) return;
        for (const sub of listing.subfolders) {
          if (cancelled) return;
          if (childrenByPath.has(sub.path)) continue;
          if (loadingByPath.has(sub.path)) continue;
          // Sequential await so 50 top-level folders don't fire 50
          // parallel requests. Each request is small (one folder
          // listing), so even a 50-folder vault settles in well
          // under a second on a reasonable connection.
          await loadFolder(sub.path);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // loadingByPath intentionally omitted — including it would fire
    // this effect on every loading-state flip, causing redundant
    // sweeps of the cache while the initial burst is still going.
    // The internal `loadFolder` guard already handles the race
    // (concurrent calls for the same path become a single fetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId, childrenByPath]);

  const toggle = useCallback(
    (folderPath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(folderPath)) {
          next.delete(folderPath);
        } else {
          next.add(folderPath);
          // Lazy load on first expand.
          if (!childrenByPath.has(folderPath) && !loadingByPath.has(folderPath)) {
            void loadFolder(folderPath);
          }
        }
        return next;
      });
    },
    [childrenByPath, loadingByPath, loadFolder],
  );

  return {
    expanded,
    childrenByPath,
    loadingByPath,
    errorByPath,
    toggle,
    refresh: loadFolder,
  };
}

// ----------------------------------------------------------- rail layout

const LAYOUT_KEYS = {
  treeVisible: 'nc.layout.treeVisible',
  propsVisible: 'nc.layout.propsVisible',
  treeWidth: 'nc.layout.treeWidth',
  propsWidth: 'nc.layout.propsWidth',
} as const;

const TREE_WIDTH_DEFAULT = 260;
const PROPS_WIDTH_DEFAULT = 280;
const TREE_WIDTH_MIN = 160;
const TREE_WIDTH_MAX = 600;
const PROPS_WIDTH_MIN = 180;
const PROPS_WIDTH_MAX = 600;

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === '0') return false;
    if (raw === '1') return true;
  } catch {
    /* ignore */
  }
  return fallback;
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function readInt(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n)) {
        return Math.min(max, Math.max(min, n));
      }
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function writeInt(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* ignore */
  }
}

export interface RailLayout {
  treeVisible: boolean;
  propsVisible: boolean;
  treeWidth: number;
  propsWidth: number;

  setTreeVisible: (v: boolean) => void;
  setPropsVisible: (v: boolean) => void;
  setTreeWidth: (px: number) => void;
  setPropsWidth: (px: number) => void;
}

/**
 * Hook owning the global rail layout. Defaults: tree visible, props
 * hidden — matches the "you usually navigate, sometimes inspect"
 * pattern. Visual Studio's default is similar (Solution Explorer
 * always; Properties on demand).
 */
export function useRailLayout(): RailLayout {
  const [treeVisible, setTreeVisibleState] = useState<boolean>(() =>
    readBool(LAYOUT_KEYS.treeVisible, true),
  );
  const [propsVisible, setPropsVisibleState] = useState<boolean>(() =>
    readBool(LAYOUT_KEYS.propsVisible, false),
  );
  const [treeWidth, setTreeWidthState] = useState<number>(() =>
    readInt(LAYOUT_KEYS.treeWidth, TREE_WIDTH_DEFAULT, TREE_WIDTH_MIN, TREE_WIDTH_MAX),
  );
  const [propsWidth, setPropsWidthState] = useState<number>(() =>
    readInt(LAYOUT_KEYS.propsWidth, PROPS_WIDTH_DEFAULT, PROPS_WIDTH_MIN, PROPS_WIDTH_MAX),
  );

  const setTreeVisible = useCallback((v: boolean) => {
    setTreeVisibleState(v);
    writeBool(LAYOUT_KEYS.treeVisible, v);
  }, []);

  const setPropsVisible = useCallback((v: boolean) => {
    setPropsVisibleState(v);
    writeBool(LAYOUT_KEYS.propsVisible, v);
  }, []);

  const setTreeWidth = useCallback((px: number) => {
    const clamped = Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, px));
    setTreeWidthState(clamped);
    writeInt(LAYOUT_KEYS.treeWidth, clamped);
  }, []);

  const setPropsWidth = useCallback((px: number) => {
    const clamped = Math.min(PROPS_WIDTH_MAX, Math.max(PROPS_WIDTH_MIN, px));
    setPropsWidthState(clamped);
    writeInt(LAYOUT_KEYS.propsWidth, clamped);
  }, []);

  return {
    treeVisible,
    propsVisible,
    treeWidth,
    propsWidth,
    setTreeVisible,
    setPropsVisible,
    setTreeWidth,
    setPropsWidth,
  };
}

export const RAIL_BOUNDS = {
  TREE_MIN: TREE_WIDTH_MIN,
  TREE_MAX: TREE_WIDTH_MAX,
  PROPS_MIN: PROPS_WIDTH_MIN,
  PROPS_MAX: PROPS_WIDTH_MAX,
} as const;

// ----------------------------------------------------------- new-folder prompt

/**
 * State for the "inline new folder" prompt — when set, the tree
 * renders a temporary input row under the given parent path.
 * The user types a name, Enter submits, Escape cancels.
 *
 * Lives in its own hook so the tree component can subscribe to it
 * without re-rendering on every TreeData change.
 */
export interface NewFolderPrompt {
  parentPath: string;   // "" means root
}

export interface NewFolderPromptState {
  prompt: NewFolderPrompt | null;
  start: (parentPath: string) => void;
  cancel: () => void;
}

export function useNewFolderPrompt(): NewFolderPromptState {
  const [prompt, setPrompt] = useState<NewFolderPrompt | null>(null);

  return {
    prompt,
    start: (parentPath: string) => setPrompt({ parentPath }),
    cancel: () => setPrompt(null),
  };
}

// ----------------------------------------------------------- new-note prompt

/**
 * Same shape as the new-folder prompt but for note creation. Kept
 * separate so a user can have at most one of each pending — and so
 * the tree component can render the right input row (📁 vs 📄) at
 * the right level.
 */
export interface NewNotePrompt {
  parentPath: string;
}

export interface NewNotePromptState {
  prompt: NewNotePrompt | null;
  start: (parentPath: string) => void;
  cancel: () => void;
}

export function useNewNotePrompt(): NewNotePromptState {
  const [prompt, setPrompt] = useState<NewNotePrompt | null>(null);
  return {
    prompt,
    start: (parentPath: string) => setPrompt({ parentPath }),
    cancel: () => setPrompt(null),
  };
}

// ----------------------------------------------------------- rename prompt

/**
 * Rename in-place: identified by the current canonical path of the
 * thing being renamed. Either kind ('folder' | 'note').
 */
export interface RenamePrompt {
  kind: 'folder' | 'note';
  path: string;
}

export interface RenamePromptState {
  prompt: RenamePrompt | null;
  start: (kind: 'folder' | 'note', path: string) => void;
  cancel: () => void;
}

export function useRenamePrompt(): RenamePromptState {
  const [prompt, setPrompt] = useState<RenamePrompt | null>(null);
  return {
    prompt,
    start: (kind, path) => setPrompt({ kind, path }),
    cancel: () => setPrompt(null),
  };
}
