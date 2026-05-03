import { useEffect, useState } from 'react';

import { SaveStatusBadge, type FieldSaveState } from './SaveStatusBadge';

/**
 * Per-note appearance controls, rendered inside the properties panel.
 *
 *   - Font: <select> over a curated list of system fonts. We send a
 *     full font-family stack ("Inter, system-ui, sans-serif") rather
 *     than just the head name, so notes whose top-choice font isn't
 *     installed locally still pick something sensible.
 *   - Font size: <input type=number> in px (10–32). Empty = default.
 *   - Width: <input type=number> in px, ≥ 700, step 50. Empty = default.
 *
 * Each field auto-saves on blur (or Enter) by calling onSave. The
 * parent owns the API call and refreshTick bump.
 *
 * Saves are independent per-field — changing the font doesn't push
 * the size or width back to the server. That keeps blur-triggered
 * saves from stomping a half-typed value in another field.
 *
 * To clear a value, blank the input and blur (or pick "Default" in
 * the font select). The save handler sends the empty/0 sentinel to
 * the API, which the codec interprets as "remove this key from the
 * frontmatter".
 */

/**
 * Curated font list. Each entry has:
 *   - id: stable identifier saved in frontmatter (matches one of the
 *     options in the select)
 *   - label: what the user sees in the dropdown
 *   - stack: full CSS font-family value — the FIRST family is what
 *     shows up if the user has it installed; later families are
 *     fallbacks for systems missing the head font.
 *
 * "Default" is special — it sends an empty string, which the server
 * interprets as "clear this field". The editor then falls back to
 * whatever the CSS default is (system-ui from styles.css).
 */
export const FONT_OPTIONS: ReadonlyArray<{
  id: string;
  label: string;
  stack: string;
}> = [
  { id: '', label: 'Default', stack: '' },
  { id: 'inter', label: 'Inter', stack: 'Inter, system-ui, sans-serif' },
  { id: 'segoe', label: 'Segoe UI', stack: '"Segoe UI", system-ui, sans-serif' },
  { id: 'arial', label: 'Arial', stack: 'Arial, Helvetica, sans-serif' },
  { id: 'georgia', label: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
  { id: 'cambria', label: 'Cambria', stack: 'Cambria, Georgia, serif' },
  { id: 'consolas', label: 'Consolas', stack: 'Consolas, "Courier New", monospace' },
  { id: 'jetbrains', label: 'JetBrains Mono', stack: '"JetBrains Mono", Consolas, monospace' },
  { id: 'roboto-mono', label: 'Roboto Mono', stack: '"Roboto Mono", Consolas, monospace' },
];

/**
 * Map a stored font stack value back to the option id, so the <select>
 * shows the right entry on load. We match by the stack string verbatim
 * because that's what gets persisted. If a note has a manually-edited
 * frontmatter with an unknown stack, the select shows "Default" and
 * the editor still applies the custom stack via inline style.
 */
export function fontStackToId(stack: string | null | undefined): string {
  if (!stack) return '';
  const match = FONT_OPTIONS.find((f) => f.stack === stack);
  return match?.id ?? '';
}

const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 32;
const WIDTH_MIN = 700;
const WIDTH_STEP = 50;

export interface EditableNoteAppearanceProps {
  font: string | null;
  fontSize: number | null;
  width: number | null;
  onSaveFont: (stack: string) => Promise<void>;
  onSaveFontSize: (size: number) => Promise<void>;
  onSaveWidth: (w: number) => Promise<void>;
}

export function EditableNoteAppearance({
  font,
  fontSize,
  width,
  onSaveFont,
  onSaveFontSize,
  onSaveWidth,
}: EditableNoteAppearanceProps) {
  return (
    <>
      <FontField value={font} onSave={onSaveFont} />
      <NumberField
        label="Font size"
        value={fontSize}
        min={FONT_SIZE_MIN}
        max={FONT_SIZE_MAX}
        step={1}
        placeholder="default"
        unit="px"
        onSave={onSaveFontSize}
      />
      <NumberField
        label="Width"
        value={width}
        min={WIDTH_MIN}
        step={WIDTH_STEP}
        placeholder="700"
        unit="px"
        onSave={onSaveWidth}
        snap
      />
    </>
  );
}

// ---------------------------------------------------- Font select

function FontField({
  value,
  onSave,
}: {
  value: string | null;
  onSave: (stack: string) => Promise<void>;
}) {
  const [state, setState] = useState<FieldSaveState>({ kind: 'idle' });

  // Derive the dropdown's selected id from the stored stack. This is
  // a controlled <select> driven by the prop — when the parent
  // refetches after save and `value` changes, the select follows.
  const selectedId = fontStackToId(value);

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.currentTarget.value;
    const opt = FONT_OPTIONS.find((f) => f.id === id);
    if (!opt) return;
    setState({ kind: 'saving' });
    try {
      await onSave(opt.stack);
      setState({ kind: 'saved' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed.';
      setState({ kind: 'error', message });
    }
  }

  return (
    <>
      <dt>Font</dt>
      <dd>
        <div className="nc-prop-editable">
          <select
            className="nc-prop-input"
            value={selectedId}
            onChange={(e) => {
              void handleChange(e);
            }}
            disabled={state.kind === 'saving'}
            aria-label="Note font"
          >
            {FONT_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
          <SaveStatusBadge
            state={state}
            onFade={() => setState({ kind: 'idle' })}
          />
        </div>
      </dd>
    </>
  );
}

// ---------------------------------------------------- Number field

interface NumberFieldProps {
  label: string;
  value: number | null;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  unit?: string;
  /** When true, blank-out empty input + snap value to nearest step. */
  snap?: boolean;
  onSave: (n: number) => Promise<void>;
}

/**
 * Generic number input with blur-to-save. Empty input → 0 sent to the
 * server, which interprets as "clear this field".
 *
 * We keep a local string draft so the user can type freely (incl.
 * empty, partial). On blur or Enter we parse + clamp + save. If the
 * parent's stored value changes (e.g. after a refetch) we sync the
 * draft so the displayed text matches.
 */
function NumberField({
  label,
  value,
  min,
  max,
  step,
  placeholder,
  unit,
  snap,
  onSave,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string>(value === null ? '' : String(value));
  const [state, setState] = useState<FieldSaveState>({ kind: 'idle' });

  // When the persisted value changes externally, sync the draft so
  // the input shows the new value. Skip syncing while we're mid-save
  // to avoid clobbering the user's in-progress typing.
  useEffect(() => {
    if (state.kind === 'saving') return;
    setDraft(value === null ? '' : String(value));
  }, [value, state.kind]);

  function clampSnap(n: number): number {
    let out = n;
    if (typeof min === 'number' && out < min) out = min;
    if (typeof max === 'number' && out > max) out = max;
    if (snap && step && step > 0 && typeof min === 'number') {
      out = Math.round((out - min) / step) * step + min;
    }
    return out;
  }

  async function commit() {
    const trimmed = draft.trim();
    if (trimmed === '') {
      // Empty = clear. Server interprets 0 as "remove the key".
      if (value === null) return; // already clear, no-op
      setState({ kind: 'saving' });
      try {
        await onSave(0);
        setState({ kind: 'saved' });
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Save failed.';
        setState({ kind: 'error', message });
      }
      return;
    }

    const parsed = parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
      // Invalid — revert draft to the last good value.
      setDraft(value === null ? '' : String(value));
      return;
    }
    const clamped = clampSnap(parsed);
    setDraft(String(clamped)); // reflect clamping back into the input
    if (clamped === value) return; // no-op
    setState({ kind: 'saving' });
    try {
      await onSave(clamped);
      setState({ kind: 'saved' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Save failed.';
      setState({ kind: 'error', message });
    }
  }

  return (
    <>
      <dt>{label}</dt>
      <dd>
        <div className="nc-prop-editable">
          <input
            type="number"
            className="nc-prop-input nc-prop-input-number"
            value={draft}
            min={min}
            max={max}
            step={step}
            placeholder={placeholder}
            disabled={state.kind === 'saving'}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={() => {
              void commit();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur(); // triggers onBlur → commit
              } else if (e.key === 'Escape') {
                setDraft(value === null ? '' : String(value));
                e.currentTarget.blur();
              }
            }}
            aria-label={label}
          />
          {unit && <span className="nc-prop-unit">{unit}</span>}
          <SaveStatusBadge
            state={state}
            onFade={() => setState({ kind: 'idle' })}
          />
        </div>
      </dd>
    </>
  );
}
