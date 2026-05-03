import { useEffect, useState } from 'react';

/**
 * Inline status badge for an editable field.
 *
 *   idle     — render nothing
 *   saving   — small spinner-ish text
 *   saved    — short success ping that fades after a couple of seconds
 *   error    — red text with the message; doesn't auto-clear
 *
 * The "saved" state auto-transitions back to idle after FADE_AFTER_MS.
 * That's a UX nicety from the main editor's SaveStatusIndicator —
 * users see a moment of confirmation, then the chrome quiets down.
 */
export type FieldSaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

const FADE_AFTER_MS = 1800;

export interface SaveStatusBadgeProps {
  state: FieldSaveState;
  /** Called when "saved" fades back to idle so the parent can match. */
  onFade?: () => void;
}

export function SaveStatusBadge({ state, onFade }: SaveStatusBadgeProps) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setHidden(false);
    if (state.kind === 'saved') {
      const t = setTimeout(() => {
        setHidden(true);
        onFade?.();
      }, FADE_AFTER_MS);
      return () => clearTimeout(t);
    }
  }, [state, onFade]);

  if (state.kind === 'idle' || hidden) {
    return null;
  }

  if (state.kind === 'saving') {
    return <span className="nc-field-status nc-field-status-saving">Saving…</span>;
  }
  if (state.kind === 'saved') {
    return <span className="nc-field-status nc-field-status-saved">Saved</span>;
  }
  return (
    <span
      className="nc-field-status nc-field-status-error"
      title={state.message}
    >
      Error
    </span>
  );
}
