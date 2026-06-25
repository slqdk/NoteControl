/**
 * Global tree-behaviour settings (step 36).
 *
 * Two preferences:
 *   - rowClickExpands: when true (default), clicking ANYWHERE on a
 *     folder row both selects+navigates AND toggles expand. When
 *     false, only the chevron toggles expand; the rest of the row
 *     just selects+navigates. The double-click-toggle behaviour is
 *     unaffected — it always toggles, in either mode.
 *   - collapseChildren: when true (default), collapsing a folder also
 *     collapses its entire subtree — every descendant drops out of the
 *     expanded set, so re-opening the folder shows it collapsed rather
 *     than re-exploding to its prior state. When false, a collapse only
 *     hides the folder; its sub-folders keep their expanded state and
 *     reappear on re-open. Independent of rowClickExpands: this governs
 *     the RESULT of a collapse, rowClickExpands governs the TRIGGER.
 *
 * Why this exists: the previous behaviour (expand only via chevron)
 * felt fiddly — the chevron is a tiny target and people keep
 * mis-clicking the row body expecting it to expand the folder. The
 * new default matches what most file-browsers do (Notion, VS Code's
 * sidebar, Finder's column view by analogy). The setting is here for
 * the user who liked the precise, click-target-isolated old way.
 *
 * Pattern intentionally mirrors settings/appearance.ts:
 *   - same localStorage key shape
 *   - same notify() pubsub
 *   - same useXxx() hook signature
 * so adding more tree-behaviour preferences later is a matter of
 * extending the interface and the hook return — no new plumbing.
 *
 * Cross-tab sync via the 'storage' event; same-tab sync via a tiny
 * subscriber list. No React context needed for a single writer + a
 * couple of readers.
 */

import { useEffect, useState } from 'react';

// ---------------------------------------------------- types

export interface TreeBehaviourSettings {
  /**
   * If true: a click on a folder row body toggles its expand state
   * AND selects+navigates. If false: only the chevron toggles; the
   * row body just selects+navigates.
   */
  rowClickExpands: boolean;

  /**
   * If true (default): collapsing a folder also collapses its entire
   * subtree — every descendant is removed from the expanded set, so
   * re-opening the folder shows its children collapsed rather than
   * restoring the previously-expanded state. If false: collapsing a
   * folder only hides it; descendants keep their expanded state and
   * reappear when the folder is re-opened.
   *
   * Independent of rowClickExpands — that governs what TRIGGERS a
   * collapse (row click vs chevron vs double-click); this governs the
   * RESULT. They compose: a collapse from any trigger honours this.
   */
  collapseChildren: boolean;
}

const DEFAULTS: TreeBehaviourSettings = {
  // Default ON — most users expect "click row = expand", and it
  // dramatically reduces the "why didn't that do anything" feeling
  // when you mis-click the chevron by 2 pixels.
  rowClickExpands: true,
  // Default ON — collapsing a parent tidies the whole subtree away, so
  // a folder you re-open starts collapsed instead of re-exploding to
  // wherever you'd left it. Matches the "collapse everything under
  // here" instinct most people have when they close a folder.
  collapseChildren: true,
};

// ---------------------------------------------------- persistence

const STORAGE_KEY = 'nc.treeBehaviour';

export function loadTreeBehaviour(): TreeBehaviourSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<TreeBehaviourSettings>;
    return {
      rowClickExpands:
        typeof parsed.rowClickExpands === 'boolean'
          ? parsed.rowClickExpands
          : DEFAULTS.rowClickExpands,
      // Absent key (saved blobs that predate this setting) falls back
      // to the default — so existing users get collapse-subtree ON
      // without any migration step.
      collapseChildren:
        typeof parsed.collapseChildren === 'boolean'
          ? parsed.collapseChildren
          : DEFAULTS.collapseChildren,
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveTreeBehaviour(next: TreeBehaviourSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — silent, settings still apply for this tab */
  }
  notify();
}

// ---------------------------------------------------- pubsub

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((l) => l());
}

// Cross-tab sync: 'storage' fires when ANOTHER tab writes to
// localStorage. Same-tab writes use our own pubsub via notify().
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) notify();
  });
}

// ---------------------------------------------------- React hook

/**
 * Returns the current tree-behaviour settings + setters. Re-renders
 * when the settings change, whether the change came from this
 * component, another component, or another tab.
 */
export function useTreeBehaviour(): {
  settings: TreeBehaviourSettings;
  setRowClickExpands: (v: boolean) => void;
  setCollapseChildren: (v: boolean) => void;
  // Convenience: mirror the values at the top level so consumers can
  // destructure a single boolean rather than reach through .settings.
  rowClickExpands: boolean;
  collapseChildren: boolean;
} {
  const [settings, setSettings] = useState<TreeBehaviourSettings>(() =>
    loadTreeBehaviour(),
  );

  useEffect(() => {
    // Re-read on mount in case another tab wrote between the initial
    // useState evaluation and now.
    setSettings(loadTreeBehaviour());
    const listener = () => setSettings(loadTreeBehaviour());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return {
    settings,
    rowClickExpands: settings.rowClickExpands,
    collapseChildren: settings.collapseChildren,
    setRowClickExpands: (v) =>
      saveTreeBehaviour({ ...loadTreeBehaviour(), rowClickExpands: v }),
    setCollapseChildren: (v) =>
      saveTreeBehaviour({ ...loadTreeBehaviour(), collapseChildren: v }),
  };
}
