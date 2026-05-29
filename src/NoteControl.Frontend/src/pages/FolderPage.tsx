import { useEffect, useMemo, useState } from 'react';
import { Link, useOutletContext, useParams, useSearchParams } from 'react-router-dom';

import { ApiError, notesApi } from '../api/client';
import type { NoteSummaryDto } from '../api/types';
import { SearchBox } from '../components/SearchBox';
import type { VaultLayoutContext } from '../components/VaultLayout';
import { useIsMobile } from '../hooks/useIsMobile';
import { formatAbsoluteDateShort, formatNoteTimestamp } from '../utils/time';

/**
 * Main view for a folder.
 *
 * Layout, top → bottom:
 *   1. Folder title (full path, breadcrumb-style)
 *   2. Search box, scoped to this folder + descendants
 *   3. All notes under this folder, recursively, grouped by lifecycle
 *      state. Section order: Released → Under development →
 *      Not versioned. Within each section the rows stay sorted
 *      most-recently-updated first. Each row's label is the path
 *      **relative to the current folder**, with the .md stripped,
 *      split into a greyed folder-prefix and a black filename:
 *        - viewing root  →  greyed "Projects/Q4/" + black "launch"
 *        - viewing root, note at root → greyed "./" + black "launch"
 *        - viewing Projects → greyed "Q4/" + black "launch"
 *      Versioned rows get a `v{major}.{minor}` pill before the
 *      timestamp; unversioned rows just show the timestamp.
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
  const { vault, canEdit, onCreateNote, onCreateFolder } =
    useOutletContext<VaultLayoutContext>();
  const isMobile = useIsMobile();

  const [notes, setNotes] = useState<NoteSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Cover image URL, populated from the (non-recursive) folder
   * listing fetch below. Server-built and already cache-busted via
   * `?v=<unix-ms>`; we just drop it into `<img src>`. Null means
   * "no cover" — render nothing above the search.
   */
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  // -------------------------------------------------------------------
  // Listing of the CURRENT folder (not the recursive flat list above).
  // We need this for three reasons:
  //   1. Duplicate-name validation in the Add composer — checking
  //      against `notes` above wouldn't catch a clash because that
  //      list is recursive (a note named "foo" deep in a subfolder
  //      doesn't clash with a new "foo" at this level).
  //   2. To know what folders already exist at this level for the
  //      "new folder name" dup check.
  //   3. To pick up the per-folder cover URL (FolderListingDto.coverUrl)
  //      and render the cover banner above the search. (Cover URL is
  //      on FolderListingDto rather than the recursive endpoint —
  //      that one returns a flat note list, not a folder summary.)
  //
  // The sibling-name lists are only consumed by the mobile Add
  // composer, but the listing call itself runs on both desktop and
  // mobile now — the cover URL is needed everywhere. Loaded once per
  // folderPath change. Errors from this fetch are silently dropped —
  // the composer falls back to "trust the server" (the create endpoint
  // will reject duplicates with a clear error message) so a transient
  // listing failure doesn't block creation or hide the recursive note
  // list above; it just means no cover banner this paint.
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

  // Non-recursive listing — drives the mobile Add-composer's dup
  // validation AND the cover-banner state for both desktop and mobile.
  // We could combine it with the recursive effect above, but recursive
  // vs flat are two different API calls and conflating them muddies
  // the loading state (the flat list drives the "Loading…" UI; the
  // immediate listing shouldn't gate that paint).
  //
  // listenerToken (refreshTick) bumps whenever the PropertiesPanel
  // notifies the page that a cover has changed, so we re-fetch and
  // the banner updates without a page reload. The event is documented
  // alongside the dispatch (see PropertiesPanel folder-cover handlers).
  const [coverRefreshTick, setCoverRefreshTick] = useState(0);
  useEffect(() => {
    if (!vaultId) return;
    let cancelled = false;
    (async () => {
      try {
        const listing = await notesApi.listFolder(vaultId, folderPath);
        if (cancelled) return;
        setCoverUrl(listing.coverUrl ?? null);
        // Sibling-name lists are only consumed by the mobile composer
        // but cheap to compute either way (small array transforms).
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
        // We just lose the inline pre-submit warning AND the cover
        // banner in this case. Both are non-blocking concerns.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId, folderPath, coverRefreshTick]);

  // Listen for cover-changed dispatches from the PropertiesPanel.
  // Dispatched after a successful upload OR delete; carries the
  // affected folderPath in detail so we only refetch when it matches
  // the folder we're currently rendering (prevents cross-folder
  // flicker if the user uploads a cover for folder A while viewing
  // folder B in another window-state and then nav-back).
  useEffect(() => {
    function onChanged(e: Event) {
      const detail = (e as CustomEvent<{ folderPath: string }>).detail;
      if (detail && detail.folderPath === folderPath) {
        setCoverRefreshTick((t) => t + 1);
      }
    }
    window.addEventListener('nc:folder-cover-changed', onChanged);
    return () => {
      window.removeEventListener('nc:folder-cover-changed', onChanged);
    };
  }, [folderPath]);

  // Partition the recursive listing by lifecycle state. The server
  // already returns the rows sorted by mtime DESC, so each per-state
  // bucket inherits that ordering "for free" — we just bucket without
  // re-sorting. useMemo keeps this stable across re-renders that don't
  // change the listing (e.g. a cover refetch shouldn't reshuffle).
  const grouped = useMemo(() => groupByState(notes), [notes]);

  if (!vaultId) {
    return null;
  }

  return (
    <div className="nc-page">
      <h1 className="nc-page-title">
        {folderPath || (vault?.name ?? 'Folder')}
      </h1>

      {error && <div className="nc-form-error">{error}</div>}

      {/*
        Per-folder cover banner. Renders ONLY when the server told us
        there's a cover for this folder. Image displays at its
        natural intrinsic size (max-width capped at 100% so a wider
        image scales down to the content column, preserving aspect
        ratio via height: auto in CSS). No fallback / placeholder
        when there's no cover — the layout simply has no banner.
      */}
      {coverUrl && (
        <div className="nc-folder-cover">
          <img
            src={coverUrl}
            alt=""
            // Mark decorative — the cover is visual context, not
            // information conveyed only by the image. Empty alt is
            // the correct ARIA hint here.
          />
        </div>
      )}

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
          /*
            Three lifecycle-state groups, top to bottom:
              Released → Under development → Not versioned
            Empty groups are skipped — we don't render a heading for
            a section that has zero rows. Within each group, rows are
            already in newest-updated-first order (server-side sort).
          */
          <>
            {grouped.released.length > 0 && (
              <StateGroup
                kind="released"
                label="Released"
                notes={grouped.released}
                vaultId={vaultId}
                folderPath={folderPath}
              />
            )}
            {grouped.development.length > 0 && (
              <StateGroup
                kind="development"
                label="Under development"
                notes={grouped.development}
                vaultId={vaultId}
                folderPath={folderPath}
              />
            )}
            {grouped.notVersioned.length > 0 && (
              <StateGroup
                kind="notVersioned"
                label="Not versioned"
                notes={grouped.notVersioned}
                vaultId={vaultId}
                folderPath={folderPath}
              />
            )}
          </>
        )}
      </section>

      {/*
        Mobile-only add affordance. The composer matches the visual
        pattern of the assignments-page Add button: a single button
        at the bottom that swaps into an inline composer when tapped.
        Desktop folder views deliberately skip this — note/folder
        creation belongs in the tree rail there.

        Hidden for viewers: every action it offers (create note,
        create folder) would 403 server-side. The mobile centre
        pane stays useful read-only — recursive notes list still
        renders, links to notes still navigate to read-only editor.
      */}
      {isMobile && canEdit && (
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

// ============================================================ StateGroup

type StateKind = 'released' | 'development' | 'notVersioned';

interface StateGroupProps {
  kind: StateKind;
  label: string;
  notes: NoteSummaryDto[];
  vaultId: string;
  folderPath: string;
}

/**
 * One lifecycle-state section of the recursive list: a heading
 * (with state badge for released/development), then a compact list
 * of rows. Each row splits the relative path into a greyed prefix
 * and a black filename, appends an optional version pill, and ends
 * with the timestamp.
 *
 * The badge here is a section-level marker, NOT a per-row one —
 * the heading carries the state, so individual rows don't repeat it.
 * This matches the user's mental model: "I'm looking at the released
 * notes" rather than "this note is green-ticked".
 */
function StateGroup({ kind, label, notes, vaultId, folderPath }: StateGroupProps) {
  return (
    <div className="nc-state-group">
      <h3 className={`nc-state-heading nc-state-heading-${kind}`}>
        {kind === 'released' && <span className="nc-state-badge-released">✓</span>}
        {kind === 'development' && <span className="nc-state-badge-development">●</span>}
        <span className="nc-state-heading-label">{label}</span>
        <span className="nc-state-heading-count">{notes.length}</span>
      </h3>
      <ul className="nc-list nc-list-compact">
        {notes.map((note) => {
          const rel = stripMd(relativePath(note.path, folderPath));
          const { prefix, name } = splitPathForDisplay(rel);
          const versionLabel = isVersioned(note)
            ? `v${note.versionMajor}.${note.versionMinor}`
            : null;
          return (
            <li key={note.path}>
              <Link
                to={`/vaults/${vaultId}/note?path=${encodeURIComponent(note.path)}`}
                className="nc-note-link"
                title={rel}
              >
                <span className="nc-note-name">
                  {prefix && <span className="nc-note-path-prefix">{prefix}</span>}
                  <span className="nc-note-filename">{name}</span>
                </span>
                <span className="nc-note-meta">
                  {versionLabel && (
                    <span className="nc-note-version">{versionLabel}</span>
                  )}
                  <span className="nc-note-time">
                    {formatNoteTimestamp(note.lastModified)}
                    {' · '}
                    {formatAbsoluteDateShort(note.lastModified)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ============================================================ helpers

/**
 * Bucket the (server-sorted) listing into the three lifecycle states
 * we render. The server returns a `state` string per note; we map
 * known values to a bucket and default anything we don't recognise
 * to "not versioned" so a forward-compat state value can't make a
 * row disappear from the page.
 */
interface GroupedNotes {
  released: NoteSummaryDto[];
  development: NoteSummaryDto[];
  notVersioned: NoteSummaryDto[];
}

function groupByState(notes: NoteSummaryDto[] | null): GroupedNotes {
  const out: GroupedNotes = { released: [], development: [], notVersioned: [] };
  if (!notes) return out;
  for (const note of notes) {
    if (note.state === 'released') {
      out.released.push(note);
    } else if (note.state === 'development') {
      out.development.push(note);
    } else {
      // Treat "not-versioned", missing, and any unknown state as the
      // unversioned bucket. We deliberately do NOT also check
      // versionMajor/versionMinor here: the server is the source of
      // truth for "this note has a lifecycle state".
      out.notVersioned.push(note);
    }
  }
  return out;
}

/**
 * A note counts as "versioned" (worth showing a version pill for) when
 * either component is non-zero. The server treats 0.0 as "not versioned"
 * and omits the state, but we guard against future inconsistency by
 * checking the numbers directly here too.
 */
function isVersioned(note: NoteSummaryDto): boolean {
  return (note.versionMajor ?? 0) > 0 || (note.versionMinor ?? 0) > 0;
}

/**
 * Split a relative note path into a "folder prefix" (greyed) and a
 * "filename" (black) for two-tone rendering. The prefix ALWAYS ends
 * with a slash so it visually attaches to the filename.
 *
 *   "MOTION/HARDWARE/Gear Noise"  →  prefix="MOTION/HARDWARE/", name="Gear Noise"
 *   "Gear Noise"                  →  prefix="./", name="Gear Noise"
 *
 * The "./" prefix is a small visual marker that says "this note lives
 * at the folder you're currently looking at" — it keeps root-level
 * rows from looking lonely next to deep-path rows and gives the eye
 * a consistent column of grey on the left.
 */
function splitPathForDisplay(relPath: string): { prefix: string; name: string } {
  const lastSlash = relPath.lastIndexOf('/');
  if (lastSlash === -1) {
    // Note sits directly under the folder we're viewing — render the
    // ./ marker so the row still has a grey prefix lane.
    return { prefix: './', name: relPath };
  }
  return {
    prefix: relPath.slice(0, lastSlash + 1),
    name: relPath.slice(lastSlash + 1),
  };
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
