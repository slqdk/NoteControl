import { useCallback, useEffect, useState } from 'react';

import { ApiError, startpageApi } from '../api/client';
import type {
  DashboardDto,
  StartpageConfigDto,
} from '../api/types';
import { newId } from '../util/id';
import { useDebouncedSave } from './useDebouncedSave';

/**
 * Per-vault dashboards data layer. Owns the StartpageConfigDto for
 * one vault and exposes mutators for both dashboard-level changes
 * (add/rename/delete a whole dashboard) and per-dashboard content
 * patches (used by the DashboardPage to splice block edits back in).
 *
 * Why a hook (not a component): two unrelated parts of the UI need
 * the same data — VaultLayout's tree (to render dashboard rows) and
 * DashboardPage's canvas (to render one dashboard's blocks).
 * Centralising state here means there's one source of truth and one
 * debounced save loop; the layout passes the result through the
 * Outlet context so the page can read+mutate without a second fetch.
 *
 * Save semantics: every mutation triggers a debounced PUT of the
 * whole config. Same 500ms cadence the legacy single-startpage
 * flow used. The payload is small enough that sending unrelated
 * dashboards along is cheap.
 *
 * Failure model:
 *   - Initial load failure → loadError is set; mutators become
 *     no-ops (we don't want to overwrite a config we never read).
 *   - Save failure → saveError is set; in-memory state still
 *     reflects edits, and the next debounce tick retries on the
 *     next mutation.
 */
export interface UseDashboardsResult {
  /**
   * The full config (all dashboards) for the current vault, or
   * null while the initial load is in flight or has failed.
   */
  config: StartpageConfigDto | null;

  /** Set when the initial GET failed. Render an error banner; don't allow edits. */
  loadError: string | null;
  /** Set when the most-recent debounced save failed. Render a banner; edits stay in memory. */
  saveError: string | null;

  // ------------------------------------------------ dashboard-level
  /** Append a new empty dashboard with a default name. Returns its id so the caller can navigate. */
  addDashboard: () => string | null;
  /** Rename a dashboard. No-op if the id doesn't exist. */
  renameDashboard: (id: string, name: string) => void;
  /** Delete a dashboard. Refuses (returns false) when this would empty the list. */
  deleteDashboard: (id: string) => boolean;

  // ------------------------------------------------ within-one-dashboard
  /**
   * Replace the contents of a single dashboard. Used by
   * DashboardPage to splice block/area/link edits back in without
   * having to know about its siblings.
   */
  patchDashboard: (id: string, patch: (d: DashboardDto) => DashboardDto) => void;
}

/** Default name for a freshly-created dashboard. */
const DEFAULT_NEW_NAME = 'Dashboard';

export function useDashboards(vaultId: string | undefined): UseDashboardsResult {
  const [config, setConfig] = useState<StartpageConfigDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ----- initial load
  useEffect(() => {
    if (!vaultId) return;
    let cancelled = false;
    setLoadError(null);
    setConfig(null);
    (async () => {
      try {
        const dto = await startpageApi.getConfig(vaultId);
        if (!cancelled) setConfig(dto);
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            e instanceof ApiError
              ? e.message
              : 'Could not load dashboards.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  // ----- debounced save
  // Saves the whole config on every change. The first-render skip
  // inside useDebouncedSave means a fresh load doesn't immediately
  // PUT. From then on, any mutation that survives the 500ms quiet
  // window writes through to disk.
  const doSave = useCallback(
    (cfg: StartpageConfigDto) => {
      if (!vaultId) return;
      void (async () => {
        try {
          await startpageApi.saveConfig(vaultId, cfg);
          setSaveError(null);
        } catch (e) {
          setSaveError(
            e instanceof ApiError
              ? e.message
              : 'Could not save dashboards. Your changes are still in memory.',
          );
        }
      })();
    },
    [vaultId],
  );
  // Pass the nullable config straight through. useDebouncedSave
  // treats null as "not loaded yet" — it doesn't capture a baseline
  // or fire a save — and captures the first non-null value (the
  // GET's response) as the new baseline so the post-load render
  // doesn't immediately PUT the server's own response back at it.
  //
  // Pre-this-ship we coalesced to a sentinel here so the hook's
  // generic-non-null type would accept it. The post-load value-flip
  // (null sentinel → real DTO) then looked like a user edit and
  // fired a debounced PUT, which 403d for viewers (PUT /config is
  // editor-only). With the null-aware hook the cycle is broken
  // cleanly without per-call-site workarounds.
  useDebouncedSave(config, 500, doSave);

  // ----- mutators

  const addDashboard = useCallback((): string | null => {
    if (!config) return null;
    const id = newId();
    // Find a unique default name — "Dashboard", "Dashboard 2",
    // "Dashboard 3", ... — so a user spamming + doesn't end up
    // with three identically-named rows in the tree.
    const existing = new Set(config.dashboards.map((d) => d.name));
    let candidate = DEFAULT_NEW_NAME;
    let n = 2;
    while (existing.has(candidate)) {
      candidate = `${DEFAULT_NEW_NAME} ${n}`;
      n += 1;
    }
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            dashboards: [
              ...prev.dashboards,
              {
                id,
                name: candidate,
                blocks: [],
                taskAreas: [],
                links: [],
              },
            ],
          }
        : prev,
    );
    return id;
  }, [config]);

  const renameDashboard = useCallback((id: string, name: string) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const dashboards = prev.dashboards.map((d) =>
        d.id === id ? { ...d, name } : d,
      );
      return { ...prev, dashboards };
    });
  }, []);

  const deleteDashboard = useCallback((id: string): boolean => {
    if (!config) return false;
    // Refuse to delete the last dashboard. The server's read-side
    // re-seeds a default if the file ends up empty, but we'd
    // rather not let the UI ever reach that state — the user
    // would see a blank tree until the next save.
    if (config.dashboards.length <= 1) return false;
    if (!config.dashboards.some((d) => d.id === id)) return false;
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            dashboards: prev.dashboards.filter((d) => d.id !== id),
          }
        : prev,
    );
    return true;
  }, [config]);

  const patchDashboard = useCallback(
    (id: string, patch: (d: DashboardDto) => DashboardDto) => {
      setConfig((prev) => {
        if (!prev) return prev;
        const dashboards = prev.dashboards.map((d) =>
          d.id === id ? patch(d) : d,
        );
        return { ...prev, dashboards };
      });
    },
    [],
  );

  return {
    config,
    loadError,
    saveError,
    addDashboard,
    renameDashboard,
    deleteDashboard,
    patchDashboard,
  };
}
