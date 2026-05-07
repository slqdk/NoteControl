import type { CSSProperties } from 'react';

/**
 * Possible states for the auto-save lifecycle. Kept here so NoteEditor
 * and the indicator share one definition.
 *
 * State machine:
 *   idle      - initial, nothing typed yet, nothing pending
 *   dirty     - user has typed; debounce timer is armed
 *   saving    - PUT in flight
 *   saved     - last save succeeded
 *   error     - last save failed for a recoverable reason; clicking
 *               Retry triggers a fresh attempt, and any further edit
 *               also re-arms the debounce
 *   conflict  - server returned 412; user must reload to recover
 */
export type SaveState =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }
  | { kind: 'conflict'; message: string };

const styles: Record<string, CSSProperties> = {
  base: {
    fontSize: 12,
    fontFamily: 'system-ui, sans-serif',
    color: '#64748b',
    padding: '4px 8px',
    minHeight: 20,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
  },
  dirty: { color: '#a16207' },
  saving: { color: '#1d4ed8' },
  saved: { color: '#16a34a' },
  // Error / conflict are far more visually loud than they used to be -
  // the user said they were missing failures completely. Background
  // tint + bold weight makes the chip impossible to glance over.
  error: {
    color: '#991b1b',
    background: '#fee2e2',
    border: '1px solid #fecaca',
    borderRadius: 4,
    fontWeight: 600,
  },
  conflict: {
    color: '#991b1b',
    background: '#fee2e2',
    border: '1px solid #fecaca',
    borderRadius: 4,
    fontWeight: 700,
  },
  retryBtn: {
    fontSize: 11,
    fontFamily: 'inherit',
    color: '#991b1b',
    background: 'transparent',
    border: '1px solid #991b1b',
    borderRadius: 3,
    padding: '1px 6px',
    cursor: 'pointer',
    fontWeight: 600,
  },
};

export interface SaveStatusIndicatorProps {
  state: SaveState;
  /**
   * Optional manual-retry callback. Wired by the host (NoteEditor)
   * to a saveNow() that bypasses the debounce. Only meaningful when
   * the state is `error`; ignored otherwise. We deliberately do NOT
   * surface a retry for `conflict` - conflict needs a page reload,
   * and offering a button that just re-fails is misleading.
   */
  onRetry?: () => void;
}

export function SaveStatusIndicator({ state, onRetry }: SaveStatusIndicatorProps) {
  switch (state.kind) {
    case 'idle':
      return <div style={styles.base}>&nbsp;</div>;
    case 'dirty':
      return <div style={{ ...styles.base, ...styles.dirty }}>Unsaved changes...</div>;
    case 'saving':
      return <div style={{ ...styles.base, ...styles.saving }}>Saving...</div>;
    case 'saved':
      return <div style={{ ...styles.base, ...styles.saved }}>Saved</div>;
    case 'error':
      return (
        <div style={{ ...styles.base, ...styles.error }} title={state.message}>
          <span>{'\u26A0'} Save failed</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              style={styles.retryBtn}
              title="Try saving again now"
            >
              Retry
            </button>
          )}
        </div>
      );
    case 'conflict':
      return (
        <div style={{ ...styles.base, ...styles.conflict }} title={state.message}>
          <span>{'\u26A0'} Conflict - reload required</span>
        </div>
      );
  }
}
