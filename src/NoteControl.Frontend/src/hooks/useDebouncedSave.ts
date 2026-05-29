import { useEffect, useRef } from 'react';

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
 *   - On unmount, any pending save is cancelled. If you need
 *     "flush on unmount," do that explicitly at the call site
 *     before unmount; the hook intentionally doesn't to keep
 *     the contract simple.
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

  useEffect(() => {
    // Not-loaded-yet state. Don't capture a baseline; don't save.
    // The first time we see a real value (after the async load
    // resolves), we'll capture THAT as the baseline below.
    if (value === null || value === undefined) {
      return;
    }

    const serialized = JSON.stringify(value);

    // First non-null value: capture as "already saved" and skip
    // the network call. Covers both:
    //   - components that pass a non-null T on every render (the
    //     original contract — first render is treated as baseline)
    //   - components that pass `null` while loading and the real
    //     T after the async GET resolves (so the loaded DTO becomes
    //     the baseline, not the result of a wasted save round-trip)
    if (lastSavedRef.current === null) {
      lastSavedRef.current = serialized;
      return;
    }
    // No change since last save — nothing to do.
    if (lastSavedRef.current === serialized) {
      return;
    }

    const handle = window.setTimeout(() => {
      saveRef.current(value);
      lastSavedRef.current = serialized;
    }, delayMs);

    return () => {
      // Each new value re-runs this effect; clearing the previous
      // timer is what gives us the debounce behaviour. The last
      // value to land before the user pauses is the one that
      // fires.
      window.clearTimeout(handle);
    };
  }, [value, delayMs]);
}
