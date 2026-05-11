import { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams, useSearchParams } from 'react-router-dom';

import { ApiError, notesApi } from '../api/client';
import type { NoteSummaryDto } from '../api/types';
import { SearchBox } from '../components/SearchBox';
import type { VaultLayoutContext } from '../components/VaultLayout';
import { useIsMobile } from '../hooks/useIsMobile';
import { formatNoteTimestamp } from '../utils/time';

/**
 * Main view for a folder.
 *
 * Layout, top → bottom:
 *   1. Folder title (full path, breadcrumb-style)
 *   2. Search box, scoped to this folder + descendants
 *   3. All notes under this folder, recursively, newest-updated first.
 *      Each row's label is the path **relative to the current folder**,
 *      with the .md stripped:
 *        - viewing root  →  "Projects/Q4/launch"
 *        - viewing Projects → "Q4/launch"
 *        - viewing Projects/Q4 → "launch"
 *   4. **Mobile only**: an Add footer at the bottom that lets the
 *      user create a note or folder under the current folder. The
 *      footer mirrors the assignments-page Add button visual
 *      pattern. Desktop users create from the tree rail header
 *      buttons (📄+ / 📁+) and don't need this — `useIsMobile`
 *      gates the render.
 *
 * Folder navigation lives in the tree (left rail) on desktop, and in
 * the round-button MobileNavBar on mobile. Note creation lives in
 * the tree's right-click menu + header on desktop, and in the new
 * Add footer here on mobile.
 *
 * Layout-route note: this page used to wrap itself in <VaultLayout>.
 * After the layout-route refactor, the surrounding shell is mounted
 * once by the parent route and we render only the inner content here.
 * Vault metadata for the breadcrumb is shared via outlet context
 * instead of being refetched per-page.
 */
export function FolderPage() {
  const { vaultId } = useParams<{ vaultId: string }>();
  const [searchParams] = useSearchParams();
  const folderPath = searchParams.get('path') ?? '';
  const { vault, onCreateNote, onCreateFolder } =
    useOutletContext<VaultLayoutContext>();
  const isMobile = useIsMobile();

  const [notes, setNotes] = useState<NoteSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // -------------------------------------------------------------------
  // Listing of the CURRENT folder (not the recursive flat list above).
  // We need this for two reasons:
  //   1. Duplicate-name validation in the Add composer — checking
  //      against `notes` above wouldn't catch a clash because that
  //      list is recursive (a note named "foo" deep in a subfolder
  //      doesn't clash with a new "foo" at this level).
  //   2. To know what folders already exist at this level for the
  //      "new folder name" dup check.
  //
  // Loaded once per folderPath change. Errors from this fetch are
  // silently dropped — the composer falls back to "trust the server"
  // (the create endpoint will reject duplicates with a clear error
  // message) so a transient listing failure doesn't block creation.
  // -------------------------------------------------------------------
  const [siblingNoteNames, setSiblingNoteNames] = useState<string[]>([]);
  const [siblingFolderNames, setSiblingFolderNames] = useState<string[]>([]);
  // -------------------------------------------------------------------

  useEffect(() => {
    if (!vaultId) return;
    let cancelled = false;
    setError(null);
    setNotes(null);

    (async () => {
      try {
        const flat = await notesApi.listFolderRecursive(vaultId, folderPath);
        if (!cancelled) setNotes(flat);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : 'Could not load notes.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [vaultId, folderPath]);

  // Separate effect for the (non-recursive) immediate-children listing,
  // used by the mobile Add composer for dup validation. We could combine
  // it with the effect above, but recursive vs flat listings are two
  // different API calls and conflating them muddies the loading state
  // (the flat list drives the "Loading…" UI; the immediate listing
  // shouldn't).
  useEffect(() => {
    if (!vaultId) return;
    if (!isMobile) return;  // composer only runs on mobile; skip otherwise
    let cancelled = false;
    (async () => {
      try {
        const listing = await notesApi.listFolder(vaultId, folderPath);
        if (cancelled) return;
        // Lowercased for case-insensitive dup checks (the server is
        // case-sensitive but most filesystems aren't; matching the
        // user's mental model is more important than matching the
        // wire format).
        setSiblingNoteNames(
          listing.notes.map((n) =>
            stripMd(nameOnly(n.path)).toLowerCase(),
          ),
        );
        setSiblingFolderNames(
          listing.subfolders.map((f) => f.name.toLowerCase()),
        );
      } catch {
        // Swallow — the create endpoint will surface real conflicts.
        // We just lose the inline pre-submit warning in this case.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId, folderPath, isMobile]);

  if (!vaultId) {
    return null;
  }

  return (
    <div className="nc-page">
      <h1 className="nc-page-title">
        {folderPath || (vault?.name ?? 'Folder')}
      </h1>

      {error && <div className="nc-form-error">{error}</div>}

      <div className="nc-folder-search">
        <SearchBox
          vaultId={vaultId}
          folderPath={folderPath}
          placeholder="Search"
        />
      </div>

      <section className="nc-section">
        <h2 className="nc-section-heading">
          {folderPath ? `All notes under ${folderPath}` : 'All notes in this vault'}
        </h2>
        {notes === null ? (
          <p className="nc-empty">Loading…</p>
        ) : notes.length === 0 ? (
          <p className="nc-empty">No notes here yet.</p>
        ) : (
          <ul className="nc-list">
            {notes.map((note) => (
              <li key={note.path}>
                <Link
                  to={`/vaults/${vaultId}/note?path=${encodeURIComponent(note.path)}`}
                  className="nc-note-link"
                >
                  <span className="nc-note-name">
                    {stripMd(relativePath(note.path, folderPath))}
                  </span>
                  <span className="nc-note-time">
                    {formatNoteTimestamp(note.lastModified)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        Mobile-only add affordance. The composer matches the visual
        pattern of the assignments-page Add button: a single button
        at the bottom that swaps into an inline composer when tapped.
        Desktop folder views deliberately skip this — note/folder
        creation belongs in the tree rail there.
      */}
      {isMobile && (
        <FolderAddRow
          folderPath={folderPath}
          siblingNoteNames={siblingNoteNames}
          siblingFolderNames={siblingFolderNames}
          onCreateNote={onCreateNote}
          onCreateFolder={onCreateFolder}
        />
      )}
    </div>
  );
}

/**
 * Compute the path of a note relative to the current folder.
 * <c>relativePath("Projects/Q4/launch.md", "Projects")</c> →
 * <c>"Q4/launch.md"</c>. Notes outside the prefix (shouldn't happen
 * for the recursive listing since the server already filters) fall
 * through to the full path.
 */
function relativePath(notePath: string, folderPath: string): string {
  if (!folderPath) return notePath;
  const prefix = folderPath + '/';
  return notePath.startsWith(prefix) ? notePath.slice(prefix.length) : notePath;
}

/** Drop the trailing `.md` so rows read like a path, not a filename. */
function stripMd(path: string): string {
  return path.toLowerCase().endsWith('.md') ? path.slice(0, -3) : path;
}

/** Last segment of a slash path. "A/B/foo.md" → "foo.md". */
function nameOnly(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

// ============================================================ FolderAddRow

interface FolderAddRowProps {
  folderPath: string;
  /** Names (lowercased, .md-stripped) of notes in this folder. */
  siblingNoteNames: string[];
  /** Names (lowercased) of subfolders in this folder. */
  siblingFolderNames: string[];
  onCreateNote: (parentPath: string, fileName: string) => Promise<void>;
  onCreateFolder: (parentPath: string, name: string) => Promise<void>;
}

/**
 * Mobile-only "Add" footer for FolderPage.
 *
 * Collapsed state: a single "+ Add note or folder" button matching
 * the .nc-assignments-add-btn styling (familiar from the
 * assignments page).
 *
 * Expanded state: an inline composer with:
 *   - kind toggle (Note / Folder pills)
 *   - name input
 *   - Cancel / Create buttons
 *
 * Inline validation:
 *   - empty rejected
 *   - slashes rejected (matches NewFolderInputRow / NewNoteInputRow)
 *   - dup names rejected case-insensitively against the right
 *     sibling list (notes for Note kind, folders for Folder kind)
 *
 * After a successful create, the composer collapses back to the
 * button. The new note (if created) will have already navigated the
 * editor; the new folder (if created) stays on this folder page —
 * the user can tap the new folder's round button on the navbar to
 * drill in.
 */
function FolderAddRow({
  folderPath,
  siblingNoteNames,
  siblingFolderNames,
  onCreateNote,
  onCreateFolder,
}: FolderAddRowProps) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'note' | 'folder'>('note');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setOpen(false);
    setKind('note');
    setName('');
    setBusy(false);
    setError(null);
  }

  function validate(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return 'Name is required.';
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      return 'Name cannot contain slashes.';
    }
    if (trimmed === '.' || trimmed === '..') return 'Reserved name.';
    const lower = trimmed.toLowerCase();
    const dup =
      kind === 'note'
        ? siblingNoteNames.includes(stripMd(lower))
        : siblingFolderNames.includes(lower);
    if (dup) {
      return kind === 'note'
        ? 'A note with that name already exists here.'
        : 'A folder with that name already exists here.';
    }
    return null;
  }

  async function submit() {
    const trimmed = name.trim();
    const v = validate(name);
    if (v) {
      setError(v);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (kind === 'note') {
        // VaultLayout's onCreateNote expects a filename WITH .md;
        // it stitches the full path internally. Match the desktop
        // tree's behaviour (NewNoteInputRow appends .md before
        // calling onCreateNote) so the server sees consistent
        // input regardless of which UI created the note.
        const filename = trimmed.toLowerCase().endsWith('.md')
          ? trimmed
          : `${trimmed}.md`;
        await onCreateNote(folderPath, filename);
      } else {
        await onCreateFolder(folderPath, trimmed);
      }
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed.');
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="nc-folder-add-row">
        <button
          type="button"
          className="nc-btn nc-folder-add-btn"
          onClick={() => setOpen(true)}
        >
          + Add note or folder
        </button>
      </div>
    );
  }

  return (
    <div className="nc-folder-add-row">
      <div className="nc-folder-add-composer">
        <div className="nc-folder-add-pills">
          <button
            type="button"
            className={[
              'nc-folder-add-pill',
              kind === 'note' ? 'nc-folder-add-pill-active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => {
              setKind('note');
              setError(null);
            }}
          >
            📄 Note
          </button>
          <button
            type="button"
            className={[
              'nc-folder-add-pill',
              kind === 'folder' ? 'nc-folder-add-pill-active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => {
              setKind('folder');
              setError(null);
            }}
          >
            📁 Folder
          </button>
        </div>
        <input
          // Native attr autofocus is OK here — the composer is opened
          // by an explicit tap, so the focus move is user-initiated
          // and doesn't trip a11y auto-focus heuristics.
          autoFocus
          type="text"
          className="nc-folder-add-input"
          value={name}
          placeholder={kind === 'note' ? 'Note name' : 'Folder name'}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              reset();
            }
          }}
          disabled={busy}
          aria-invalid={error !== null}
        />
        {error && <div className="nc-form-error">{error}</div>}
        <div className="nc-folder-add-actions">
          <button
            type="button"
            className="nc-btn"
            onClick={reset}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="nc-btn nc-btn-primary"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
