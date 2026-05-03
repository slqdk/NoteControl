import { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams, useSearchParams } from 'react-router-dom';

import { ApiError, notesApi } from '../api/client';
import type { NoteDto } from '../api/types';
import { NoteEditor, type EditorUpload } from '../components/NoteEditor';
import { SaveStatusIndicator, type SaveState } from '../components/SaveStatusIndicator';
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
 */
export function EditorPage() {
  const { vaultId } = useParams<{ vaultId: string }>();
  const [searchParams] = useSearchParams();
  const notePath = searchParams.get('path') ?? '';
  const { vault } = useOutletContext<VaultLayoutContext>();

  const [note, setNote] = useState<NoteDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Save status + uploads live here so the breadcrumb row can show
  // them. NoteEditor reports them via callbacks; we don't try to
  // re-derive anything from inside the editor.
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [uploads, setUploads] = useState<EditorUpload[]>([]);

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
          <Link to={`/vaults/${vaultId}`}>{vault?.name ?? 'Vault'}</Link>
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
          <SaveStatusIndicator state={saveState} />
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
        />
      )}
    </div>
  );
}
