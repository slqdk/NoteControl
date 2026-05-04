import { useEffect, useRef, useState } from 'react';

import { SaveStatusBadge, type FieldSaveState } from './SaveStatusBadge';

/**
 * Ship 68: inline-editable note version field. Shape and UX mirror
 * EditableName:
 *   - displays the current value as a regular text input
 *   - typing changes the local draft
 *   - blur or Enter commits via onSave
 *   - Escape reverts the draft
 *
 * Differences from EditableName:
 *   - free-text — the user picks the format ("v0.0", "1.2.3-rc1",
 *     "draft", "PRJ-22.A"). No slash-or-dot validation.
 *   - empty string is allowed: the server treats it as "reset to
 *     default v0.0" rather than "delete". The UI surfaces this
 *     by showing whatever the server returns (which will be v0.0
 *     after such a save).
 *
 * The component doesn't decide what "save" means — caller wires
 * onSave to a notesApi.update call. That update sets `version` on
 * the request and the server merges it into the note's
 * frontmatter on next disk write.
 */
export interface EditableVersionProps {
  /** Current version string. Caller-canonical; server-derived. */
  value: string;
  disabled?: boolean;
  onSave: (newVersion: string) => Promise<void>;
}

export function EditableVersion({ value, disabled, onSave }: EditableVersionProps) {
  const [draft, setDraft] = useState(value);
  const [state, setState] = useState<FieldSaveState>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);

  // Resync the draft when the underlying value changes (selection
  // moves to a different note, or a successful save bumped what's
  // canonical). Same pattern EditableName uses.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  async function commit() {
    // Trim whitespace before comparing — "  v1.0  " typed by accident
    // shouldn't be saved verbatim and shouldn't trigger a no-op
    // round-trip if the server already has "v1.0".
    const trimmed = draft.trim();
    if (trimmed === value) {
      // No-op. Reset error state and snap back to canonical (drops
      // any leading/trailing whitespace in the draft).
      setState({ kind: 'idle' });
      setDraft(value);
      return;
    }

    setState({ kind: 'saving' });
    try {
      // Send the trimmed value. The server's empty-string semantics
      // (-> reset to v0.0) are intact: an empty trimmed string here
      // means the user actually cleared the field, and the server
      // will respond by writing v0.0 back. We rely on the parent's
      // refreshTick to re-read and update `value`, which our
      // useEffect above will then sync into draft.
      await onSave(trimmed);
      setState({ kind: 'saved' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Save failed.';
      setState({ kind: 'error', message });
      // Leave the draft as-is so the user can correct without retyping.
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
        aria-label="Version"
        // Modest character cap matches typical version strings.
        // Not strictly enforced server-side (free text, no length
        // validation), but a 64-char input keeps the panel layout
        // stable when someone pastes something unreasonable.
        maxLength={64}
        // Inline-styled placeholder so the field doesn't feel
        // empty when the user clears it mid-edit. Once they blur,
        // the server normalises and our useEffect resyncs.
        placeholder="v0.0"
      />
      <SaveStatusBadge
        state={state}
        onFade={() => setState({ kind: 'idle' })}
      />
    </div>
  );
}
