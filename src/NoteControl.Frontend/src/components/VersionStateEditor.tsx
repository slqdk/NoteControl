import { useEffect, useState } from 'react';

import type { ReleaseInfo } from '../api/types';
import { formatNoteTimestamp } from '../utils/time';
import { SaveStatusBadge, type FieldSaveState } from './SaveStatusBadge';

/**
 * Per-note version + lifecycle-state editor for the Properties panel.
 *
 * Replaces the old free-text version field. A note's version is now two
 * integers (major / minor) edited via number inputs with +/- steppers,
 * and a lifecycle state:
 *
 *   - version 0.0            -> "Not versioned" (derived, not selectable).
 *   - any version > 0.0      -> "Under development".
 *   - version >= 1.0         -> "Released" becomes selectable.
 *
 * Rules mirrored from the server (which enforces them and 400s on a
 * violation, so the UI is a convenience, not the source of truth):
 *   - the version is monotonic — neither component can drop the pair
 *     below its current value;
 *   - "Released" requires version >= 1.0.
 *
 * State changes between development and released drive the server's
 * release-copy swap: switching to Released recalls the single frozen
 * release; switching back to Development restores the parked working
 * copy. The recall info line surfaces that a frozen release exists.
 *
 * The component owns only draft + save-status state. The parent wires
 * onSave to a notesApi.update call and refetches the note (+ release
 * info) afterwards, which flows back in as new props.
 */
export interface VersionStatePatch {
  versionMajor?: number;
  versionMinor?: number;
  state?: string;
}

export interface VersionStateEditorProps {
  major: number;
  minor: number;
  /** "not-versioned" | "development" | "released" */
  state: string;
  /** Frozen-release info for the recall line; null while loading. */
  release: ReleaseInfo | null;
  disabled?: boolean;
  onSave: (patch: VersionStatePatch) => Promise<void>;
}

const STATE_DEVELOPMENT = 'development';
const STATE_RELEASED = 'released';
const STATE_NOT_VERSIONED = 'not-versioned';

export function VersionStateEditor({
  major,
  minor,
  state,
  release,
  disabled,
  onSave,
}: VersionStateEditorProps) {
  const [draftMajor, setDraftMajor] = useState(major);
  const [draftMinor, setDraftMinor] = useState(minor);
  const [saveState, setSaveState] = useState<FieldSaveState>({ kind: 'idle' });

  // Resync drafts when the persisted version changes (selection moved, or
  // a save bumped what's canonical).
  useEffect(() => {
    setDraftMajor(major);
    setDraftMinor(minor);
  }, [major, minor]);

  const busy = disabled || saveState.kind === 'saving';
  const isZero = major === 0 && minor === 0;

  // Monotonic floors. If the draft major is above the persisted major,
  // the minor floor drops to 0; otherwise the minor can't go below the
  // persisted minor.
  const minorFloor = draftMajor > major ? 0 : minor;

  function clampPair(m: number, n: number): [number, number] {
    let cm = Math.max(0, Math.floor(m));
    if (cm < major) cm = major;
    let cn = Math.max(0, Math.floor(n));
    const floor = cm > major ? 0 : minor;
    if (cn < floor) cn = floor;
    return [cm, cn];
  }

  async function commitVersion(m: number, n: number) {
    const [cm, cn] = clampPair(m, n);
    setDraftMajor(cm);
    setDraftMinor(cn);
    if (cm === major && cn === minor) {
      setSaveState({ kind: 'idle' });
      return;
    }
    setSaveState({ kind: 'saving' });
    try {
      await onSave({ versionMajor: cm, versionMinor: cn });
      setSaveState({ kind: 'saved' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Save failed.';
      setSaveState({ kind: 'error', message });
      // Snap drafts back to canonical so the inputs don't show a value
      // the server rejected.
      setDraftMajor(major);
      setDraftMinor(minor);
    }
  }

  async function commitState(next: string) {
    if (next === state) return;
    setSaveState({ kind: 'saving' });
    try {
      await onSave({ state: next });
      setSaveState({ kind: 'saved' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Save failed.';
      setSaveState({ kind: 'error', message });
    }
  }

  const releasedAllowed = draftMajor >= 1;

  return (
    <div className="nc-version">
      <div className="nc-version-numbers">
        <Stepper
          label="Major"
          value={draftMajor}
          min={major}
          disabled={busy}
          onChange={(v) => {
            setDraftMajor(v);
            // Bumping the major resets the minor (semver-style): going
            // from 0.x up a major should land on M.0, not carry the old
            // minor up to M.x.
            if (v > major) setDraftMinor(0);
          }}
          onStep={(v) => void commitVersion(v, 0)}
          onCommit={() => void commitVersion(draftMajor, draftMinor)}
        />
        <span className="nc-version-dot">.</span>
        <Stepper
          label="Minor"
          value={draftMinor}
          min={minorFloor}
          disabled={busy}
          onChange={(v) => setDraftMinor(v)}
          onStep={(v) => void commitVersion(draftMajor, v)}
          onCommit={() => void commitVersion(draftMajor, draftMinor)}
        />
        <SaveStatusBadge
          state={saveState}
          onFade={() => setSaveState({ kind: 'idle' })}
        />
      </div>

      <div className="nc-version-state">
        {isZero ? (
          <span className="nc-version-state-label nc-version-state-none">
            Not versioned
          </span>
        ) : (
          <select
            className="nc-prop-input nc-version-state-select"
            value={state === STATE_NOT_VERSIONED ? STATE_DEVELOPMENT : state}
            disabled={busy}
            aria-label="State"
            onChange={(e) => void commitState(e.target.value)}
          >
            <option value={STATE_DEVELOPMENT}>Under development</option>
            <option value={STATE_RELEASED} disabled={!releasedAllowed}>
              Released{releasedAllowed ? '' : ' (needs v1.0+)'}
            </option>
          </select>
        )}
      </div>

      {release?.exists && (
        <div className="nc-version-recall">
          <span className="nc-version-recall-info">
            Released v{release.versionMajor}.{release.versionMinor}
            {release.savedAt ? ` · ${formatNoteTimestamp(release.savedAt)}` : ''}
          </span>
          {state === STATE_RELEASED ? (
            release.developmentStashed ? (
              <span className="nc-version-recall-hint">
                Showing the released copy — switch to Under development to
                return to your working copy.
              </span>
            ) : null
          ) : (
            <button
              type="button"
              className="nc-version-recall-btn"
              disabled={busy}
              onClick={() => void commitState(STATE_RELEASED)}
              title="Recall the frozen released copy into the note"
            >
              Recall released version
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface StepperProps {
  label: string;
  value: number;
  min: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  onStep: (v: number) => void;
  onCommit: () => void;
}

function Stepper({ label, value, min, disabled, onChange, onStep, onCommit }: StepperProps) {
  return (
    <span className="nc-version-stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="nc-version-step"
        disabled={disabled || value <= min}
        aria-label={`Decrease ${label}`}
        onClick={() => onStep(Math.max(min, value - 1))}
      >
        −
      </button>
      <input
        type="number"
        className="nc-prop-input nc-version-input"
        value={value}
        min={min}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          onChange(Number.isNaN(n) ? 0 : n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        onBlur={onCommit}
      />
      <button
        type="button"
        className="nc-version-step"
        disabled={disabled}
        aria-label={`Increase ${label}`}
        onClick={() => onStep(value + 1)}
      >
        +
      </button>
    </span>
  );
}
