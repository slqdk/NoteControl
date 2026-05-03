import { useEffect, useRef } from 'react';

/**
 * Run a save callback every time `value` changes, but no sooner
 * than `delayMs` after the LAST change. Mirrors the standard
 * "save while typing" pattern: rapid edits coalesce into one
 * server call when the user pauses.
 *
 * Step 40 uses this for the per-vault startpage config — every
 * drag, resize, and popup tweak mutates the in-memory blocks
 * array, but we only PUT to the server when typing stops.
 *
 * Behaviour notes:
 *   - The first render does NOT trigger a save. We assume the
 *     initial `value` came from the server (or initial empty
 *     state) and saving it back would be a no-op churn.
 *   - On unmount, any pending save is cancelled. If you need
 *     "flush on unmount," do that explicitly at the call site
 *     before unmount; the hook intentionally doesn't to keep
 *     the contract simple.
 *   - `save` is not in the dependency array. We capture the
 *     latest `save` via a ref so callers don't have to memoise
 *     it; otherwise every re-render with a fresh closure would
 *     reschedule the timer.
 *
 * Comparison via JSON.stringify is fine for the small POJO we
 * use it for; for bigger objects swap to a deep-equal lib.
 */
export function useDebouncedSave<T>(
  value: T,
  delayMs: number,
  save: (v: T) => void,
): void {
  const saveRef = useRef(save);
  saveRef.current = save;

  // Track the last value we saved, so we don't fire on the first
  // render or on values that match what we've already sent.
  const lastSavedRef = useRef<string | null>(null);

  useEffect(() => {
    const serialized = JSON.stringify(value);

    // First render: capture the initial value as "already saved"
    // and skip the network call.
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
