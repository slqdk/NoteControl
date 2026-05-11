import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiError, notesApi } from '../api/client';
import type { FolderListingDto, FolderSummaryDto } from '../api/types';
import { colorForName } from '../util/mobileNavColors';

/**
 * Mobile redesign — always-visible round-button navigation row.
 *
 * Replaces the pre-redesign "Show Tree" collapsible strip. The user
 * wanted navigation to be one-tap and always visible on a phone, so
 * we render two stacked horizontal-scrolling rows:
 *
 *   Row 1 — anchor row:
 *     Assignments  ·  Daily notes  ·  Root folder 1  ·  Root folder 2  …
 *
 *     Anchored to the vault's root listing. Doesn't change as the
 *     user drills in. The active button (matching the current URL)
 *     gets a visual ring.
 *
 *   Row 2 — contextual children row (when applicable):
 *     subfolder · subfolder · note · note …
 *
 *     Shows the immediate children (subfolders + notes) of whatever
 *     folder the user is currently viewing. "Walks with you" — when
 *     the user navigates from Folder1 to Folder1/Sub2 the row
 *     repopulates with Sub2's children. Hidden on Assignments,
 *     dashboards, and when the active location has no children
 *     (e.g. an empty folder or a brand-new vault root).
 *
 *     On the editor (URL is /note?path=…), row 2 shows the *parent
 *     folder's* children so the user can hop to a sibling note in
 *     one tap without backing out.
 *
 * Why a separate component (not inlined into VaultLayout): the
 * mobile navigation has its own data dependency (fetching listings
 * for the current folder when it isn't already in the tree cache),
 * its own visual surface, and is mounted only on mobile. Keeping
 * the JSX out of VaultLayout's main render keeps the layout file
 * focused on the desktop+mobile shell shape rather than mobile
 * navigation specifics.
 *
 * Data flow:
 *   - Row 1 reads the root listing from props (`rootListing`); the
 *     parent (VaultLayout) already loads `''` via useTreeData on
 *     vault entry, so there's no second fetch.
 *   - Row 2 needs the current folder's listing. If the folder is
 *     already cached in `cachedListings`, use that. Otherwise fetch
 *     it lazily here. The fetch lives in this component (not in
 *     VaultLayout) because the children row is the only consumer.
 *
 * No write operations live here — the round buttons are pure
 * navigation. Note/folder CREATION lives in FolderPage's mobile
 * footer composer (see the matching changes in FolderPage.tsx).
 */
export interface MobileNavBarProps {
  vaultId: string;
  /** Root listing of the vault. May be null while still loading. */
  rootListing: FolderListingDto | null;
  /**
   * Pre-cached listings keyed by folder path. Read-through cache:
   * if the current folder isn't here, we fetch it ourselves. Lets
   * the tree's already-loaded folders be reused on mobile without
   * a second round-trip per folder.
   */
  cachedListings: ReadonlyMap<string, FolderListingDto>;
  /**
   * Current URL path inside the vault. One of:
   *   - ''            → vault root folder
   *   - 'A/B'         → folder /A/B (any depth)
   *   - { kind: 'note', path: 'A/B/foo.md' }  → editor on this note
   *   - { kind: 'assignments' }
   *   - { kind: 'dashboard' }
   */
  current: MobileNavCurrent;

  onSelectAssignments: () => void;
  onOpenDailyNote: () => void;
}

export type MobileNavCurrent =
  | { kind: 'folder'; path: string }
  | { kind: 'note'; path: string }
  | { kind: 'assignments' }
  | { kind: 'dashboard' };

export function MobileNavBar({
  vaultId,
  rootListing,
  cachedListings,
  current,
  onSelectAssignments,
  onOpenDailyNote,
}: MobileNavBarProps) {
  const navigate = useNavigate();

  // --------------------------------------------------- active root segment
  //
  // The root folder whose round button gets the active ring on row 1.
  // Derived from the current URL:
  //   - folder root ''           → no active folder button
  //   - folder 'A/B/C'           → 'A'
  //   - editor note 'A/B/foo.md' → 'A'
  //   - assignments / dashboard  → no active folder button
  const activeRootSegment: string | null = (() => {
    if (current.kind === 'assignments' || current.kind === 'dashboard') return null;
    if (current.path === '') return null;
    const first = current.path.split('/')[0];
    return first || null;
  })();

  // --------------------------------------------------- target folder for row 2
  //
  // Row 2 shows the children of "where the user is right now":
  //   - On a folder view: the folder itself (its subfolders + notes).
  //   - On the editor:    the note's parent folder.
  //   - On Assignments / dashboards / vault root: hidden (null).
  //
  // Returning null for vault root is deliberate. Row 1 already shows
  // the root's child folders as round buttons; duplicating them in
  // row 2 would be noise. Row 2's purpose kicks in once the user has
  // drilled below root.
  const childRowTarget: string | null = (() => {
    if (current.kind === 'assignments' || current.kind === 'dashboard') return null;
    if (current.kind === 'folder') {
      return current.path === '' ? null : current.path;
    }
    // note view → parent folder; '' (root parent) means "show vault root
    // notes", which IS useful even though we hide the equivalent for
    // folder views. The note's siblings include other root-level notes
    // and root-level subfolders; on a phone that's a one-tap hop the
    // user wants.
    const idx = current.path.lastIndexOf('/');
    return idx === -1 ? '' : current.path.slice(0, idx);
  })();

  // --------------------------------------------------- row 2 data fetch
  //
  // If the listing for childRowTarget isn't already cached (the user
  // may have arrived here via URL without ever expanding the tree),
  // fetch it. Cache cleared per-target; switching targets while a
  // previous fetch is in flight lets the new fetch take over.
  const [fetched, setFetched] = useState<{
    path: string;
    listing: FolderListingDto;
  } | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (childRowTarget === null) return;
    if (cachedListings.has(childRowTarget)) {
      // Already in tree cache; no need for our own fetch.
      setFetched(null);
      setFetchError(null);
      return;
    }
    // Not cached — fetch.
    let cancelled = false;
    setFetched(null);
    setFetchError(null);
    (async () => {
      try {
        const listing = await notesApi.listFolder(vaultId, childRowTarget);
        if (!cancelled) {
          setFetched({ path: childRowTarget, listing });
        }
      } catch (e) {
        if (!cancelled) {
          const message =
            e instanceof ApiError ? e.message : 'Could not load folder.';
          setFetchError(message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId, childRowTarget, cachedListings]);

  // Resolve the row-2 listing: tree cache first, then our own fetch.
  const childListing: FolderListingDto | null =
    childRowTarget === null
      ? null
      : cachedListings.get(childRowTarget) ??
        (fetched && fetched.path === childRowTarget ? fetched.listing : null);

  // --------------------------------------------------- handlers

  function navigateToFolder(path: string) {
    if (path === '') {
      navigate(`/vaults/${vaultId}`);
    } else {
      navigate(`/vaults/${vaultId}?path=${encodeURIComponent(path)}`);
    }
  }

  function navigateToNote(path: string) {
    navigate(`/vaults/${vaultId}/note?path=${encodeURIComponent(path)}`);
  }

  // --------------------------------------------------- render

  const rootFolders: FolderSummaryDto[] = rootListing?.subfolders ?? [];

  return (
    <nav className="nc-mobile-nav" aria-label="Vault navigation">
      {/* Row 1 — anchor row. Always rendered. Horizontally scrollable
          (overflow-x: auto in CSS) so long lists of root folders
          don't wrap or get clipped. */}
      <div className="nc-mobile-nav-row nc-mobile-nav-anchors">
        {/* Assignments — fixed icon + colour. Spec: 📋 + amber. */}
        <MobileNavButton
          label="Assignments"
          icon="📋"
          colorKey="amber"
          active={current.kind === 'assignments'}
          onClick={onSelectAssignments}
        />
        {/* Daily notes — fixed icon + colour. Spec: 📅 + teal.
            Click = open today (delegates to VaultLayout's existing
            handler which creates today's note if missing). */}
        <MobileNavButton
          label="Daily notes"
          icon="📅"
          colorKey="teal"
          active={false /* no good way to tell "this note IS today"
                            without parsing the path; leave un-ringed
                            so the daily-note round button reads as
                            an action, not a destination */}
          onClick={onOpenDailyNote}
        />
        {/* Root folders — one button per. Colour is hashed from the
            folder name (stable across mounts). Icon is the folder
            emoji 📁 for now; future ship could let the user pick a
            per-folder icon the same way vaults already work. */}
        {rootFolders.map((folder) => (
          <MobileNavButton
            key={folder.path}
            label={folder.name}
            icon="📁"
            colorKey={colorForName(folder.name)}
            active={activeRootSegment === folder.name}
            onClick={() => navigateToFolder(folder.path)}
          />
        ))}
      </div>

      {/* Row 2 — contextual children. Rendered only when there's a
          meaningful target AND its listing has at least one child.
          The row is below row 1 in the DOM so it appears stacked
          beneath it visually. Hides cleanly when not applicable. */}
      {childRowTarget !== null && (
        <MobileNavChildrenRow
          listing={childListing}
          fetchError={fetchError}
          activeFolderPath={
            current.kind === 'folder' ? current.path : null
          }
          activeNotePath={
            current.kind === 'note' ? current.path : null
          }
          onNavigateFolder={navigateToFolder}
          onNavigateNote={navigateToNote}
        />
      )}
    </nav>
  );
}

// ============================================================ MobileNavButton

interface MobileNavButtonProps {
  label: string;
  icon: string;
  colorKey: string;
  active: boolean;
  onClick: () => void;
}

/**
 * One round button — coloured circle with an icon glyph, label
 * underneath. Active state adds a ring via .nc-mobile-nav-btn-active.
 *
 * Visually the circle reuses the same colour tokens as VaultAvatar
 * (.nc-vault-avatar-{color} classes) so we don't duplicate the 8
 * palette hex values. The wrapping <button> is borderless and
 * transparent; the colour lives on the inner circle so the focus
 * ring (when keyboard-navigated) lands on the whole control without
 * fighting the circle's background colour.
 */
function MobileNavButton({
  label,
  icon,
  colorKey,
  active,
  onClick,
}: MobileNavButtonProps) {
  return (
    <button
      type="button"
      className={[
        'nc-mobile-nav-btn',
        active ? 'nc-mobile-nav-btn-active' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
      aria-pressed={active}
      title={label}
    >
      <span
        className={`nc-mobile-nav-btn-circle nc-vault-avatar-${colorKey}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="nc-mobile-nav-btn-label">{label}</span>
    </button>
  );
}

// ============================================================ ChildrenRow

interface MobileNavChildrenRowProps {
  listing: FolderListingDto | null;
  fetchError: string | null;
  /** Currently-viewed folder path, if any (folder view). */
  activeFolderPath: string | null;
  /** Currently-open note path, if any (editor view). */
  activeNotePath: string | null;
  onNavigateFolder: (path: string) => void;
  onNavigateNote: (path: string) => void;
}

/**
 * Renders row 2 — the children of the currently-viewed folder.
 *
 * Two child kinds, both clickable round buttons:
 *   - subfolders → smaller round circles with 📁 + hashed colour
 *   - notes      → smaller round circles with 📄 + neutral colour
 *
 * We deliberately use smaller circles than row 1 so the visual
 * hierarchy reads as "row 1 = primary anchors, row 2 = drill-down".
 * Same .nc-mobile-nav-btn class, plus .nc-mobile-nav-btn-small for
 * the CSS size override.
 *
 * Render outcomes (in priority order):
 *   1. Fetch error → small inline message; nothing else.
 *   2. Loading (listing null, no error) → render nothing rather than
 *      a spinner. Row 2 is supplementary navigation; flashing a
 *      spinner on every folder change would be more distracting than
 *      a 200ms delay before the chips appear.
 *   3. Empty (no subfolders + no notes) → the parent skips rendering
 *      this row entirely (see the !empty gate above); we never see
 *      a "no children" state here.
 *   4. Has children → render them. Notes are stripped of .md for
 *      display (the user knows the format).
 */
function MobileNavChildrenRow({
  listing,
  fetchError,
  activeFolderPath,
  activeNotePath,
  onNavigateFolder,
  onNavigateNote,
}: MobileNavChildrenRowProps) {
  if (fetchError) {
    return (
      <div className="nc-mobile-nav-row nc-mobile-nav-children nc-mobile-nav-error">
        {fetchError}
      </div>
    );
  }
  if (!listing) {
    // Loading — render an empty row to reserve space, but nothing
    // visible. Could swap for a skeleton later if needed.
    return null;
  }

  const subfolders = listing.subfolders ?? [];
  const notes = listing.notes ?? [];
  if (subfolders.length === 0 && notes.length === 0) {
    // Empty folder → no row at all. The active-folder button on
    // row 1 already signals where the user is; no need for an
    // empty trailing row.
    return null;
  }

  return (
    <div className="nc-mobile-nav-row nc-mobile-nav-children">
      {subfolders.map((sub) => (
        <MobileNavButton
          key={`folder:${sub.path}`}
          label={sub.name}
          icon="📁"
          colorKey={colorForName(sub.name)}
          active={activeFolderPath === sub.path}
          onClick={() => onNavigateFolder(sub.path)}
        />
      ))}
      {notes.map((note) => (
        <MobileNavButton
          key={`note:${note.path}`}
          label={stripMd(note.name)}
          icon="📄"
          /* Notes always get a neutral teal — distinct from the
             colour-hashed folder circles so the two kinds are
             distinguishable at a glance even when the labels are
             cut off by the small circle width. Could be tuned to a
             grey if teal collides too often with a sibling folder. */
          colorKey="teal"
          active={activeNotePath === note.path}
          onClick={() => onNavigateNote(note.path)}
        />
      ))}
    </div>
  );
}

function stripMd(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}
