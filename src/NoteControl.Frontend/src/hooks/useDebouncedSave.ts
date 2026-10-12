import { useCallback, useEffect, useRef } from 'react';

/**
 * Run a save callback every time `value` changes, but no sooner
 * than `delayMs` after the LAST change. Mirrors the standard
 * "save while typing" pattern: rapid edits coalesce into one
 * server call when the user pauses.
 *
 * Step 40 originally introduced this for the per-vault startpage
 * config — every drag, resize, and popup tweak mutates the in-memory
 * blocks array, but we only PUT to the server when typing stops. The
 * same hook is now reused by every per-vault sidecar (startpage,
 * assignments, note-widgets).
 *
 * Behaviour notes:
 *   - `value === null` or `undefined` is treated as "not loaded
 *     yet": the hook does nothing, does NOT capture a baseline, and
 *     does NOT fire a save. The very first non-null/non-undefined
 *     value seen becomes the baseline and is NOT saved. This means
 *     a `useState<T | null>(null)` that gets `setX(serverDto)` after
 *     an async load behaves correctly: the post-load render captures
 *     the loaded value as "already saved" rather than firing a save
 *     of the loaded value back at the server it just came from.
 *   - The original behaviour (capture the very first render's value
 *     as baseline, never save it) still holds for callers that pass
 *     a non-null value on every render — same contract as before, no
 *     change for them.
 *   - A pending save is FLUSHED (fired immediately, not dropped)
 *     on unmount, when the value goes back to null (the host moved
 *     to another vault), and when the tab is hidden. It used to be
 *     cancelled on unmount, so an edit made less than `delayMs`
 *     before navigating away (add an assignment, then click a note)
 *     was silently lost. The flush calls the `save` captured when
 *     that edit was scheduled — i.e. the closure for the vault the
 *     value belongs to, never the next vault's.
 *   - `save` is not in the dependency array. We capture the
 *     latest `save` via a ref so callers don't have to memoise
 *     it; otherwise every re-render with a fresh closure would
 *     reschedule the timer.
 *
 * Comparison via JSON.stringify is fine for the small POJOs we
 * use it for; for bigger objects swap to a deep-equal lib.
 *
 * ---------------------------------------------------------------
 * Why the null-skip rule exists
 *
 * Pre-this-change the hook took a non-nullable `T` and the three
 * call sites coalesced their nullable config to a sentinel of the
 * right shape:
 *
 *     useDebouncedSave(config ?? { version: 2, dashboards: [] }, ...);
 *
 * On first render the sentinel was captured as baseline. When the
 * async GET resolved and `config` flipped from null to the real DTO,
 * the hook saw a value-change and fired a debounced PUT — saving the
 * server's own response right back at it. For owners/editors the
 * round-trip was wasted bandwidth; for viewers the PUT 403d (every
 * sidecar's PUT endpoint requires editor role) and the user saw a
 * "Request failed: 403 Forbidden" banner on every vault open. The
 * null-skip rule fixes it at the hook layer so all three sidecars
 * (startpage / assignments / note-widgets) inherit the fix.
 */
export function useDebouncedSave<T>(
  value: T | null | undefined,
  delayMs: number,
  save: (v: T) => void,
): void {
  const saveRef = useRef(save);
  saveRef.current = save;

  // Track the last value we saved, so we don't fire on the first
  // render or on values that match what we've already sent.
  const lastSavedRef = useRef<string | null>(null);

  // The edit waiting for the debounce, with the save closure that
  // belongs to it (see the flush note in the header).
  const pendingRef = useRef<{ value: T; serialized: string; save: (v: T) => void } | null>(null);
  const timerRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const p = pendingRef.current;
    if (!p) return;
    pendingRef.current = null;
    p.save(p.value);
    lastSavedRef.current = p.serialized;
  }, []);

  useEffect(() => {
    // Not-loaded-yet state (or the host switched resources, e.g.
    // VaultLayout's useDashboards instance staying mounted across a
    // vault switch → setConfig(null)). Flush anything pending for
    // the PREVIOUS resource, then clear the baseline so the next
    // resource's first non-null value becomes its baseline instead
    // of looking like a user edit (which used to fire a PUT that
    // 403d for viewers).
    if (value === null || value === undefined) {
      flush();
      lastSavedRef.current = null;
      return;
    }

    const serialized = JSON.stringify(value);

    // First non-null value: capture as "already saved" and skip the
    // network call (the GET's own response, or a component that
    // passes a non-null T on every render).
    if (lastSavedRef.current === null) {
      lastSavedRef.current = serialized;
      return;
    }
    // Back to what's already saved (e.g. an edit undone within the
    // debounce window): drop the pending save.
    if (lastSavedRef.current === serialized) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = null;
      return;
    }

    // Debounce: the last value to land before the user pauses fires.
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    pendingRef.current = { value, serialized, save: saveRef.current };
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      flush();
    }, delayMs);
  }, [value, delayMs, flush]);

  // Unmount: fire, don't drop.
  useEffect(() => () => flush(), [flush]);

  // Tab hidden (switching apps, closing the tab, phone screen off):
  // fire now rather than hoping the debounce runs later.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === 'hidden') flush();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [flush]);
}
