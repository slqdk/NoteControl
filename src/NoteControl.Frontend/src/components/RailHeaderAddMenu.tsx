import { useEffect, useRef, useState, type ChangeEvent } from 'react';

import { ApiError, notesApi } from '../api/client';
import type { ImportNoteResult } from '../api/client';
import { ImportResultModal } from './ImportResultModal';

/**
 * Unified "+" dropdown in the tree-rail header.
 *
 * Pre-this-ship the rail header held five separate buttons:
 *   🏠+   (Add Dashboard, desktop only)
 *   📅 Daily Note +   (the labelled pill, left-most)
 *   📄+   (New note)
 *   ▾    (the ImportNoteSplitButton chevron, desktop only)
 *   📁+   (New folder)
 *
 * That row read busy and forced two of the actions to be desktop-
 * only. We collapse the four "create-something" actions into a
 * single bordered "+" pill that opens a small menu. The Daily Note
 * pill stays untouched on the LEFT; this menu sits on the RIGHT,
 * flex-pushed apart by the surrounding .nc-rail-header-actions
 * container.
 *
 * Menu items, in order (per the user's spec):
 *   1. 📄 Add Note
 *   2. 📁 Add Folder
 *   3. 📥 Import .md or .zip…
 *   4. 🏠 Add Dashboard
 *
 * Each item passes through to the existing callback that the old
 * button used to fire. The Import flow is identical to the old
 * ImportNoteSplitButton's: one menu item, .md/.zip both accepted
 * by the file picker, server detects and routes. We kept the
 * decision NOT to split into two items (".md only" vs ".zip
 * only") because the existing behaviour was already a single
 * combined flow — the "split" in the old name referred to the
 * chevron, not to two import flavours.
 *
 * Mobile gets the same dropdown — the Daily Note pill stays
 * labelled, the + button stays small, the rail header row stays
 * tight. Both Add Dashboard and Import are now reachable from
 * mobile, where they weren't before — minor capability gain
 * since the actual destinations (dashboard canvas; modal import
 * summary) still aren't tuned for narrow viewports, but the
 * affordance is at least present.
 */
export interface RailHeaderAddMenuProps {
  /** Vault id, needed by the Import flow. */
  vaultId: string;
  /**
   * Target folder for both Add Note / Add Folder / Import. Same
   * resolution as the old buttons used (see VaultLayout's
   * toolbarParent useMemo): folder selection → that folder; note
   * selection → its parent; no selection → vault root.
   */
  targetFolder: string;
  /** Human label for the target — "vault root" or a folder path. */
  targetLabel: string;

  /** Invoked when Add Note is picked. */
  onAddNote: () => void;
  /** Invoked when Add Folder is picked. */
  onAddFolder: () => void;
  /**
   * Invoked after a successful import so the host can refresh the
   * tree at the target folder (and expand it if collapsed).
   */
  onImported: (targetFolder: string) => void;
  /**
   * Invoked when Add Dashboard is picked. Disabled (the menu item
   * grays out) when this callback is null — happens before the
   * dashboards config has loaded, matching the old standalone
   * 🏠+ button's `disabled={!dashboardsHook.config}` gate.
   */
  onAddDashboard: (() => void) | null;
}

export function RailHeaderAddMenu({
  vaultId,
  targetFolder,
  targetLabel,
  onAddNote,
  onAddFolder,
  onImported,
  onAddDashboard,
}: RailHeaderAddMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportNoteResult | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  // Close on outside click / Escape — same idiom the old
  // ImportNoteSplitButton used (and the rest of the app's
  // dropdowns). Mounted only while open so we don't pay listener
  // cost the rest of the time.
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

  function pickImportFile() {
    setMenuOpen(false);
    setError(null);
    // Reset value first so picking the same file twice still fires
    // a change event.
    if (inputRef.current) inputRef.current.value = '';
    inputRef.current?.click();
  }

  async function onFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await notesApi.import(vaultId, file, targetFolder);
      setResult(r);
      // Refresh even on partial success — files were written, the
      // user wants to see them.
      onImported(targetFolder);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  // Pick handlers close the menu first, then dispatch. Doing it in
  // this order means the menu's outside-click handler doesn't race
  // with any modal/composer the callback opens.
  const handleAddNote = () => {
    setMenuOpen(false);
    onAddNote();
  };
  const handleAddFolder = () => {
    setMenuOpen(false);
    onAddFolder();
  };
  const handleAddDashboard = () => {
    setMenuOpen(false);
    onAddDashboard?.();
  };

  return (
    <span ref={wrapRef} className="nc-rail-add-wrap">
      {/*
        The "+" trigger. Styled like the Daily Note pill (bordered,
        slightly raised) so the two ends of the rail header row
        read as a matched pair: a primary verb-pill on the left,
        an add-things-pill on the right. The shared base class is
        .nc-rail-header-button; .nc-rail-add layers the "+"-specific
        sizing/padding on top.
      */}
      <button
        type="button"
        className="nc-rail-header-button nc-rail-add"
        title={`Add something to ${targetLabel}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
        disabled={busy}
      >
        +
      </button>

      {menuOpen && (
        <div className="nc-rail-add-menu" role="menu">
          <button
            type="button"
            className="nc-rail-add-menu-item"
            role="menuitem"
            onClick={handleAddNote}
            disabled={busy}
          >
            <span className="nc-rail-add-menu-icon" aria-hidden="true">📄</span>
            <span className="nc-rail-add-menu-label">Add Note</span>
            <span className="nc-rail-add-menu-target">in {targetLabel}</span>
          </button>
          <button
            type="button"
            className="nc-rail-add-menu-item"
            role="menuitem"
            onClick={handleAddFolder}
            disabled={busy}
          >
            <span className="nc-rail-add-menu-icon" aria-hidden="true">📁</span>
            <span className="nc-rail-add-menu-label">Add Folder</span>
            <span className="nc-rail-add-menu-target">in {targetLabel}</span>
          </button>
          <button
            type="button"
            className="nc-rail-add-menu-item"
            role="menuitem"
            onClick={pickImportFile}
            disabled={busy}
          >
            <span className="nc-rail-add-menu-icon" aria-hidden="true">📥</span>
            <span className="nc-rail-add-menu-label">Import .md or .zip…</span>
            <span className="nc-rail-add-menu-target">into {targetLabel}</span>
          </button>
          <button
            type="button"
            className="nc-rail-add-menu-item"
            role="menuitem"
            onClick={handleAddDashboard}
            disabled={busy || !onAddDashboard}
            title={
              onAddDashboard
                ? 'Add a new dashboard'
                : 'Dashboards are still loading'
            }
          >
            <span className="nc-rail-add-menu-icon" aria-hidden="true">🏠</span>
            <span className="nc-rail-add-menu-label">Add Dashboard</span>
          </button>
        </div>
      )}

      {/*
        Hidden file input. accept hint helps OS file pickers default
        to the right filter; we still validate server-side. Same
        behaviour as the old ImportNoteSplitButton — single picker,
        both .md and .zip accepted, server detects.
      */}
      <input
        ref={inputRef}
        type="file"
        accept=".md,.zip,text/markdown,application/zip"
        style={{ display: 'none' }}
        onChange={(e) => void onFileChosen(e)}
      />

      {busy && (
        <span className="nc-rail-add-busy" role="status" aria-live="polite">
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
