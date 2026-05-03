import { useEffect, useRef, useState } from 'react';

import { SaveStatusBadge, type FieldSaveState } from './SaveStatusBadge';

/**
 * Inline-editable name field. Pattern:
 *   - displays the current name as a regular text input
 *   - typing changes the local draft
 *   - blur or Enter commits via onSave
 *   - Escape reverts the draft to the last-known-good value
 *
 * The component doesn't decide what "save" means — the caller wires
 * onSave to either notesApi.move (for note rename) or foldersApi.move
 * (for folder rename). Same UX either way.
 *
 * Validation:
 *   - non-empty after trim
 *   - no slash characters (those would change the parent folder, which
 *     this field doesn't do; that's a future "Move to…" action)
 *   - no "." or ".." (reserved)
 *   - no-op when unchanged from initial value
 */
export interface EditableNameProps {
  /** Current name shown when not editing. Caller-canonical. */
  value: string;
  disabled?: boolean;
  onSave: (newName: string) => Promise<void>;
}

export function EditableName({ value, disabled, onSave }: EditableNameProps) {
  const [draft, setDraft] = useState(value);
  const [state, setState] = useState<FieldSaveState>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);

  // When the underlying value changes (e.g. selection moves to a
  // different note, or a successful save bumped the canonical name),
  // resync the draft.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  function validate(v: string): string | null {
    const trimmed = v.trim();
    if (!trimmed) return 'Name is required.';
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      return 'Name cannot contain slashes.';
    }
    if (trimmed === '.' || trimmed === '..') {
      return 'Reserved name.';
    }
    return null;
  }

  async function commit() {
    const trimmed = draft.trim();
    if (trimmed === value) {
      // No-op rename. Reset any leftover error state.
      setState({ kind: 'idle' });
      setDraft(value);
      return;
    }

    const err = validate(draft);
    if (err) {
      setState({ kind: 'error', message: err });
      return;
    }

    setState({ kind: 'saving' });
    try {
      await onSave(trimmed);
      setState({ kind: 'saved' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Save failed.';
      setState({ kind: 'error', message });
      // Leave the draft as-is so the user can fix it without retyping.
    }
  }

  return (
    <div className="nc-prop-editable">
      <input
        ref={inputRef}
        type="text"
        className="nc-prop-input"
        value={draft}
        disabled={disabled || state.kind === 'saving'}
        onChange={(e) => {
          setDraft(e.target.value);
          if (state.kind === 'error') setState({ kind: 'idle' });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();    // triggers onBlur → commit
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(value);
            setState({ kind: 'idle' });
            (e.target as HTMLInputElement).blur();
          }
        }}
        onBlur={() => {
          void commit();
        }}
        aria-label="Name"
      />
      <SaveStatusBadge
        state={state}
        onFade={() => setState({ kind: 'idle' })}
      />
    </div>
  );
}
