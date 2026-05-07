import type { CSSProperties } from 'react';

/**
 * Modal shown when the user tries to navigate away from a note
 * but the click-away save failed. Two choices:
 *
 *   "Stay and retry" - close the modal without navigating; the
 *                      caller (EditorPage's guard) reports 'block'
 *                      so the navigate(...) call short-circuits.
 *                      The user stays on the current note with
 *                      their unsaved text intact and can press the
 *                      Retry button on the badge (or just keep
 *                      typing) to try again.
 *
 *   "Discard and leave" - close the modal and proceed with the
 *                         original navigation. The unsaved text
 *                         is lost. This is a deliberate choice;
 *                         the user has been told the save failed
 *                         and elected to walk away anyway.
 *
 * No "Cancel" button - "Stay and retry" IS the cancel.
 *
 * Styling: inline styles to match the project convention used by
 * SaveStatusIndicator. The rest of the UI uses styles.css classes,
 * but introducing a one-off CSS block for this modal would mean
 * extending styles.css; keeping it self-contained here is easier
 * to remove if the modal is ever replaced by a shared dialog
 * primitive.
 */

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.5)',
    zIndex: 3000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  card: {
    background: '#ffffff',
    color: '#0f172a',
    borderRadius: 8,
    boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)',
    maxWidth: 480,
    width: '100%',
    padding: 20,
    fontFamily: 'system-ui, sans-serif',
    fontSize: 14,
  },
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 700,
    color: '#991b1b',
  },
  body: {
    marginTop: 12,
    lineHeight: 1.5,
    color: '#334155',
  },
  reason: {
    marginTop: 8,
    padding: '8px 10px',
    background: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: 4,
    fontSize: 13,
    color: '#7f1d1d',
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    wordBreak: 'break-word',
  },
  actions: {
    marginTop: 18,
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
  },
  btn: {
    fontSize: 13,
    fontFamily: 'inherit',
    padding: '6px 12px',
    borderRadius: 4,
    cursor: 'pointer',
    border: '1px solid transparent',
  },
  btnStay: {
    background: '#1d4ed8',
    color: '#ffffff',
    borderColor: '#1d4ed8',
    fontWeight: 600,
  },
  btnDiscard: {
    background: '#ffffff',
    color: '#991b1b',
    borderColor: '#fecaca',
  },
};

export interface SaveFailedDialogProps {
  /** Path of the note whose save failed (for the body text). */
  notePath: string;
  /** Human-readable reason from the API error. */
  reason: string;
  /** "Stay and retry" pressed - guard should report 'block'. */
  onStay: () => void;
  /** "Discard and leave" pressed - guard should report 'allow'. */
  onDiscard: () => void;
}

export function SaveFailedDialog({
  notePath,
  reason,
  onStay,
  onDiscard,
}: SaveFailedDialogProps) {
  // Click on the backdrop = same as Stay (the safer default; the
  // user is unlikely to want to discard their work via a stray
  // backdrop click). Click inside the card does NOT bubble out
  // because of the stopPropagation on the card's onClick.
  return (
    <div
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="nc-savefail-title"
      onClick={onStay}
    >
      <div style={styles.card} onClick={(e) => e.stopPropagation()}>
        <h2 id="nc-savefail-title" style={styles.title}>
          {'\u26A0'} Save failed
        </h2>
        <div style={styles.body}>
          <p style={{ margin: 0 }}>
            Your changes to <strong>{notePath}</strong> couldn&apos;t be saved.
            If you leave now, those changes will be lost.
          </p>
          <div style={styles.reason}>{reason}</div>
        </div>
        <div style={styles.actions}>
          <button
            type="button"
            style={{ ...styles.btn, ...styles.btnDiscard }}
            onClick={onDiscard}
          >
            Discard changes and leave
          </button>
          <button
            type="button"
            style={{ ...styles.btn, ...styles.btnStay }}
            onClick={onStay}
            autoFocus
          >
            Stay and retry
          </button>
        </div>
      </div>
    </div>
  );
}
