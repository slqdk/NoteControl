import { useEffect, useState } from 'react';

import { ApiError, foldersApi, notesApi } from '../api/client';
import type { FolderListingDto, NoteDto } from '../api/types';
import type { TreeSelection } from './TreeView';
import { formatNoteTimestamp } from '../utils/time';
import type { TreeVariant } from '../tree/treeStyles';
import { EditableName } from './EditableName';
import { EditableTags } from './EditableTags';
import { EditableLocked } from './EditableLocked';
import { EditableNoteAppearance } from './EditableNoteAppearance';
import { EditableVersion } from './EditableVersion';

/**
 * Visual Studio-style properties panel.
 *
 * As of step 7b-2, fields that the user can change — name, tags,
 * locked — are inline-editable. Read-only metadata (paths, sizes,
 * timestamps) stay as plain <dl> rows.
 *
 * The panel calls the API directly for edits rather than going
 * through the parent. Each editable component owns its own save
 * state, so the panel's render doesn't churn on every keystroke.
 *
 * After a successful name change, we notify the parent via
 * onAfterRename so it can update tree selection + URL — same hook
 * the right-click rename uses.
 *
 * Step 36 added the Move button + Cancel-while-in-move-mode toggle.
 * Move-mode state itself lives in VaultLayout (one flag for the
 * whole shell); this panel just renders the button and calls the
 * parent when it's pressed.
 */
export interface PropertiesPanelProps {
  vaultId: string;
  selection: TreeSelection | null;
  variant: TreeVariant;
  onClose: () => void;
  /**
   * Called after a successful rename so the parent (VaultLayout)
   * can refresh the tree, update its selection, and follow the URL.
   * Old + new are full canonical paths. Kind tells the parent
   * whether we renamed a note or a folder.
   */
  onAfterRename: (kind: 'note' | 'folder', oldPath: string, newPath: string) => void;
  /**
   * Called when the user clicks the Delete button. Parent already
   * has the deletion logic wired for the right-click menu — this
   * just reuses it. The parent confirms, calls the API, refreshes
   * the tree, navigates URL if needed.
   */
  onDelete: (kind: 'note' | 'folder', path: string) => void;

  // ----- Step 36: Move button -----

  /**
   * Whether the current selection is in "move mode" — meaning the
   * user has armed it for dragging via the Move button below. The
   * button label/style flips to "Cancel move" when this is true.
   */
  isInMoveMode: boolean;
  /**
   * Called when the Move button is pressed. Two behaviours based
   * on isInMoveMode:
   *   - false: enter move mode (parent sets moveModeItem to the
   *     current selection). The user then drags the row in the tree.
   *   - true:  cancel move mode (parent clears moveModeItem). User
   *     changed their mind before dragging.
   * The parent owns the toggle so we don't have to mirror state.
   */
  onStartMove: () => void;
}

export function PropertiesPanel({
  vaultId,
  selection,
  variant,
  onClose,
  onAfterRename,
  onDelete,
  isInMoveMode,
  onStartMove,
}: PropertiesPanelProps) {
  const [note, setNote] = useState<NoteDto | null>(null);
  const [folder, setFolder] = useState<FolderListingDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bumped after a successful tags/locked save so we re-fetch the
  // note (in particular so we get the new etag).
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    setNote(null);
    setFolder(null);
    setError(null);
    if (!selection) return;

    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        if (selection.kind === 'note') {
          const n = await notesApi.get(vaultId, selection.path);
          if (!cancelled) {
            if (n === null) setError('Note not found.');
            else setNote(n);
          }
        } else {
          const f = await notesApi.listFolder(vaultId, selection.path);
          if (!cancelled) setFolder(f);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : 'Could not load.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId, selection, refreshTick]);

  // ------------------------------------------------- save handlers

  async function saveNoteRename(newName: string) {
    if (!selection || selection.kind !== 'note' || !note) return;
    const newFileName = newName.toLowerCase().endsWith('.md')
      ? newName
      : `${newName}.md`;
    const parent = parentOf(selection.path);
    const newPath = parent ? `${parent}/${newFileName}` : newFileName;

    if (newPath === selection.path) return; // no-op

    try {
      await notesApi.move(vaultId, selection.path, newPath);
      onAfterRename('note', selection.path, newPath);
    } catch (e) {
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
  }

  async function saveFolderRename(newName: string) {
    if (!selection || selection.kind !== 'folder') return;
    const parent = parentOf(selection.path);
    const newPath = parent ? `${parent}/${newName}` : newName;
    if (newPath === selection.path) return;

    try {
      await foldersApi.move(vaultId, selection.path, newPath);
      onAfterRename('folder', selection.path, newPath);
    } catch (e) {
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
  }

  async function saveTags(newTags: string[]) {
    if (!selection || selection.kind !== 'note' || !note) return;
    try {
      await notesApi.update(vaultId, selection.path, {
        body: note.body,
        tags: newTags,
        // omit etag deliberately: tag changes from this panel are
        // user-driven, immediate, and infrequent enough that ETag
        // conflict UX would be more annoying than helpful here.
      });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
  }

  async function saveLocked(locked: boolean) {
    if (!selection || selection.kind !== 'note' || !note) return;
    try {
      await notesApi.update(vaultId, selection.path, {
        body: note.body,
        locked,
      });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
  }

  /**
   * Ship 68: save the per-note version. Free-text; server interprets
   * empty string as "reset to default v0.0" rather than "remove",
   * so a successful save with empty input will round-trip back as
   * "v0.0" (which the EditableVersion useEffect picks up after the
   * refreshTick re-reads the note).
   */
  async function saveVersion(version: string) {
    if (!selection || selection.kind !== 'note' || !note) return;
    try {
      await notesApi.update(vaultId, selection.path, {
        body: note.body,
        version,
      });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
  }

  /**
   * Per-note appearance saves. Each one sends ONLY the field being
   * changed (plus the body, which the server requires). After the
   * save we:
   *   1. bump refreshTick to refetch — gets us a fresh ETag.
   *   2. dispatch a window event so the live editor (if mounted on
   *      this same note) updates its inline style without needing a
   *      reload. The editor doesn't know about this panel's changes
   *      otherwise — it reads frontmatter only at mount.
   *
   * The empty-string / 0 sentinel is what tells the server "clear
   * this field". See FrontmatterCodec.ApplyUpdate on the server.
   */
  async function saveAppearance(
    field: 'font' | 'fontSize' | 'width',
    value: string | number,
  ) {
    if (!selection || selection.kind !== 'note' || !note) return;
    const body = note.body;
    const patch =
      field === 'font'
        ? { body, font: value as string }
        : field === 'fontSize'
        ? { body, fontSize: value as number }
        : { body, width: value as number };
    try {
      await notesApi.update(vaultId, selection.path, patch);
      setRefreshTick((t) => t + 1);
      // Live-update the open editor. Detail mirrors the on-disk
      // semantics: empty string / 0 means "default / cleared".
      window.dispatchEvent(
        new CustomEvent('nc:note-appearance-changed', {
          detail: { path: selection.path, field, value },
        }),
      );
    } catch (e) {
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
  }

  // ------------------------------------------------- render

  // Step 36: Move button is shown for any movable item — i.e., not
  // the vault root. (Notes, subfolders, and any nested folder are
  // movable.) Vault root has selection.path === '' and is the only
  // unmovable thing in the tree. We compute this once here so both
  // the action-block visibility check and the button render share
  // the same predicate.
  const isVaultRoot =
    selection !== null
    && selection.kind === 'folder'
    && selection.path === '';
  const showMoveButton = selection !== null && !isVaultRoot;

  return (
    <aside className={`nc-props nc-props-${variant}`}>
      <div className="nc-props-header">
        <span className="nc-props-title">Properties</span>
        <button
          type="button"
          className="nc-props-close"
          onClick={onClose}
          title="Hide properties panel"
          aria-label="Close properties panel"
        >
          ×
        </button>
      </div>

      <div className="nc-props-body">
        {!selection && (
          <p className="nc-empty">
            Right-click an item in the tree and choose <em>Properties</em> to
            see its details here.
          </p>
        )}

        {selection && loading && <p className="nc-empty">Loading…</p>}
        {selection && error && <div className="nc-form-error">{error}</div>}

        {selection?.kind === 'note' && note && (
          <dl className="nc-props-grid">
            <dt>Type</dt>
            <dd>Note</dd>

            <dt>Name</dt>
            <dd>
              <EditableName
                value={stripMd(selection.name)}
                onSave={saveNoteRename}
              />
            </dd>

            <dt>Path</dt>
            <dd className="nc-props-mono">{selection.path}</dd>

            <dt>Modified</dt>
            <dd>{formatNoteTimestamp(note.lastModified)}</dd>

            {note.frontmatter.created && (
              <>
                <dt>Created</dt>
                <dd>{formatNoteTimestamp(note.frontmatter.created)}</dd>
              </>
            )}

            <dt>Size</dt>
            <dd>{formatBytes(byteLength(note.body))}</dd>

            <dt>Version</dt>
            <dd>
              <EditableVersion
                value={note.frontmatter.version}
                onSave={saveVersion}
              />
            </dd>

            <dt>Tags</dt>
            <dd>
              <EditableTags
                tags={note.frontmatter.tags}
                onSave={saveTags}
              />
            </dd>

            <dt>Locked</dt>
            <dd>
              <EditableLocked
                value={note.frontmatter.locked}
                onSave={saveLocked}
              />
            </dd>

            {/*
              Per-note appearance: font, font size, page width. Three
              rows (each renders its own dt/dd inside the fragment).
              Saves are independent per-field — see saveAppearance.
            */}
            <EditableNoteAppearance
              font={note.frontmatter.font}
              fontSize={note.frontmatter.fontSize}
              width={note.frontmatter.width}
              onSaveFont={(stack) => saveAppearance('font', stack)}
              onSaveFontSize={(size) => saveAppearance('fontSize', size)}
              onSaveWidth={(w) => saveAppearance('width', w)}
            />

            <dt>ETag</dt>
            <dd className="nc-props-mono nc-props-truncate">{note.etag}</dd>
          </dl>
        )}

        {selection?.kind === 'folder' && folder && (
          <dl className="nc-props-grid">
            <dt>Type</dt>
            <dd>Folder</dd>

            <dt>Name</dt>
            <dd>
              {selection.path === '' ? (
                /* Vault root has no editable name. */
                <span>{selection.name || '(root)'}</span>
              ) : (
                <EditableName
                  value={selection.name}
                  onSave={saveFolderRename}
                />
              )}
            </dd>

            <dt>Path</dt>
            <dd className="nc-props-mono">{selection.path || '/'}</dd>

            <dt>Subfolders</dt>
            <dd>{folder.subfolders.length}</dd>

            <dt>Notes here</dt>
            <dd>{folder.notes.length}</dd>
          </dl>
        )}

        {/*
          Action buttons block. Holds export buttons (notes only),
          the Move button (step 36), and the Delete button. Single
          .nc-props-actions wrapper so the divider above them only
          renders once even when several groups are present.

          Export: notes only. Folders aren't export targets in this
          iteration. Browser handles the actual download via Save
          dialog when the link is clicked. We use a hidden
          <a download> rather than window.location.href so the
          user stays on the editor page.

          Move (step 36): any movable item — i.e. anything except the
          vault root. Pressing it arms the row for dragging in the
          tree (cursor changes to grab; a dashed outline appears on
          the row). Pressing it again cancels. Selection-change,
          successful drop, drag-end, and Escape also cancel — see
          VaultLayout for that wiring.

          Delete: any note, or any folder other than the vault root
          (root has no path). The parent component handles the
          confirmation prompt, API call, tree refresh, and URL
          navigation; we just dispatch.

          The .pdf button is disabled for now — pdf export is
          deferred to a future ship.
        */}
        {selection && (
          (selection.kind === 'note' && !!note) ||
          !(selection.kind === 'folder' && selection.path === '')
        ) && (
          <div className="nc-props-actions">
            {selection.kind === 'note' && note && (
              <>
                <a
                  className="nc-btn"
                  href={notesApi.exportUrl(vaultId, selection.path, 'docx')}
                  download
                  title="Download this note as a Word document (.docx)"
                >
                  📄 Export as .docx
                </a>
                <button
                  type="button"
                  className="nc-btn"
                  disabled
                  title="PDF export coming next"
                >
                  📑 Export as .pdf
                </button>
              </>
            )}
            {showMoveButton && (
              <button
                type="button"
                className={`nc-btn ${isInMoveMode ? 'nc-btn-active' : ''}`}
                onClick={onStartMove}
                title={
                  isInMoveMode
                    ? 'Cancel move (or press Escape)'
                    : `Drag this ${selection.kind} to a new folder. Press Escape or click another item to cancel.`
                }
              >
                {isInMoveMode ? '✖ Cancel move' : '↪ Move…'}
              </button>
            )}
            {!(selection.kind === 'folder' && selection.path === '') && (
              <button
                type="button"
                className="nc-btn nc-btn-danger"
                onClick={() => onDelete(selection.kind, selection.path)}
                title={
                  selection.kind === 'note'
                    ? 'Move this note to the vault trash'
                    : 'Delete this folder (must be empty)'
                }
              >
                🗑 Delete {selection.kind === 'note' ? 'note' : 'folder'}
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function stripMd(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

function byteLength(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
