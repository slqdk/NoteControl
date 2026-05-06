import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';

import { ApiError, notesApi } from '../api/client';
import type { ImportNoteEntry, ImportNoteResult } from '../api/client';

/**
 * Tiny chevron-button that pairs with the rail's 📄+ button, sharing
 * its visual weight but exposing a single dropdown action: "Import
 * .md or .zip…". The trade-off vs. promoting 📄+ to a full
 * split-button is that we keep the primary new-note click target
 * identical to what users already know, and just bolt on a discreet
 * extra slot.
 *
 * The dropdown's only item today is Import; if more secondary
 * actions land here later (Templates from clipboard? Bulk-create
 * from CSV?) they slot in alongside it without further restructuring.
 *
 * Mobile is not supported — template management and import are
 * desktop-first workflows; the component renders nothing on narrow
 * viewports. The parent (VaultLayout) decides whether to mount it
 * via its existing isMobile flag.
 *
 * On import completion we surface a small modal with the per-file
 * outcomes. This is deliberate: silently writing a dozen files into
 * the user's vault — some of which may have been renamed because of
 * conflicts — should leave a paper trail the user can read before
 * dismissing.
 */
export interface ImportNoteSplitButtonProps {
  vaultId: string;
  /** Target folder (canonical, no leading slash, '' for vault root). */
  targetFolder: string;
  /** Human label for the target — "vault root" or a folder path. */
  targetLabel: string;
  /**
   * Called after a successful import so the host can refresh the
   * tree at the target folder (and its ancestors if needed).
   * Receives the canonical target folder path that was imported into.
   */
  onImported: (targetFolder: string) => void;
}

export function ImportNoteSplitButton({
  vaultId,
  targetFolder,
  targetLabel,
  onImported,
}: ImportNoteSplitButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportNoteResult | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  // Close on outside click / Escape — same idiom the rest of the
  // app uses for dropdowns. Mounted only while open so we don't
  // pay listener cost the rest of the time.
  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  function pickFile() {
    setMenuOpen(false);
    setError(null);
    inputRef.current?.click();
  }

  async function onFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input value immediately so picking the same file
    // twice in a row still triggers a change event.
    e.target.value = '';
    if (!file) return;

    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await notesApi.import(vaultId, file, targetFolder);
      setResult(r);
      // Refresh the tree even on partial success — files were
      // written, the user wants to see them.
      onImported(targetFolder);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span ref={wrapRef} className="nc-rail-import-wrap">
      {/*
        The chevron button. Visually small, immediately to the right
        of the existing 📄+. We add a CSS hook (.nc-rail-import-chev)
        so the rule can pull the chevron tight against its sibling.
      */}
      <button
        type="button"
        className="nc-rail-header-button nc-rail-import-chev"
        title={`More note actions (target: ${targetLabel})`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
        disabled={busy}
      >
        ▾
      </button>

      {menuOpen && (
        <div className="nc-rail-import-menu" role="menu">
          <button
            type="button"
            className="nc-rail-import-menu-item"
            role="menuitem"
            onClick={pickFile}
            disabled={busy}
          >
            📥 Import .md or .zip…
            <span className="nc-rail-import-menu-target">into {targetLabel}</span>
          </button>
        </div>
      )}

      {/*
        Hidden input. accept hint helps OS file pickers default to
        the right filter; we still validate server-side.
      */}
      <input
        ref={inputRef}
        type="file"
        accept=".md,.zip,text/markdown,application/zip"
        style={{ display: 'none' }}
        onChange={(e) => void onFileChosen(e)}
      />

      {busy && (
        <span className="nc-rail-import-busy" role="status" aria-live="polite">
          Importing…
        </span>
      )}

      {(error || result) && (
        <ImportResultModal
          error={error}
          result={result}
          onClose={() => {
            setError(null);
            setResult(null);
          }}
        />
      )}
    </span>
  );
}

interface ImportResultModalProps {
  error: string | null;
  result: ImportNoteResult | null;
  onClose: () => void;
}

/**
 * Lightweight modal for the post-import summary. Two states:
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
function ImportResultModal({ error, result, onClose }: ImportResultModalProps) {
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
