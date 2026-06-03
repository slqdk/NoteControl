import { useEffect, useState } from 'react';

import { ApiError, notesApi } from '../api/client';
import type { NoteDto, ReleasedVersionSummary } from '../api/types';
import { formatNoteTimestamp } from '../utils/time';
import { EditableName } from './EditableName';
import { EditableTags } from './EditableTags';
import { VersionStateEditor, type VersionStatePatch } from './VersionStateEditor';
import { EditableNoteAppearance } from './EditableNoteAppearance';

/**
 * Ship 84 — Mobile-only note properties section.
 *
 * Renders inside NoteEditor when the viewport is mobile (≤768px),
 * placed below the editor's page area so the user scrolls past the
 * note's last line to reach it. Collapsed by default — the chevron
 * header expands the slim section (Name / Tags / Delete); a nested
 * "More" expander reveals the rest (Type / Path / Modified / Created
 * / Size / Version / Previous releases / Appearance / Export / ETag).
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
 *   3. The reusable Editable* components (Name/Tags/Version/
 *      NoteAppearance) are the actual save-logic primitives. Both
 *      the desktop panel and this mobile view glue them differently;
 *      no logic is duplicated, only the layout shell.
 *
 * Save semantics — same as PropertiesPanel:
 *   - We GET the note on mount and on refreshTick bumps.
 *   - Property saves call notesApi.update sending ONLY the field
 *     being changed. They MUST NOT send `body`. The server treats
 *     a missing body as "leave it alone" and only rewrites
 *     frontmatter.
 *
 * The "don't send body" rule fixes a data-loss bug: this view used
 * to send `body: note.body` along with the changed property, where
 * note.body was the panel's last-fetched snapshot. If the editor
 * had autosaved newer content (or held unsaved edits) since the
 * panel last refetched, the property save would silently overwrite
 * the on-disk body with the panel's stale view. A real user lost a
 * whole program to this on the desktop panel; the mobile panel had
 * the same race documented as "acceptable in practice". It is not.
 *
 * Lock-by-state (no manual Locked toggle):
 *   A note is locked iff its lifecycle state is `released`. There
 *   is no Locked checkbox in the slim section — the user unlocks
 *   by switching the state selector in the More expander back to
 *   "Under development" (server auto-bumps the minor) or by
 *   bumping the version steppers on a Released note (same effect
 *   plus an archive entry). The Name field also locks when the
 *   note is Released since the path is part of the published
 *   artifact's identity.
 *
 * Previous releases:
 *   Replaces the old release recall affordance. We list every past
 *   Released entry for the note (newest first) under the Version
 *   row in the More expander. Each entry is a frozen archive
 *   (path + body + frontmatter as they were at release time).
 *   Tapping an entry dispatches nc:note-open-archived-release,
 *   which EditorPage listens for and uses to mount a read-only
 *   archive viewer in place of the live editor — the same flow
 *   the desktop panel uses, so the user gets identical behaviour
 *   on both surfaces. Entries persist until the note is deleted or
 *   the same (major, minor) is re-released (which overwrites the
 *   existing archive in place).
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
  /**
   * Whether the caller has at least editor role on this vault.
   * Mirrors the desktop PropertiesPanel: every Editable* field
   * renders disabled when false, values remain visible so the
   * viewer can read them. Add Note Widget is hidden for viewers
   * (writes the per-vault widget sidecar, editor-only).
   */
  canEdit: boolean;
}

export function MobileNoteProperties({
  vaultId,
  notePath,
  initialNote,
  canEdit,
}: MobileNotePropertiesProps) {
  // Local copy of the note that this panel mutates. Starts from
  // initialNote so we don't fetch on first render. After any save,
  // bump refreshTick to re-fetch (gets us the new ETag and any
  // server-canonicalised values like version="v0.0" after empty).
  const [note, setNote] = useState<NoteDto>(initialNote);
  const [refreshTick, setRefreshTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Per-note release archive. Populated by notesApi.listReleases on
  // mount, on refreshTick bumps, and on notePath changes. Each entry
  // is one frozen Released version of the note (newest first); empty
  // when the note has never been released. Replaces the old release
  // recall info that drove the recall button on the version editor.
  const [archivedReleases, setArchivedReleases] = useState<ReleasedVersionSummary[]>([]);

  // Mirrors EditorPage's archive-viewer state so we can render the
  // matching "Previous releases" entry as active. Same flow as the
  // desktop PropertiesPanel — listen on nc:note-archive-view-changed
  // and refresh on nc:note-archive-deleted.
  const [activeArchive, setActiveArchive] = useState<{
    path: string;
    versionMajor: number;
    versionMinor: number;
  } | null>(null);

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

  // Per-note archived-releases list for the "Previous releases" row
  // in the More expander. Fetched on mount, after each save
  // (refreshTick), and on notePath changes. Best-effort — a failure
  // just shows an empty list, which is the safe default.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rels = await notesApi.listReleases(vaultId, notePath);
        if (!cancelled) setArchivedReleases(rels.archived);
      } catch {
        if (!cancelled) setArchivedReleases([]);
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
      // No `body` field — see header doc. The server treats a
      // missing body as "leave the body alone".
      const updated = await notesApi.update(vaultId, notePath, {
        tags: newTags,
      });
      // Hand the post-save etag to the open editor so its next body
      // autosave doesn't 412 on a stale etag (every frontmatter
      // write bumps the server etag).
      window.dispatchEvent(
        new CustomEvent('nc:note-etag-changed', {
          detail: { path: notePath, etag: updated.etag },
        }),
      );
      setRefreshTick((t) => t + 1);
    } catch (e) {
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
  }

  async function saveVersionState(patch: VersionStatePatch) {
    try {
      const updated = await notesApi.update(vaultId, notePath, {
        versionMajor: patch.versionMajor,
        versionMinor: patch.versionMinor,
        state: patch.state,
      });
      // Live lock/unlock the open editor — same flow as the desktop
      // panel. The returned note has the canonical post-save state
      // (server auto-bump included), so the editor flips read-only
      // mode without a page reload.
      window.dispatchEvent(
        new CustomEvent('nc:note-lock-changed', {
          detail: {
            path: notePath,
            locked: updated.frontmatter.state === 'released',
          },
        }),
      );
      // Frontmatter rewrite bumped the server etag too — pass it on.
      window.dispatchEvent(
        new CustomEvent('nc:note-etag-changed', {
          detail: { path: notePath, etag: updated.etag },
        }),
      );
      setRefreshTick((t) => t + 1);
    } catch (e) {
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
  }

  async function saveAppearance(
    field: 'font' | 'fontSize' | 'width',
    value: string | number,
  ) {
    const patch =
      field === 'font'
        ? { font: value as string }
        : field === 'fontSize'
          ? { fontSize: value as number }
          : { width: value as number };
    try {
      const updated = await notesApi.update(vaultId, notePath, patch);
      setRefreshTick((t) => t + 1);
      // Live-update the open editor — same window event the
      // desktop panel emits. NoteEditor listens for this and
      // re-applies inline styles without remount.
      window.dispatchEvent(
        new CustomEvent('nc:note-appearance-changed', {
          detail: { path: notePath, field, value },
        }),
      );
      // Frontmatter rewrite bumped the server etag — pass it on.
      window.dispatchEvent(
        new CustomEvent('nc:note-etag-changed', {
          detail: { path: notePath, etag: updated.etag },
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

  /**
   * Open one archived released version of the current note in the
   * editor surface. Same dispatcher the desktop panel uses — we
   * don't fetch the archive here; EditorPage's listener does that
   * and swaps the surface. Filtering by note path is EditorPage's
   * job; we just include the path in the detail.
   */
  function openArchivedRelease(versionMajor: number, versionMinor: number) {
    window.dispatchEvent(
      new CustomEvent('nc:note-open-archived-release', {
        detail: {
          path: notePath,
          versionMajor,
          versionMinor,
        },
      }),
    );
  }

  // Mirror EditorPage's archive-viewer state. Same listener pattern
  // as the desktop panel. null detail clears the highlight.
  useEffect(() => {
    function onArchiveView(e: Event) {
      const ce = e as CustomEvent<{
        path: string;
        versionMajor: number;
        versionMinor: number;
      } | null>;
      const d = ce.detail;
      if (d === null) {
        setActiveArchive(null);
        return;
      }
      if (d.path !== notePath) return;
      setActiveArchive(d);
    }
    window.addEventListener('nc:note-archive-view-changed', onArchiveView);
    return () => {
      window.removeEventListener('nc:note-archive-view-changed', onArchiveView);
    };
  }, [notePath]);

  // Refresh archive list after EditorPage deletes one.
  useEffect(() => {
    function onArchiveDeleted(e: Event) {
      const ce = e as CustomEvent<{ path: string }>;
      if (!ce.detail || ce.detail.path !== notePath) return;
      setRefreshTick((t) => t + 1);
    }
    window.addEventListener('nc:note-archive-deleted', onArchiveDeleted);
    return () => {
      window.removeEventListener('nc:note-archive-deleted', onArchiveDeleted);
    };
  }, [notePath]);

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

          {/* Slim section: the three things you actually want on
              mobile — Name (rename), Tags, Delete. All editable
              fields render disabled for viewers; the Delete button
              is hidden entirely (it would 403). Released notes also
              lock the Name field since the path is part of the
              published artifact's identity (unlock via state →
              development in the More expander). */}
          <dl className="nc-props-grid">
            <dt>Name</dt>
            <dd>
              <EditableName
                value={displayName}
                disabled={!canEdit || note.frontmatter.state === 'released'}
                onSave={saveRename}
              />
            </dd>

            <dt>Tags</dt>
            <dd>
              <EditableTags
                tags={note.frontmatter.tags}
                disabled={!canEdit}
                onSave={saveTags}
              />
            </dd>
          </dl>

          {/* Slim-section actions: just Delete. Move is omitted —
              it relies on tree drag-and-drop which doesn't work on
              touch yet (Ship 85's audit). Export buttons live in
              the More section so the slim view stays focused.

              Hidden entirely for viewers — DELETE /note requires
              editor. */}
          {canEdit && (
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
          )}

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
                  <VersionStateEditor
                    major={note.frontmatter.versionMajor}
                    minor={note.frontmatter.versionMinor}
                    state={note.frontmatter.state}
                    disabled={!canEdit}
                    onSave={saveVersionState}
                  />
                </dd>

                {/*
                  Previous releases — the per-version release archive
                  that replaces the old release recall affordance. One
                  row per past Released entry, newest first. Tapping
                  opens a read-only archive viewer in place of the
                  live editor (EditorPage handles the swap; same
                  dispatcher the desktop panel uses).

                  Hidden when the list is empty — a note that has
                  never been Released has nothing to show, and a
                  blank-but-present row would be noise on a phone.
                */}
                {archivedReleases.length > 0 && (
                  <>
                    <dt>Previous releases</dt>
                    <dd>
                      <ul className="nc-archived-releases">
                        {archivedReleases.map((r) => {
                          const isActive =
                            activeArchive !== null &&
                            activeArchive.versionMajor === r.versionMajor &&
                            activeArchive.versionMinor === r.versionMinor;
                          return (
                            <li
                              key={`${r.versionMajor}.${r.versionMinor}`}
                              className={
                                'nc-archived-release' +
                                (isActive ? ' nc-archived-release-active' : '')
                              }
                            >
                              <button
                                type="button"
                                className="nc-archived-release-btn"
                                onClick={() =>
                                  openArchivedRelease(r.versionMajor, r.versionMinor)
                                }
                                aria-current={isActive ? 'true' : undefined}
                                title={
                                  isActive
                                    ? `Currently viewing archived v${r.versionMajor}.${r.versionMinor}`
                                    : `Open the archived v${r.versionMajor}.${r.versionMinor} in a read-only viewer`
                                }
                              >
                                <span className="nc-archived-release-version">
                                  v{r.versionMajor}.{r.versionMinor}
                                </span>
                                <span className="nc-archived-release-time">
                                  {formatNoteTimestamp(r.savedAt)}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </dd>
                  </>
                )}

                {/* Appearance renders three dt/dd pairs as a
                    fragment — same as PropertiesPanel does.
                    Disabled for viewers. */}
                <EditableNoteAppearance
                  font={note.frontmatter.font}
                  fontSize={note.frontmatter.fontSize}
                  width={note.frontmatter.width}
                  disabled={!canEdit}
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
