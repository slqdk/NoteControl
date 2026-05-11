import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiError, notesApi } from '../api/client';
import type { FolderListingDto, FolderSummaryDto } from '../api/types';

/**
 * The canonical name of the vault's daily-notes root folder.
 * Kept in lockstep with utils/dailyNoteDisplay.ts's DAILY_ROOT
 * constant. When the navbar sees a root folder with this exact
 * name, it renders the calendar-icon "Daily notes" button on top
 * of it (instead of a separate synthetic button) so the user
 * doesn't see two daily-notes buttons stacked together.
 *
 * Inlined here rather than imported from dailyNoteDisplay.ts so
 * the navbar's "what counts as the daily-notes folder" rule is
 * obvious when reading this file alone. Both files have a comment
 * pointing at each other; if the canonical name ever changes,
 * grep for DAILY_ROOT.
 */
const DAILY_NOTES_FOLDER = 'Daily Notes';

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

  // --------------------------------------------------- anchor override
  //
  // Ephemeral state for "I came from this anchor — keep row 2 anchored
  // here even though the URL says otherwise".
  //
  // Currently only the Daily Notes button uses this. The user wants
  // tapping Daily Notes to:
  //   (a) open today's note in the editor, AND
  //   (b) show the Daily Notes folder's *immediate* children (year
  //       folders) in row 2 — NOT the URL-derived month folder that
  //       today's note actually lives in.
  //
  // Without this override, after the navigation to today's note, the
  // child-row logic below would compute the URL-derived parent
  // (`Daily Notes/2026/05-May`) and show that month's day files. The
  // user explicitly wants the top of the Daily Notes structure
  // instead — the override pins it there until they navigate elsewhere.
  //
  // Cleared by every other anchor-row tap (Assignments, a different
  // root folder) and by any tap on a row-2 child — at that point the
  // user has explicitly chosen "go somewhere", and the URL-derived
  // logic should take over again.
  //
  // Not persisted: a refresh / deep-link starts with no override,
  // which is correct — a bookmarked /note?path=Daily Notes/... URL
  // shouldn't pretend the user came from the Daily Notes anchor.
  const [anchorOverride, setAnchorOverride] = useState<string | null>(null);

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
  //   - When anchorOverride is set: that folder, unconditionally.
  //
  // The override is checked first. It only stays effective while the
  // URL's active root segment matches the override — if the user
  // navigates to a different root folder, the URL-derived logic wins
  // (the override is also cleared explicitly by the row-1 / row-2
  // tap handlers below, but this guard keeps us correct even if a
  // navigation happens via the back button or a deep-link).
  //
  // Returning null for vault root is deliberate. Row 1 already shows
  // the root's child folders as round buttons; duplicating them in
  // row 2 would be noise. Row 2's purpose kicks in once the user has
  // drilled below root.
  const childRowTarget: string | null = (() => {
    if (anchorOverride !== null && activeRootSegment === anchorOverride) {
      return anchorOverride;
    }
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

  // Row-1 / row-2 navigation handlers clear the anchor override.
  // The override exists to keep row 2 pinned to a parent even
  // though the URL is on a child — once the user explicitly taps
  // a navigation button, they're saying "go there", and the URL
  // is again the source of truth.
  function navigateToFolder(path: string) {
    setAnchorOverride(null);
    if (path === '') {
      navigate(`/vaults/${vaultId}`);
    } else {
      navigate(`/vaults/${vaultId}?path=${encodeURIComponent(path)}`);
    }
  }

  function navigateToNote(path: string) {
    setAnchorOverride(null);
    navigate(`/vaults/${vaultId}/note?path=${encodeURIComponent(path)}`);
  }

  function handleSelectAssignments() {
    setAnchorOverride(null);
    onSelectAssignments();
  }

  // The Daily Notes button: open today's note AND pin row 2 to the
  // Daily Notes folder's immediate children (year folders) until the
  // user navigates elsewhere. Order matters here only in that the
  // override is set synchronously; onOpenDailyNote fires its own
  // async POST + navigation, but the override is already in place
  // by the time the navigation lands.
  function handleSelectDailyNotes() {
    setAnchorOverride(DAILY_NOTES_FOLDER);
    onOpenDailyNote();
  }

  // --------------------------------------------------- render

  const rootFolders: FolderSummaryDto[] = rootListing?.subfolders ?? [];

  return (
    <nav className="nc-mobile-nav" aria-label="Vault navigation">
      {/* Row 1 — anchor row. Always rendered. Horizontally scrollable
          (overflow-x: auto in CSS) so long lists of root folders
          don't wrap or get clipped.

          Order is FIXED, not alphabetical:
            1. Assignments        (fixed identity, always position 1)
            2. Daily Notes        (fixed identity, always position 2)
            3..N. The rest of the root folders, in the server's
                  natural order, with the "Daily Notes" folder
                  filtered out (it's hoisted to position 2 above).

          Pinning Daily Notes here means it appears in the same
          place regardless of vault name — the user doesn't have to
          scroll past alphabetically-earlier folders to find it.
      */}
      <div className="nc-mobile-nav-row nc-mobile-nav-anchors">
        {/* Position 1 — Assignments. Fixed icon + colour. */}
        <MobileNavButton
          label="Assignments"
          icon="📋"
          colorKey="amber"
          active={current.kind === 'assignments'}
          onClick={handleSelectAssignments}
        />

        {/*
          Position 2 — Daily Notes. Always rendered, even when the
          vault has no "Daily Notes" folder yet — the server's
          openToday endpoint creates the folder + today's file on
          first call, so tapping the button in a fresh vault works
          and the folder appears in subsequent renders.

          Tapping this button:
            (a) navigates to today's daily note in the editor
                (via VaultLayout's onOpenDailyNote → dailyNotesApi.openToday)
            (b) sets the anchor override so row 2 shows the Daily
                Notes folder's immediate children (year folders),
                NOT the URL-derived month folder that today's note
                actually lives in. The user explicitly wanted both.

          Active ring lights up while the override is active —
          consistent with how the other anchor buttons indicate
          "you came from here".
        */}
        <MobileNavButton
          label="Daily notes"
          icon="📅"
          colorKey="teal"
          active={anchorOverride === DAILY_NOTES_FOLDER}
          onClick={handleSelectDailyNotes}
        />

        {/*
          Positions 3..N — other root folders, in the server's
          natural order, filtered to exclude Daily Notes (which is
          rendered above at position 2). All use the same neutral-
          grey treatment — the user disliked the per-folder hashed
          colours. Folder labels carry the identity; the circle is
          tap-target chrome.
        */}
        {rootFolders
          .filter((folder) => folder.name !== DAILY_NOTES_FOLDER)
          .map((folder) => (
            <MobileNavButton
              key={folder.path}
              label={folder.name}
              icon="📁"
              // colorKey is unused for plain folders — they all share
              // the neutral grey class instead. 'folder' is the
              // sentinel that MobileNavButton interprets as "use the
              // neutral-grey class, not a palette class".
              colorKey="folder"
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
 * Colour-key handling:
 *   - 'folder' (sentinel)     → neutral grey backdrop, via
 *                               .nc-mobile-nav-btn-circle-folder.
 *                               Used for plain folders in both row 1
 *                               and row 2; the user disliked the
 *                               per-folder hashed colours.
 *   - 'amber' | 'teal' | …    → one of the 8 vault palette classes
 *                               (.nc-vault-avatar-{name}). Used for
 *                               the fixed-identity anchor buttons
 *                               (Assignments, Daily notes, neutral-
 *                               teal note chips on row 2).
 *
 * The wrapping <button> is borderless and transparent; the colour
 * lives on the inner circle so the focus ring (when keyboard-
 * navigated) lands on the whole control without fighting the
 * circle's background colour.
 */
function MobileNavButton({
  label,
  icon,
  colorKey,
  active,
  onClick,
}: MobileNavButtonProps) {
  // 'folder' is a non-palette sentinel — map it to the dedicated
  // neutral-grey class instead of mangling .nc-vault-avatar-folder
  // (which doesn't exist). Any other colorKey is assumed to be a
  // vault palette name and uses the matching .nc-vault-avatar-*
  // class straight.
  const circleColorClass =
    colorKey === 'folder'
      ? 'nc-mobile-nav-btn-circle-folder'
      : `nc-vault-avatar-${colorKey}`;

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
        className={`nc-mobile-nav-btn-circle ${circleColorClass}`}
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
          // Same neutral-grey treatment as row 1's plain folders —
          // the user wanted the per-folder hashed colours gone
          // everywhere, not just on the anchor row.
          colorKey="folder"
          active={activeFolderPath === sub.path}
          onClick={() => onNavigateFolder(sub.path)}
        />
      ))}
      {notes.map((note) => (
        <MobileNavButton
          key={`note:${note.path}`}
          label={stripMd(note.name)}
          icon="📄"
          /* Notes get a single neutral teal. With both folders and
             notes now using flat colours (grey vs teal), the two
             kinds stay distinguishable at small button widths
             where the label can be cut off. */
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
