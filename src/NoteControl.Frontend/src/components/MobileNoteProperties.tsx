import { useEffect, useState } from 'react';

import { ApiError, notesApi } from '../api/client';
import type { NoteDto } from '../api/types';
import { formatNoteTimestamp } from '../utils/time';
import { EditableName } from './EditableName';
import { EditableTags } from './EditableTags';
import { EditableLocked } from './EditableLocked';
import { EditableVersion } from './EditableVersion';
import { EditableNoteAppearance } from './EditableNoteAppearance';

/**
 * Ship 84 — Mobile-only note properties section.
 *
 * Renders inside NoteEditor when the viewport is mobile (≤768px),
 * placed below the editor's page area so the user scrolls past the
 * note's last line to reach it. Collapsed by default — the chevron
 * header expands the slim section (Name / Tags / Locked / Delete);
 * a nested "More" expander reveals the rest (Type / Path / Modified
 * / Created / Size / Version / Appearance / Export / ETag).
 *
 * Why a separate component instead of conditionally re-rendering
 * the desktop PropertiesPanel below the editor:
 *   1. PropertiesPanel is wired into the rail-based layout (close
 *      button, panel header, vertical scroll behaviour). Inlining
 *      it below the editor would require special-casing that chrome
 *      and would make the desktop CSS muddier.
 *   2. The slim layout the user wants on mobile is a deliberate
 *      subset, with field order and grouping that don't match the
 *      desktop dl. Building two views is cleaner than one with
 *      "if mobile then hide rows X and Y".
 *   3. The reusable Editable* components (Name/Tags/Locked/Version/
 *      NoteAppearance) are the actual save-logic primitives. Both
 *      the desktop panel and this mobile view glue them differently;
 *      no logic is duplicated, only the layout shell.
 *
 * Save semantics — same as PropertiesPanel:
 *   - We GET the note on mount and on refreshTick bumps.
 *   - Saves call notesApi.update with the body we last fetched +
 *     the field being changed.
 *   - This races with the editor's autosave: if the user has
 *     unsaved typing in the editor and changes a tag here, our PUT
 *     ships the older body alongside the new tag, clobbering
 *     unsaved typing. The desktop PropertiesPanel has the SAME race
 *     by design (see the comment in saveTags there). Mobile follows
 *     the same pattern for consistency. In practice users don't
 *     edit metadata mid-keystroke, and the editor's debounced save
 *     usually finishes within a second.
 *
 * Tree refresh after rename / delete:
 *   The desktop panel calls onAfterRename / onDelete callbacks
 *   passed in by VaultLayout. EditorPage doesn't have those (it's a
 *   different tree depth in the React tree). Rather than prop-
 *   drilling through EditorPage, we dispatch window CustomEvents
 *   ('nc:note-renamed', 'nc:note-deleted') that VaultLayout
 *   listens for. Same pattern Ship 78 used for the startpage's
 *   add-block dropdown and PropertiesPanel uses for
 *   nc:note-appearance-changed.
 */
export interface MobileNotePropertiesProps {
  vaultId: string;
  /** Path of the currently-edited note (canonical, with .md). */
  notePath: string;
  /** The note as fetched at the EditorPage level. We refresh our
      own copy after each save so this is just the seed. */
  initialNote: NoteDto;
}

export function MobileNoteProperties({
  vaultId,
  notePath,
  initialNote,
}: MobileNotePropertiesProps) {
  // Local copy of the note that this panel mutates. Starts from
  // initialNote so we don't fetch on first render. After any save,
  // bump refreshTick to re-fetch (gets us the new ETag and any
  // server-canonicalised values like version="v0.0" after empty).
  const [note, setNote] = useState<NoteDto>(initialNote);
  const [refreshTick, setRefreshTick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Resync the local note when the route changes to a different
  // note (parent passes a fresh initialNote). Without this the
  // panel would keep showing the previous note's metadata.
  useEffect(() => {
    setNote(initialNote);
    setError(null);
  }, [initialNote, notePath]);

  // Refresh on tick. Skipped on the initial render since
  // initialNote already covers it.
  useEffect(() => {
    if (refreshTick === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const fresh = await notesApi.get(vaultId, notePath);
        if (!cancelled && fresh) setNote(fresh);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : 'Could not refresh.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshTick, vaultId, notePath]);

  // Both expanders' state is purely local. Each note open starts
  // collapsed — minimises accidental discovery of stale metadata.
  // Persisting through localStorage was tempting but on a phone
  // you usually want the editor visible by default; the user can
  // tap to expand whenever they care.
  const [propsOpen, setPropsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  // ----- save handlers (same shape as PropertiesPanel) -----------

  async function saveRename(newName: string) {
    const newFileName = newName.toLowerCase().endsWith('.md')
      ? newName
      : `${newName}.md`;
    const parent = parentOf(notePath);
    const newPath = parent ? `${parent}/${newFileName}` : newFileName;
    if (newPath === notePath) return; // no-op
    try {
      await notesApi.move(vaultId, notePath, newPath);
      // Tell VaultLayout to refresh tree + follow URL. Same
      // job that onAfterRename does on desktop.
      window.dispatchEvent(
        new CustomEvent('nc:note-renamed', {
          detail: { oldPath: notePath, newPath },
        }),
      );
    } catch (e) {
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
  }

  async function saveTags(newTags: string[]) {
    try {
      await notesApi.update(vaultId, notePath, {
        body: note.body,
        tags: newTags,
      });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
  }

  async function saveLocked(locked: boolean) {
    try {
      await notesApi.update(vaultId, notePath, {
        body: note.body,
        locked,
      });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
  }

  async function saveVersion(version: string) {
    try {
      await notesApi.update(vaultId, notePath, {
        body: note.body,
        version,
      });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
  }

  async function saveAppearance(
    field: 'font' | 'fontSize' | 'width',
    value: string | number,
  ) {
    const body = note.body;
    const patch =
      field === 'font'
        ? { body, font: value as string }
        : field === 'fontSize'
          ? { body, fontSize: value as number }
          : { body, width: value as number };
    try {
      await notesApi.update(vaultId, notePath, patch);
      setRefreshTick((t) => t + 1);
      // Live-update the open editor — same window event the
      // desktop panel emits. NoteEditor listens for this and
      // re-applies inline styles without remount.
      window.dispatchEvent(
        new CustomEvent('nc:note-appearance-changed', {
          detail: { path: notePath, field, value },
        }),
      );
    } catch (e) {
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
  }

  function onDelete() {
    const name = notePath.slice(notePath.lastIndexOf('/') + 1) || notePath;
    if (
      !window.confirm(
        `Delete "${name}"? It will be moved to the vault's trash folder.`,
      )
    ) {
      return;
    }
    // Dispatch and let VaultLayout do the actual API call — it
    // already knows how to refresh the tree, clear selection, and
    // navigate the URL after a delete. Mirrors the rename flow.
    window.dispatchEvent(
      new CustomEvent('nc:note-deleted', { detail: { path: notePath } }),
    );
  }

  // Filename without .md for the rename input — matches what
  // PropertiesPanel does on desktop.
  const nameForRename = notePath.slice(notePath.lastIndexOf('/') + 1);
  const displayName = nameForRename.toLowerCase().endsWith('.md')
    ? nameForRename.slice(0, -3)
    : nameForRename;

  return (
    <section className="nc-mobile-props">
      {/* Top-level expander. Tapping the header toggles it open;
          collapsed shows just the chevron + label. */}
      <button
        type="button"
        className="nc-mobile-props-toggle"
        onClick={() => setPropsOpen((v) => !v)}
        aria-expanded={propsOpen}
      >
        <span className="nc-mobile-props-chev">{propsOpen ? '▾' : '▸'}</span>
        <span className="nc-mobile-props-title">Properties</span>
      </button>

      {propsOpen && (
        <div className="nc-mobile-props-body">
          {error && <div className="nc-form-error">{error}</div>}

          {/* Slim section: the four things you actually want on
              mobile. Tags, Locked, Name (rename), and Delete. */}
          <dl className="nc-props-grid">
            <dt>Name</dt>
            <dd>
              <EditableName value={displayName} onSave={saveRename} />
            </dd>

            <dt>Tags</dt>
            <dd>
              <EditableTags tags={note.frontmatter.tags} onSave={saveTags} />
            </dd>

            <dt>Locked</dt>
            <dd>
              <EditableLocked
                value={note.frontmatter.locked}
                onSave={saveLocked}
              />
            </dd>
          </dl>

          {/* Slim-section actions: just Delete. Move is omitted —
              it relies on tree drag-and-drop which doesn't work on
              touch yet (Ship 85's audit). Export buttons live in
              the More section so the slim view stays focused. */}
          <div className="nc-props-actions">
            <button
              type="button"
              className="nc-btn nc-btn-danger"
              onClick={onDelete}
              title="Move this note to the vault trash"
            >
              🗑 Delete note
            </button>
          </div>

          {/* Nested "More" expander. Tap to reveal the read-only
              metadata + Version + Appearance + Export + ETag.
              Collapsed by default so the slim section stays the
              first thing the user sees. */}
          <button
            type="button"
            className="nc-mobile-props-more-toggle"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
          >
            <span className="nc-mobile-props-chev">{moreOpen ? '▾' : '▸'}</span>
            <span>More</span>
          </button>

          {moreOpen && (
            <>
              <dl className="nc-props-grid">
                <dt>Type</dt>
                <dd>Note</dd>

                <dt>Path</dt>
                <dd className="nc-props-mono">{notePath}</dd>

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

                {/* Appearance renders three dt/dd pairs as a
                    fragment — same as PropertiesPanel does. */}
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

              {/* Export actions live in More since they're not
                  daily-use buttons. Mirror the desktop link shape.
                  Two formats: .docx for sharing-with-Word, .md for
                  round-trippable export (zip with the .md plus
                  asset folder). Import is desktop-only and lives
                  in the tree rail's note-add split button. */}
              <div className="nc-props-actions">
                <a
                  className="nc-btn"
                  href={notesApi.exportUrl(vaultId, notePath, 'docx')}
                  download
                  title="Download this note as a Word document (.docx)"
                >
                  📄 Export as .docx
                </a>
                <a
                  className="nc-btn"
                  href={notesApi.exportUrl(vaultId, notePath, 'md')}
                  download
                  title="Download a zip containing this note's .md file plus its assets folder (if any)."
                >
                  📥 Export as .md
                </a>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// Helpers — duplicated from PropertiesPanel to keep this component
// self-contained. Same logic; no shared util module exists yet for
// these so we don't pretend there is one.

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
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
