import type { CSSProperties } from 'react';

/**
 * Possible states for the auto-save lifecycle. Kept here so NoteEditor
 * and the indicator share one definition.
 *
 * State machine:
 *   idle      — initial, nothing typed yet, nothing pending
 *   dirty     — user has typed; debounce timer is armed
 *   saving    — PUT in flight
 *   saved     — last save succeeded
 *   error     — last save failed for a recoverable reason; will retry
 *               on next edit
 *   conflict  — server returned 412; user must reload to recover
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
  },
  dirty: { color: '#a16207' },
  saving: { color: '#1d4ed8' },
  saved: { color: '#16a34a' },
  error: { color: '#b91c1c' },
  conflict: { color: '#b91c1c', fontWeight: 600 },
};

export function SaveStatusIndicator({ state }: { state: SaveState }) {
  switch (state.kind) {
    case 'idle':
      return <div style={styles.base}>&nbsp;</div>;
    case 'dirty':
      return <div style={{ ...styles.base, ...styles.dirty }}>Unsaved changes…</div>;
    case 'saving':
      return <div style={{ ...styles.base, ...styles.saving }}>Saving…</div>;
    case 'saved':
      return <div style={{ ...styles.base, ...styles.saved }}>Saved</div>;
    case 'error':
      return (
        <div style={{ ...styles.base, ...styles.error }} title={state.message}>
          Save failed — will retry
        </div>
      );
    case 'conflict':
      return (
        <div style={{ ...styles.base, ...styles.conflict }} title={state.message}>
          Conflict: reload required
        </div>
      );
  }
}
