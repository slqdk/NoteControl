import { useCallback, useEffect, useState } from 'react';

import { ApiError, assignmentsApi } from '../api/client';
import type {
  AssignmentDto,
  AssignmentsConfigDto,
} from '../api/types';
import { useDebouncedSave } from './useDebouncedSave';

/**
 * Per-vault assignments data layer. Owns the AssignmentsConfigDto
 * for one vault and exposes mutators (add / update / delete one
 * assignment) plus replaceAll for the rare bulk case.
 *
 * Shape mirrors useDashboards on purpose — same load lifecycle,
 * same debounced save loop, same load/save error states. If a
 * future change wants to share a "vault-scoped JSON config" hook
 * abstraction between this and useDashboards, this is the place
 * to start. For now, keeping them as separate hooks reads more
 * cleanly than threading a generic.
 *
 * Save semantics: every mutation triggers a debounced PUT of the
 * whole config (same 500ms cadence the startpage config uses). The
 * payload is small (each assignment is ~3 string fields) so sending
 * unrelated assignments along is cheap.
 *
 * Failure model:
 *   - Initial load failure → loadError set; mutators become no-ops.
 *   - Save failure → saveError set; in-memory state still reflects
 *     edits, and the next debounce tick retries on the next change.
 */
export interface UseAssignmentsResult {
  /** The full config for the current vault, or null while initial load is in flight / failed. */
  config: AssignmentsConfigDto | null;
  /** Set when the initial GET failed. Render a banner; mutators no-op. */
  loadError: string | null;
  /** Set when the most-recent debounced save failed. Render a banner; edits stay in memory. */
  saveError: string | null;

  /** Append a new assignment. Returns its id so the caller can focus / scroll to it. */
  addAssignment: (a: Omit<AssignmentDto, 'id'>) => string | null;
  /** Update one assignment by id. No-op if id not found. */
  updateAssignment: (id: string, patch: Partial<Omit<AssignmentDto, 'id'>>) => void;
  /** Delete one assignment by id. No-op if id not found. */
  deleteAssignment: (id: string) => void;
}

export function useAssignments(vaultId: string | undefined): UseAssignmentsResult {
  const [config, setConfig] = useState<AssignmentsConfigDto | null>(null);
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
        const dto = await assignmentsApi.getConfig(vaultId);
        if (!cancelled) setConfig(dto);
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            e instanceof ApiError
              ? e.message
              : 'Could not load assignments.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  // ----- debounced save
  const doSave = useCallback(
    (cfg: AssignmentsConfigDto) => {
      if (!vaultId) return;
      void (async () => {
        try {
          await assignmentsApi.saveConfig(vaultId, cfg);
          setSaveError(null);
        } catch (e) {
          setSaveError(
            e instanceof ApiError
              ? e.message
              : 'Could not save assignments. Your changes are still in memory.',
          );
        }
      })();
    },
    [vaultId],
  );
  // Same trick useDashboards uses — pass a default-shape sentinel
  // before the real config has loaded. useDebouncedSave skips the
  // first render anyway, so this default value never actually
  // PUTs to the server.
  useDebouncedSave(
    config ?? { version: 1, assignments: [] },
    500,
    doSave,
  );

  // ----- mutators

  const addAssignment = useCallback(
    (a: Omit<AssignmentDto, 'id'>): string | null => {
      if (!config) return null;
      // crypto.randomUUID() is gated on a secure context. We avoid
      // it for the same reason the sticky-note add path does (see
      // src/util/id.ts). Inlining a tiny non-crypto unique here
      // would mean a util import we don't otherwise need — and the
      // id only has to be unique within one vault's assignments,
      // not globally. Date.now + a counter would clash on rapid
      // double-clicks; Math.random keeps it simple.
      const id = `a-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 9)}`;
      setConfig((prev) =>
        prev
          ? {
              ...prev,
              assignments: [...prev.assignments, { id, ...a }],
            }
          : prev,
      );
      return id;
    },
    [config],
  );

  const updateAssignment = useCallback(
    (id: string, patch: Partial<Omit<AssignmentDto, 'id'>>) => {
      setConfig((prev) => {
        if (!prev) return prev;
        const assignments = prev.assignments.map((a) =>
          a.id === id ? { ...a, ...patch } : a,
        );
        return { ...prev, assignments };
      });
    },
    [],
  );

  const deleteAssignment = useCallback((id: string) => {
    setConfig((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        assignments: prev.assignments.filter((a) => a.id !== id),
      };
    });
  }, []);

  return {
    config,
    loadError,
    saveError,
    addAssignment,
    updateAssignment,
    deleteAssignment,
  };
}
