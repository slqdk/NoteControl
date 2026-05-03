import { useState } from 'react';

import { SaveStatusBadge, type FieldSaveState } from './SaveStatusBadge';

/**
 * Locked toggle. Sends an UpdateNoteRequest with just the new locked
 * value flipped. The server treats null fields in UpdateNoteRequest
 * as "leave alone", so we can update one frontmatter field in
 * isolation without touching tags or body.
 *
 * Render-wise: just a checkbox (no "Yes"/"No" label — the checkbox
 * itself communicates state, and the surrounding "Locked" dt label
 * gives context).
 */
export interface EditableLockedProps {
  value: boolean;
  disabled?: boolean;
  onSave: (locked: boolean) => Promise<void>;
}

export function EditableLocked({ value, disabled, onSave }: EditableLockedProps) {
  const [state, setState] = useState<FieldSaveState>({ kind: 'idle' });

  async function toggle() {
    const next = !value;
    setState({ kind: 'saving' });
    try {
      await onSave(next);
      setState({ kind: 'saved' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Save failed.';
      setState({ kind: 'error', message });
    }
  }

  return (
    <div className="nc-prop-editable">
      <input
        type="checkbox"
        className="nc-prop-checkbox-only"
        checked={value}
        disabled={disabled || state.kind === 'saving'}
        onChange={() => {
          void toggle();
        }}
        aria-label="Locked"
      />
      <SaveStatusBadge
        state={state}
        onFade={() => setState({ kind: 'idle' })}
      />
    </div>
  );
}
