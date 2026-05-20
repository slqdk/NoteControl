import { useEffect, type ReactNode } from 'react';

import type { ImportNoteEntry, ImportNoteResult } from '../api/client';

/**
 * Post-import summary modal. Extracted from the old
 * ImportNoteSplitButton (which has been replaced by the unified
 * RailHeaderAddMenu) so the modal can be reused by any caller
 * that runs notesApi.import — currently just RailHeaderAddMenu,
 * but keeping it as its own component leaves the door open for
 * other entry points (e.g. drag-and-drop import) without
 * duplicating the result UI.
 *
 * Two states:
 *   - error: the request itself failed (bad file type, 401, etc.).
 *     One message, dismissable.
 *   - result: per-entry outcomes. Always shown even on full success
 *     so the user gets confirmation of what landed and where —
 *     particularly useful when files were renamed because of
 *     conflicts.
 *
 * We don't reach for an existing modal helper because no shared
 * one exists in this codebase yet (PropertiesPanel rolls its own
 * confirm too). Keeping it inline so the component is one file.
 */
export interface ImportResultModalProps {
  error: string | null;
  result: ImportNoteResult | null;
  onClose: () => void;
}

export function ImportResultModal({ error, result, onClose }: ImportResultModalProps) {
  // Esc to close. Active while modal mounted.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="nc-import-modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        // Click the dim background (not the dialog itself) to close.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nc-import-modal">
        {error ? (
          <>
            <h2 className="nc-import-modal-title">Import failed</h2>
            <p className="nc-import-modal-error">{error}</p>
            <div className="nc-import-modal-actions">
              <button type="button" className="nc-btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : result ? (
          <>
            <h2 className="nc-import-modal-title">
              Import finished
            </h2>
            <p className="nc-import-modal-summary">
              {summary(result)}
            </p>

            {result.entries.length > 0 && (
              <ul className="nc-import-modal-list">
                {result.entries.map((entry, idx) => (
                  <li key={idx} className={`nc-import-entry nc-import-entry-${entry.outcome}`}>
                    <span className="nc-import-entry-outcome">
                      {outcomeBadge(entry.outcome)}
                    </span>
                    <span className="nc-import-entry-paths">
                      {renderEntryPath(entry)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="nc-import-modal-actions">
              <button type="button" className="nc-btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function summary(r: ImportNoteResult): string {
  const parts: string[] = [];
  if (r.created > 0) parts.push(`${r.created} created`);
  if (r.renamed > 0) parts.push(`${r.renamed} renamed (conflict)`);
  if (r.skipped > 0) parts.push(`${r.skipped} skipped`);
  if (r.failed > 0) parts.push(`${r.failed} failed`);
  if (parts.length === 0) return 'No files imported.';
  return parts.join(' · ');
}

function outcomeBadge(outcome: ImportNoteEntry['outcome']): string {
  switch (outcome) {
    case 'created': return '✓';
    case 'renamed': return '↪';
    case 'skipped': return '−';
    case 'failed':  return '✗';
  }
}

function renderEntryPath(entry: ImportNoteEntry): ReactNode {
  // For renames, show both paths so the user can see what got
  // moved aside. For everything else, the requested path is what
  // matters (final == requested for non-renames; final is empty
  // for failures and skips).
  if (entry.outcome === 'renamed' && entry.finalPath) {
    return (
      <>
        <span className="nc-import-entry-from">{entry.requestedPath}</span>
        <span className="nc-import-entry-arrow"> → </span>
        <span className="nc-import-entry-to">{entry.finalPath}</span>
      </>
    );
  }
  if (entry.outcome === 'failed' && entry.errorMessage) {
    return (
      <>
        <span className="nc-import-entry-from">{entry.requestedPath}</span>
        <span className="nc-import-entry-error"> ({entry.errorMessage})</span>
      </>
    );
  }
  if (entry.outcome === 'skipped' && entry.errorMessage) {
    return (
      <>
        <span className="nc-import-entry-from">{entry.requestedPath}</span>
        <span className="nc-import-entry-error"> ({entry.errorMessage})</span>
      </>
    );
  }
  return <span className="nc-import-entry-from">{entry.requestedPath}</span>;
}
