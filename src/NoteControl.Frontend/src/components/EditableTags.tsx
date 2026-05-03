import { useEffect, useRef, useState } from 'react';

import { SaveStatusBadge, type FieldSaveState } from './SaveStatusBadge';

/**
 * Tag editor — existing tags render as chips with × buttons; an input
 * at the end accepts a new tag (Enter or comma to commit).
 *
 * Each add/remove triggers a save. Tags are normalised:
 *   - trim whitespace
 *   - lowercase
 *   - drop empty strings
 *   - dedupe (case-insensitive)
 *
 * "Save" means PUT the whole note with the new tags array. We send
 * the entire array each time rather than diffing — simpler, and the
 * server uses ETag to catch concurrent edits.
 */
export interface EditableTagsProps {
  tags: readonly string[];
  disabled?: boolean;
  /** Save the new full tags array. Caller wires to notesApi.update. */
  onSave: (tags: string[]) => Promise<void>;
}

export function EditableTags({ tags, disabled, onSave }: EditableTagsProps) {
  const [draftInput, setDraftInput] = useState('');
  const [state, setState] = useState<FieldSaveState>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);

  // The displayed tags are the prop directly — mutations call onSave
  // and we let the parent re-fetch and re-pass. We don't keep a local
  // copy because that would risk drift.

  // Reset transient input state when the underlying tag set changes.
  useEffect(() => {
    setDraftInput('');
    setState({ kind: 'idle' });
  }, [tags]);

  function normalise(raw: string): string {
    return raw.trim().toLowerCase();
  }

  function dedupe(arr: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const t of arr) {
      const k = t.toLowerCase();
      if (!seen.has(k) && t.length > 0) {
        seen.add(k);
        result.push(t);
      }
    }
    return result;
  }

  async function commitTags(next: string[]) {
    setState({ kind: 'saving' });
    try {
      await onSave(next);
      setState({ kind: 'saved' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Save failed.';
      setState({ kind: 'error', message });
    }
  }

  async function addTag(raw: string) {
    const t = normalise(raw);
    if (!t) return;
    if (tags.some((x) => x.toLowerCase() === t)) {
      // Dup — silently ignore + clear input.
      setDraftInput('');
      return;
    }
    const next = dedupe([...tags, t]);
    setDraftInput('');
    await commitTags(next);
  }

  async function removeTag(target: string) {
    const next = tags.filter((t) => t !== target);
    await commitTags(next);
  }

  return (
    <div className="nc-prop-editable nc-prop-tags">
      <div className="nc-tag-chips nc-tag-chips-editable">
        {tags.length === 0 && draftInput.length === 0 && (
          <span className="nc-fg-muted">No tags yet.</span>
        )}
        {tags.map((t) => (
          <span key={t} className="nc-tag-chip nc-tag-chip-removable">
            {t}
            <button
              type="button"
              className="nc-tag-chip-remove"
              onClick={() => {
                if (!disabled) void removeTag(t);
              }}
              disabled={disabled || state.kind === 'saving'}
              aria-label={`Remove tag ${t}`}
              title={`Remove tag ${t}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          className="nc-tag-input"
          value={draftInput}
          disabled={disabled || state.kind === 'saving'}
          placeholder={tags.length === 0 ? 'Add tag…' : '+'}
          onChange={(e) => {
            setDraftInput(e.target.value);
            if (state.kind === 'error') setState({ kind: 'idle' });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              void addTag(draftInput);
            } else if (e.key === 'Backspace' && draftInput.length === 0 && tags.length > 0) {
              // Backspace on empty input removes the last tag —
              // matches GitHub-style chip pickers.
              void removeTag(tags[tags.length - 1]);
            }
          }}
          onBlur={() => {
            // Commit any unfinished input on blur.
            if (draftInput.trim()) {
              void addTag(draftInput);
            }
          }}
          aria-label="Add tag"
        />
      </div>
      <SaveStatusBadge
        state={state}
        onFade={() => setState({ kind: 'idle' })}
      />
    </div>
  );
}
