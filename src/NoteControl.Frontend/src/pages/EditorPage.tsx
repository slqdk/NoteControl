import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';

import { ApiError, notesApi } from '../api/client';
import type { NoteDto } from '../api/types';
import {
  NoteEditor,
  type EditorUpload,
  type SaveNowOutcome,
} from '../components/NoteEditor';
import { SaveStatusIndicator, type SaveState } from '../components/SaveStatusIndicator';
import { SaveFailedDialog } from '../components/SaveFailedDialog';
import {
  registerNavigationGuard,
  requestNavigation,
  type NavigationGuardVerdict,
} from '../hooks/navigationGuard';
import type { VaultLayoutContext } from '../components/VaultLayout';

/**
 * Note editor page.
 *
 *   /vaults/:vaultId/note?path=...
 *
 * Layout-route note: this page used to wrap itself in <VaultLayout>.
 * After the layout-route refactor, the surrounding shell is mounted
 * once by the parent route and we render only the inner content
 * here. Vault metadata for the breadcrumb is shared via outlet
 * context so the layout's single fetch suffices.
 *
 * Navigation guard: while this page is mounted, it registers a
 * guard with the navigationGuard registry. Components that handle
 * navigation away (currently TreeView's row click handlers, plus
 * the breadcrumb's "back to vault" link) consult that guard before
 * actually navigating. If the editor is dirty, the guard tries to
 * save; if the save fails, it shows the SaveFailedDialog and asks
 * the user to choose stay-and-retry vs discard-and-leave.
 *
 * Browser back/forward buttons and tab close are NOT covered by
 * this guard - they fall through to the existing beforeunload
 * handler in NoteEditor (which prompts the browser's generic
 * "Leave site?" dialog when there are unsaved changes).
 */
export function EditorPage() {
  const { vaultId } = useParams<{ vaultId: string }>();
  const [searchParams] = useSearchParams();
  const notePath = searchParams.get('path') ?? '';
  const { vault } = useOutletContext<VaultLayoutContext>();
  const navigate = useNavigate();

  const [note, setNote] = useState<NoteDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Save status + uploads live here so the breadcrumb row can show
  // them. NoteEditor reports them via callbacks; we don't try to
  // re-derive anything from inside the editor.
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [uploads, setUploads] = useState<EditorUpload[]>([]);
  // The editor hands a stable saveNow() up here so the breadcrumb's
  // SaveStatusIndicator can offer a manual Retry button AND the
  // navigation guard can call saveNow before letting a click-away
  // through. Lives in a ref because it changes per editor mount
  // and we don't want re-renders just because the function
  // identity shifted.
  const saveNowRef = useRef<(() => Promise<SaveNowOutcome>) | null>(null);

  // Save-failed dialog state. When the navigation guard catches a
  // failed click-away save, it sets these and then awaits the
  // user's choice via the resolver ref. The resolver lives outside
  // React state because it's a one-shot callback the dialog wires
  // back into the guard's promise.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogReason, setDialogReason] = useState<string>('');
  const dialogResolverRef = useRef<((v: NavigationGuardVerdict) => void) | null>(null);

  // Tracks the latest saveState in a ref so the guard callback
  // (which is created once via useCallback below and registered
  // for the lifetime of the page) can read the CURRENT state
  // without being re-created on every state change. Re-creating
  // the guard would mean re-registering it constantly, which is
  // fine in principle but noisy.
  const saveStateRef = useRef(saveState);
  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);

  /**
   * The navigation guard. Returns:
   *   'allow' - safe to navigate (editor is clean, or save just
   *             succeeded, or user picked Discard)
   *   'block' - DON'T navigate; the dialog is up and the user is
   *             interacting with it (or picked Stay)
   */
  const navigationGuardCallback = useCallback(async (): Promise<NavigationGuardVerdict> => {
    const saveNow = saveNowRef.current;
    const state = saveStateRef.current;

    // Editor isn't mounted, or the note is in a state that doesn't
    // need a save (idle / saved). Allow immediately.
    if (!saveNow) return 'allow';
    if (state.kind === 'idle' || state.kind === 'saved') return 'allow';

    // Conflict state is unrecoverable without a reload. The user
    // already saw the loud red chip + toast; the dialog would just
    // ask them to retry something that won't work. Show the dialog
    // anyway so they have a deliberate choice between staying
    // (and reloading the note) or walking away.
    if (state.kind === 'conflict') {
      return await openDialog(state.message);
    }

    // dirty / saving / error: try a save and see what happens.
    let outcome: SaveNowOutcome;
    try {
      outcome = await saveNow();
    } catch {
      // saveNow shouldn't throw - performSave catches its own
      // errors - but defend against future bugs by treating an
      // unexpected throw the same as 'failed'.
      outcome = 'failed';
    }

    if (outcome === 'ok') return 'allow';

    const reason =
      outcome === 'conflict'
        ? 'The note was changed by someone else (or another device) since you opened it. ' +
          'Reload to see the latest version.'
        : pickFailureReason(saveStateRef.current);
    return await openDialog(reason);

    function openDialog(message: string): Promise<NavigationGuardVerdict> {
      return new Promise<NavigationGuardVerdict>((resolve) => {
        dialogResolverRef.current = resolve;
        setDialogReason(message);
        setDialogOpen(true);
      });
    }

    function pickFailureReason(s: SaveState): string {
      if (s.kind === 'error' || s.kind === 'conflict') return s.message;
      return 'Save failed.';
    }
  }, []);

  // Register the guard for the lifetime of this page.
  useEffect(() => {
    return registerNavigationGuard(navigationGuardCallback);
  }, [navigationGuardCallback]);

  function onDialogStay() {
    setDialogOpen(false);
    const resolve = dialogResolverRef.current;
    dialogResolverRef.current = null;
    resolve?.('block');
  }

  function onDialogDiscard() {
    setDialogOpen(false);
    const resolve = dialogResolverRef.current;
    dialogResolverRef.current = null;
    resolve?.('allow');
  }

  useEffect(() => {
    if (!vaultId || !notePath) return;
    let cancelled = false;
    setError(null);
    setNotFound(false);
    setNote(null);
    // Reset transient editor reporting when the note changes —
    // otherwise a "Saved" from the previous note flickers briefly
    // on the next breadcrumb.
    setSaveState({ kind: 'idle' });
    setUploads([]);
    // Drop the saveNow handle from the previous editor mount so a
    // stray Retry click on a stale error chip can't fire a save
    // against the new note's editor (it'll just no-op until the
    // new editor reports its own saveNow).
    saveNowRef.current = null;
    (async () => {
      try {
        const n = await notesApi.get(vaultId, notePath);
        if (cancelled) return;
        if (n === null) {
          setNotFound(true);
        } else {
          setNote(n);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : 'Could not load note.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId, notePath]);

  if (!vaultId || !notePath) {
    return (
      <div className="nc-page">
        <p className="nc-empty">No note specified.</p>
      </div>
    );
  }

  return (
    <div className="nc-page nc-page-editor">
      {/*
        Breadcrumb row: path on the left, save status + in-flight
        upload pills on the right. This replaces the old in-editor
        toolbar that lived above the page. Putting it here keeps
        the editor surface free of chrome and gives the user a
        stable place to glance at "is my work saved?".
      */}
      <div className="nc-breadcrumb-row">
        <div className="nc-breadcrumb">
          {/*
            Guarded breadcrumb link. The default <Link> click would
            navigate immediately and bypass the guard - we have to
            preventDefault, consult the guard, and only call
            navigate() on 'allow'. This handles the case where the
            user clicks the vault name in the breadcrumb to go back
            to the folder view while a save is dirty/failing.
          */}
          <Link
            to={`/vaults/${vaultId}`}
            onClick={(e) => {
              // Honour modifier-click semantics (open in new tab,
              // etc.) - those bypass the SPA navigation entirely
              // and we don't need to guard them, since the current
              // tab stays put with the editor still mounted.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              void (async () => {
                const verdict = await requestNavigation();
                if (verdict === 'block') return;
                navigate(`/vaults/${vaultId}`);
              })();
            }}
          >
            {vault?.name ?? 'Vault'}
          </Link>
          <span className="nc-topbar-sep">/</span>
          <span>{notePath}</span>
        </div>
        <div className="nc-breadcrumb-status">
          {uploads.length > 0 && (
            <div className="nc-editor-uploads">
              {uploads.map((u) => (
                <span
                  key={u.id}
                  className={
                    u.error
                      ? 'nc-editor-upload nc-editor-upload-error'
                      : 'nc-editor-upload'
                  }
                  title={u.error ? u.error : `Uploading ${u.info.fileName}…`}
                >
                  {u.error ? '⚠' : '⬆'} {u.info.fileName}
                </span>
              ))}
            </div>
          )}
          <SaveStatusIndicator
            state={saveState}
            onRetry={() => {
              void saveNowRef.current?.();
            }}
          />
        </div>
      </div>

      {error && <div className="nc-form-error">{error}</div>}

      {notFound && (
        <div className="nc-empty">
          That note doesn&apos;t exist.{' '}
          <Link to={`/vaults/${vaultId}`}>Back to vault</Link>
        </div>
      )}

      {note && (
        <NoteEditor
          key={note.path}
          vaultId={vaultId}
          initialNote={note}
          onSaveStateChange={setSaveState}
          onUploadsChange={setUploads}
          onSaveNowReady={(fn) => {
            saveNowRef.current = fn;
          }}
        />
      )}

      {dialogOpen && (
        <SaveFailedDialog
          notePath={notePath}
          reason={dialogReason}
          onStay={onDialogStay}
          onDiscard={onDialogDiscard}
        />
      )}
    </div>
  );
}
