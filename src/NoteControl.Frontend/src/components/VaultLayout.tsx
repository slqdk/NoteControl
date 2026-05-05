import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';

import type { VaultDto } from '../api/types';
import { ApiError, dailyNotesApi, foldersApi, notesApi, vaultsApi } from '../api/client';
import { TopBar } from './TopBar';
import { TreeView, type TreeSelection } from './TreeView';
import { TreeContextMenu } from './TreeContextMenu';
import { PropertiesPanel } from './PropertiesPanel';
import { ResizableRail } from './ResizableRail';
import { ToggleRailButtons } from './ToggleRailButtons';
import {
  useTreeData,
  useRailLayout,
  useNewFolderPrompt,
  useNewNotePrompt,
  useRenamePrompt,
} from '../tree/treeState';
import { loadVariant, type TreeVariant } from '../tree/treeStyles';
import { useTreeAppearance, buildTreeStyle } from '../tree/treeAppearance';
import { useIsMobile } from '../hooks/useIsMobile';

/**
 * Top-level vault shell. Owns:
 *   - tree data (expanded, cached children)
 *   - tree selection
 *   - rail visibility + widths
 *   - tree variant
 *   - context menu open/close
 *   - inline prompts (new folder, new note, rename)
 *   - the vault's metadata (fetched here once, displayed in TopBar)
 *
 * As of the "stop reloading the tree" ship this is now mounted by a
 * layout route, with the actual page content rendered through
 * <Outlet />. Navigating folder ↔ note within the same vault no
 * longer re-mounts this component, so the tree's cached state
 * (expanded folders, fetched listings, current selection) persists
 * across navigations.
 *
 * Selection-from-URL: because the layout no longer re-mounts, we
 * also can't rely on `initialSelection` to set the highlight. An
 * effect below derives selection from the current URL whenever the
 * route changes — clicking a note in the tree, opening a note URL
 * directly, or hitting the back button all keep the highlight in
 * sync.
 *
 * Ship 81 — Mobile shell.
 *   At ≤768px viewport the layout flips to single-column:
 *     1. Topbar (compact)
 *     2. Tree rail across full width, collapsed by default to a
 *        single-row strip. Tap to expand the strip into the full
 *        tree (still inline; no overlay). Tapping a note collapses
 *        the strip again so the editor takes the full screen.
 *     3. Main content (folder page / editor) below.
 *     4. Properties panel hidden entirely on mobile — the editable
 *        fields will return as a bottom-of-note collapsible in a
 *        later ship.
 *   The user's persisted desktop preferences for treeVisible and
 *   propsVisible are LEFT ALONE while on mobile, so switching back
 *   to desktop restores their setup. Mobile uses its own ephemeral
 *   tree-strip state instead.
 */
export function VaultLayout() {
  const { vaultId: vaultIdParam } = useParams<{ vaultId: string }>();
  // The route guarantees :vaultId is present; coerce now so all the
  // hooks below get a stable string. The bail-out happens AFTER the
  // hooks (further down) — calling hooks conditionally would violate
  // the Rules of Hooks.
  const vaultId = vaultIdParam ?? '';

  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const treeData = useTreeData(vaultId);
  const layout = useRailLayout();
  const newFolder = useNewFolderPrompt();
  const newNote = useNewNotePrompt();
  const rename = useRenamePrompt();

  // Ship 81 — mobile detection. Drives layout shape: when true, force
  // tree-on-top single-column flow and hide the props rail. The
  // user's desktop layout preferences are left untouched in
  // localStorage so flipping back to a wide viewport restores them.
  const isMobile = useIsMobile();

  // Ship 88: tree expanded by default on vault entry, but auto-
  // collapses when the URL becomes a note path. The user wants to
  // see the tree on arrival to navigate, but once they're reading
  // a note the tree should get out of the way. They can re-expand
  // manually via the chevron toggle when they want to switch notes.
  //
  // This was Ship 81's original behaviour. Ship 87 removed the
  // auto-collapse to keep the tree always-visible; Ship 88 reverts
  // that part because the user found "tree always above editor"
  // ate too much screen space when reading.
  //
  // Initial state is derived from the URL so a direct deep-link
  // to a note (e.g. a bookmarked /note URL opened cold) doesn't
  // flash the tree open for one paint frame before the effect
  // collapses it. If the URL is already on a note path on mount,
  // start collapsed; otherwise start expanded.
  const [mobileTreeExpanded, setMobileTreeExpanded] = useState(
    () => !location.pathname.endsWith('/note'),
  );

  useEffect(() => {
    if (!isMobile) return;
    if (location.pathname.endsWith('/note')) {
      setMobileTreeExpanded(false);
    }
  }, [isMobile, location.pathname, searchParams]);

  // Ship 80: the variant picker is gone (compact-only) but we keep
  // the variant STATE itself because TreeView still reads it to
  // pick its CSS class. loadVariant() always returns 'compact' for
  // first-time users; existing users who saved 'comfortable' will
  // also keep working since the dead CSS rule is still in place.
  // We no longer need a setter wrapper since the picker that called
  // it is gone.
  const [variant] = useState<TreeVariant>(() => loadVariant());

  const treeAppearance = useTreeAppearance();

  const [selection, setSelection] = useState<TreeSelection | null>(null);
  const [vault, setVault] = useState<VaultDto | null>(null);
  // Ship 91: full list of vaults the caller can see, kept in state so
  // the topbar VaultPicker can render alternatives + the appearance
  // popover's optimistic update has a place to splice changes back
  // into. Pre-Ship-91 the list-fetch effect threw the result away
  // after picking out the active vault.
  const [allVaults, setAllVaults] = useState<VaultDto[]>([]);

  /*
    Step 36: which row (if any) is currently in "move mode" — armed
    for dragging via the Properties panel's Move button. Setting this
    puts that row into a draggable state in TreeView; everything else
    remains a passive drop target.

    Cleared via:
      - successful drop (TreeView's onDragEnd → onMoveModeExit)
      - aborted drag (drop on invalid / outside / Esc-during-drag)
      - user clicked Move again to toggle off (PropertiesPanel callback)
      - user changed selection to a different item (effect below)
      - user pressed Esc while not dragging (clears selection, which
        triggers the selection-change effect below)
  */
  const [moveModeItem, setMoveModeItem] = useState<TreeSelection | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    selection: TreeSelection;
    x: number;
    y: number;
  } | null>(null);

  // Step 36: when the selection changes (or clears), exit move mode
  // automatically. This makes "click another row" cancel the move-
  // armed state — no extra Cancel shortcut needed. It also handles
  // the Esc-clears-selection path: the existing Esc handler clears
  // selection, which fires this effect, which clears moveModeItem.
  // No need for a separate Esc listener for move mode.
  useEffect(() => {
    if (moveModeItem === null) return;
    const sameSelection =
      selection !== null
      && selection.kind === moveModeItem.kind
      && selection.path === moveModeItem.path;
    if (!sameSelection) {
      setMoveModeItem(null);
    }
  }, [selection, moveModeItem]);

  // -----------------------------------------------------------------
  // Step 39: per-vault Startpage.
  //
  // Detect whether the URL is currently the startpage. Drives:
  //   1. The pinned Startpage row's highlight in the tree.
  //   2. Suppression of the Properties panel while on this page.
  //
  // We compare against an exact pathname rather than .endsWith so a
  // future /vaults/:id/startpage/something doesn't accidentally
  // count as "on the startpage." If we ever add nested routes here,
  // switch to startsWith with a trailing slash.
  // -----------------------------------------------------------------
  const isOnStartpage =
    location.pathname === `/vaults/${vaultId}/startpage`;

  // Auto-hide override for the props panel: NEVER persist this to
  // localStorage — we want the user's preferred propsVisible setting
  // to come back when they leave the startpage. So we compute an
  // "effective" visibility here and use it for rendering, but leave
  // layout.propsVisible alone.
  //
  // Ship 81: also hide the props panel entirely on mobile. Same
  // pattern — don't touch the persisted preference, just override
  // for the duration of the mobile viewport.
  const effectivePropsVisible =
    layout.propsVisible && !isOnStartpage && !isMobile;

  // Ship 81: on mobile the tree is always rendered (it's the
  // navigation primary), but its content collapses to a single-row
  // strip when mobileTreeExpanded is false. Desktop respects the
  // user's persisted treeVisible preference exactly as before.
  const effectiveTreeVisible = isMobile ? true : layout.treeVisible;

  /**
   * Click handler for the synthetic Startpage row.
   * Clears any current selection (so no folder/note row stays
   * highlighted in parallel), exits move mode if active (mirrors
   * what selection-change does for normal rows), and navigates.
   */
  const onSelectStartpage = useCallback(() => {
    setSelection(null);
    setMoveModeItem(null);
    navigate(`/vaults/${vaultId}/startpage`);
    // Ship 87: removed the auto-collapse of the mobile tree strip
    // here. The user wants the tree to stay open after navigating.
    // (And anyway, Ship 86 redirects mobile users away from the
    // startpage URL, so this branch never runs on mobile in
    // practice.)
  }, [navigate, vaultId]);

  // ---------------------------------------------------- vault metadata
  //
  // Fetched once per vault. Used by TopBar for the "NoteControl /
  // <vaultName>" breadcrumb. Pre-refactor, each page fetched this
  // independently; now the layout owns it so we don't refetch on
  // every folder-↔-note navigation.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await vaultsApi.list();
        if (cancelled) return;
        // Ship 91: store the full list AND set the active vault from
        // it. The picker reads `allVaults` for alternatives;
        // pre-Ship-91 the list was discarded after the find().
        setAllVaults(all);
        setVault(all.find((v) => v.id === vaultId) ?? null);
      } catch {
        if (!cancelled) {
          setAllVaults([]);
          setVault(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  // ---------------------------------------------------- selection ↔ URL
  //
  // Derive selection from the current URL on every route change.
  // Three cases:
  //   /vaults/:vaultId                → no selection  (root view)
  //   /vaults/:vaultId?path=foo/bar    → folder selection at foo/bar
  //   /vaults/:vaultId/note?path=...   → note selection at that path
  //
  // We update via setSelection only when the derived value differs,
  // to avoid a render loop with the user-driven onSelect path.
  useEffect(() => {
    const path = searchParams.get('path') ?? '';
    const isNotePath = location.pathname.endsWith('/note');

    let next: TreeSelection | null = null;
    if (isNotePath && path) {
      next = { kind: 'note', path, name: nameFromPath(path) };
    } else if (!isNotePath && path) {
      next = { kind: 'folder', path, name: nameFromPath(path) };
    } else {
      next = null;
    }

    setSelection((prev) => {
      if (prev === null && next === null) return prev;
      if (prev && next && prev.kind === next.kind && prev.path === next.path) {
        return prev;
      }
      return next;
    });
  }, [location.pathname, searchParams]);

  // ---------------------------------------------------- folder ops

  const onCreateFolder = useCallback(
    async (parentPath: string, name: string) => {
      const fullPath = parentPath ? `${parentPath}/${name}` : name;
      try {
        await foldersApi.create(vaultId, fullPath);
        await treeData.refresh(parentPath);
        if (parentPath !== '' && !treeData.expanded.has(parentPath)) {
          treeData.toggle(parentPath);
        }
      } catch (e) {
        throw e instanceof ApiError ? new Error(e.message) : e;
      }
    },
    [vaultId, treeData],
  );

  const onDeleteFolder = useCallback(
    async (folderPath: string) => {
      try {
        await foldersApi.delete(vaultId, folderPath);
        const parent = parentOf(folderPath);
        await treeData.refresh(parent);
        if (selection?.kind === 'folder' && selection.path === folderPath) {
          setSelection(null);
        }
      } catch (e) {
        const message = e instanceof ApiError ? e.message : 'Delete failed.';
        // eslint-disable-next-line no-alert
        window.alert(`Could not delete folder: ${message}`);
      }
    },
    [vaultId, treeData, selection],
  );

  const onRenameFolder = useCallback(
    async (oldPath: string, newName: string) => {
      const parent = parentOf(oldPath);
      const newPath = parent ? `${parent}/${newName}` : newName;
      try {
        await foldersApi.move(vaultId, oldPath, newPath);
        await treeData.refresh(parent);

        // If selection was on the renamed folder, update it to the new
        // path so the UI keeps highlighting the right thing.
        if (selection?.kind === 'folder' && selection.path === oldPath) {
          setSelection({ kind: 'folder', path: newPath, name: newName });
        }

        // If we were viewing this folder's page, redirect to the new URL.
        if (
          location.pathname === `/vaults/${vaultId}` &&
          searchParams.get('path') === oldPath
        ) {
          navigate(`/vaults/${vaultId}?path=${encodeURIComponent(newPath)}`);
        }
      } catch (e) {
        throw e instanceof ApiError ? new Error(e.message) : e;
      }
    },
    [vaultId, treeData, selection, navigate, location.pathname, searchParams],
  );

  // ---------------------------------------------------- note ops

  const onCreateNote = useCallback(
    async (parentPath: string, fileName: string) => {
      const fullPath = parentPath ? `${parentPath}/${fileName}` : fileName;
      try {
        const created = await notesApi.create(vaultId, {
          path: fullPath,
          body: '',
        });
        await treeData.refresh(parentPath);
        if (parentPath !== '' && !treeData.expanded.has(parentPath)) {
          treeData.toggle(parentPath);
        }
        // Open the new note straight away — matches "create file in
        // VS Code" UX where the new file becomes the active editor.
        navigate(
          `/vaults/${vaultId}/note?path=${encodeURIComponent(created.path)}`,
        );
      } catch (e) {
        throw e instanceof ApiError ? new Error(e.message) : e;
      }
    },
    [vaultId, treeData, navigate],
  );

  const onDeleteNote = useCallback(
    async (notePath: string) => {
      try {
        await notesApi.delete(vaultId, notePath);
        const parent = parentOf(notePath);
        await treeData.refresh(parent);
        if (selection?.kind === 'note' && selection.path === notePath) {
          setSelection(null);
        }
        // If we were editing this note, bounce back to its parent folder.
        if (
          location.pathname === `/vaults/${vaultId}/note` &&
          searchParams.get('path') === notePath
        ) {
          if (parent) {
            navigate(`/vaults/${vaultId}?path=${encodeURIComponent(parent)}`);
          } else {
            navigate(`/vaults/${vaultId}`);
          }
        }
      } catch (e) {
        const message = e instanceof ApiError ? e.message : 'Delete failed.';
        // eslint-disable-next-line no-alert
        window.alert(`Could not delete note: ${message}`);
      }
    },
    [vaultId, treeData, selection, navigate, location.pathname, searchParams],
  );

  const onRenameNote = useCallback(
    async (oldPath: string, newName: string) => {
      // newName comes in WITHOUT .md (because the rename UI strips it
      // for display). Re-append before sending to server.
      const fileName = newName.toLowerCase().endsWith('.md')
        ? newName
        : `${newName}.md`;
      const parent = parentOf(oldPath);
      const newPath = parent ? `${parent}/${fileName}` : fileName;
      try {
        await notesApi.move(vaultId, oldPath, newPath);
        await treeData.refresh(parent);

        if (selection?.kind === 'note' && selection.path === oldPath) {
          setSelection({ kind: 'note', path: newPath, name: fileName });
        }

        // If editor is on this note, follow the rename to the new path.
        if (
          location.pathname === `/vaults/${vaultId}/note` &&
          searchParams.get('path') === oldPath
        ) {
          navigate(
            `/vaults/${vaultId}/note?path=${encodeURIComponent(newPath)}`,
            { replace: true },
          );
        }
      } catch (e) {
        throw e instanceof ApiError ? new Error(e.message) : e;
      }
    },
    [vaultId, treeData, selection, navigate, location.pathname, searchParams],
  );

  // ---------------------------------------------------- drag-and-drop move

  /**
   * Note move via drag-and-drop. Receives the FULL new path (the
   * tree computes "target folder + source basename" and passes it
   * here). Differs from onRenameNote which only takes a new name.
   *
   * On success we refresh both source and destination parents so
   * the row disappears from one and appears in the other. If we
   * were viewing the moved note in the editor, follow the new path
   * so the editor doesn't 404.
   */
  const onMoveNote = useCallback(
    async (oldPath: string, newPath: string) => {
      const oldParent = parentOf(oldPath);
      const newParent = parentOf(newPath);
      try {
        await notesApi.move(vaultId, oldPath, newPath);
        // Refresh both ends of the move. If they're the same
        // folder this is a single round-trip via dedup in
        // treeData.refresh; if different, both lists update.
        await treeData.refresh(oldParent);
        if (newParent !== oldParent) {
          await treeData.refresh(newParent);
        }

        // Auto-expand the destination so the user sees where the
        // dropped item landed. Without this, dropping into a
        // collapsed folder feels like the file vanished — the
        // move succeeded server-side but the UI didn't reveal
        // its new home. Mirrors what onCreateNote/onCreateFolder
        // do after creating an item under a collapsed parent.
        if (newParent !== '' && !treeData.expanded.has(newParent)) {
          treeData.toggle(newParent);
        }

        // Selection follows.
        if (selection?.kind === 'note' && selection.path === oldPath) {
          setSelection({
            kind: 'note',
            path: newPath,
            name: newPath.slice(newPath.lastIndexOf('/') + 1),
          });
        }

        // Editor follows.
        if (
          location.pathname === `/vaults/${vaultId}/note` &&
          searchParams.get('path') === oldPath
        ) {
          navigate(
            `/vaults/${vaultId}/note?path=${encodeURIComponent(newPath)}`,
            { replace: true },
          );
        }
      } catch (e) {
        throw e instanceof ApiError ? new Error(e.message) : e;
      }
    },
    [vaultId, treeData, selection, navigate, location.pathname, searchParams],
  );

  /**
   * Folder move via drag-and-drop. Same shape as onMoveNote; the
   * server moves the folder and re-indexes contained notes so
   * search keeps working. We refresh both endpoints of the move.
   */
  const onMoveFolder = useCallback(
    async (oldPath: string, newPath: string) => {
      const oldParent = parentOf(oldPath);
      const newParent = parentOf(newPath);
      try {
        await foldersApi.move(vaultId, oldPath, newPath);
        await treeData.refresh(oldParent);
        if (newParent !== oldParent) {
          await treeData.refresh(newParent);
        }

        // Auto-expand the destination so the user sees where the
        // dropped folder landed. Same rationale as onMoveNote.
        if (newParent !== '' && !treeData.expanded.has(newParent)) {
          treeData.toggle(newParent);
        }

        // Folder selection follows.
        if (selection?.kind === 'folder' && selection.path === oldPath) {
          setSelection({
            kind: 'folder',
            path: newPath,
            name: newPath.slice(newPath.lastIndexOf('/') + 1) || newPath,
          });
        }

        // Folder URL follows.
        if (
          location.pathname === `/vaults/${vaultId}` &&
          searchParams.get('path') === oldPath
        ) {
          navigate(`/vaults/${vaultId}?path=${encodeURIComponent(newPath)}`);
        }

        // If editor is on a note INSIDE the moved folder, the
        // server has already re-indexed; navigate to the new path
        // so the editor isn't 404-ing.
        if (location.pathname === `/vaults/${vaultId}/note`) {
          const editorPath = searchParams.get('path') ?? '';
          if (
            editorPath === oldPath ||
            editorPath.startsWith(`${oldPath}/`)
          ) {
            const tail = editorPath.slice(oldPath.length);
            const nextPath = `${newPath}${tail}`;
            navigate(
              `/vaults/${vaultId}/note?path=${encodeURIComponent(nextPath)}`,
              { replace: true },
            );
          }
        }
      } catch (e) {
        throw e instanceof ApiError ? new Error(e.message) : e;
      }
    },
    [vaultId, treeData, selection, navigate, location.pathname, searchParams],
  );

  // ---------------------------------------------------- properties

  const onShowProperties = useCallback(
    (sel: TreeSelection) => {
      setSelection(sel);
      if (!layout.propsVisible) {
        layout.setPropsVisible(true);
      }
    },
    [layout],
  );

  // ---------------------------------------------------- prompt openers

  const onNewFolderUnder = useCallback(
    (parentPath: string) => {
      if (parentPath !== '' && !treeData.expanded.has(parentPath)) {
        treeData.toggle(parentPath);
      }
      newFolder.start(parentPath);
    },
    [treeData, newFolder],
  );

  const onNewNoteUnder = useCallback(
    (parentPath: string) => {
      if (parentPath !== '' && !treeData.expanded.has(parentPath)) {
        treeData.toggle(parentPath);
      }
      newNote.start(parentPath);
    },
    [treeData, newNote],
  );

  // ---------------------------------------------------- daily note
  //
  // "Open today's daily note" — calls the server endpoint, which is
  // idempotent (creates on first call of the day, returns existing
  // otherwise) and applies the `daily-note` template if present.
  //
  // After the call:
  //   1. Reveal the new note in the tree by expanding its three
  //      ancestors. The path shape is:
  //          Daily Notes/YYYY/MM-MonthName/YYYY-MM-DD.md
  //      so we expand "Daily Notes", then "Daily Notes/YYYY", then
  //      "Daily Notes/YYYY/MM-MonthName" if any are still collapsed.
  //   2. Refresh each ancestor's PARENT first, then expand the
  //      ancestor. This is critical for the "first daily note ever"
  //      case: if Daily Notes/ doesn't yet exist in the cached root
  //      listing, calling toggle('Daily Notes') would add it to the
  //      expanded set but the TreeView wouldn't render anything for
  //      it — because the root's children list (which it was loaded
  //      from before the folder existed on disk) doesn't include
  //      'Daily Notes/'. Refreshing the parent listing first means
  //      the new folder appears in the rendered tree.
  //   3. Refresh the deepest folder one more time at the end so the
  //      freshly-created note row shows up even if the leaf folder
  //      was already cached without it.
  //   4. Navigate the editor to the note's path. The selection-from-
  //      URL effect picks it up and highlights the row.
  //
  // We don't show a toast on creation. The URL change + tree
  // highlight is signal enough; a toast would be noise on something
  // the user explicitly asked for.
  const onOpenDailyNote = useCallback(async () => {
    if (!vaultId) return;
    try {
      const res = await dailyNotesApi.openToday(vaultId);

      // Walk ancestors top-down. For each level: refresh the parent's
      // listing FIRST (so the parent contains this segment, even if
      // the segment was just created), THEN toggle to expand. The
      // toggle's own lazy-load is a no-op when refresh has already
      // populated the cache, so this isn't a double fetch.
      const segments = res.path.split('/');
      // segments[length - 1] is the .md filename → drop it
      const folderSegments = segments.slice(0, -1);
      let acc = '';
      for (const seg of folderSegments) {
        const parent = acc;     // empty string for the first iteration = vault root
        acc = acc === '' ? seg : `${acc}/${seg}`;
        await treeData.refresh(parent);
        if (!treeData.expanded.has(acc)) {
          treeData.toggle(acc);
        }
      }
      // Force-refresh the deepest folder so the new note row appears
      // even if the listing was already cached. Required when the
      // parent was previously expanded (cached without the new note).
      if (folderSegments.length > 0) {
        const deepest = folderSegments.join('/');
        await treeData.refresh(deepest);
      }

      navigate(
        `/vaults/${vaultId}/note?path=${encodeURIComponent(res.path)}`,
      );
    } catch (e) {
      const message =
        e instanceof ApiError ? e.message : 'Could not open today\u2019s note.';
      // eslint-disable-next-line no-alert
      window.alert(message);
    }
  }, [vaultId, treeData, navigate]);

  // ---------------------------------------------------- toolbar parent
  //
  // The +note / +folder buttons in the rail header pick where to
  // create the new item based on the current selection:
  //
  //   - Folder selected     → create as child of that folder
  //   - Note selected       → create as sibling (i.e. in the note's
  //                           parent folder); notes can't contain
  //                           children so "child of a note" is
  //                           meaningless
  //   - Nothing selected    → create at vault root
  //
  // The tooltip on the buttons also reflects the effective parent
  // so the user can verify before clicking.
  const toolbarParent = useMemo<string>(() => {
    if (!selection) return '';
    if (selection.kind === 'folder') return selection.path;
    // note → its parent folder
    return parentOf(selection.path);
  }, [selection]);

  const toolbarParentLabel = toolbarParent === '' ? 'vault root' : toolbarParent;

  // ---------------------------------------------------- outside-click + Esc
  //
  // Clicking inside the scrollable tree area but NOT on a row
  // clears the selection. We attach the handler to .nc-rail-scroll
  // (not the rail header — the toolbar buttons themselves must not
  // clear selection mid-click). Detection: the click target's
  // closest matching `.nc-tree-row` should be null. This also keeps
  // chevron clicks intact, since chevrons live INSIDE rows.
  //
  // Esc clears selection too, plus it cancels any pending inline
  // prompts. The pending-prompt cases are already handled by the
  // input rows themselves; we only handle the "no prompt active"
  // case here so we don't fight them.

  const handleScrollAreaMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      // Only react to plain left-click. Right-click goes to the
      // context-menu path; middle-click is ignored.
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // If the click landed on (or inside) a tree row, the row's
      // own handler decides what to do. The .nc-tree-row class is
      // shared by normal rows AND the inline rename / new-folder /
      // new-note input rows, so this single check covers all of
      // them — clicking inside a pending-prompt input must NOT
      // clear selection.
      if (target.closest('.nc-tree-row')) return;
      // Otherwise: empty area. Clear selection.
      setSelection(null);
    },
    [],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (newFolder.prompt || newNote.prompt || rename.prompt) return;
      // Don't steal Escape from inputs/textareas/the editor —
      // checking activeElement is enough for the common cases.
      const ae = document.activeElement as HTMLElement | null;
      if (ae) {
        const tag = ae.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || ae.isContentEditable) {
          return;
        }
      }
      setSelection(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newFolder.prompt, newNote.prompt, rename.prompt]);

  // ---------------------------------------------------- Ship 84
  // Listen for rename / delete events from MobileNoteProperties.
  //
  // The mobile properties panel is rendered inside NoteEditor, which
  // is two route levels below VaultLayout. Rather than prop-drill
  // callbacks through EditorPage, the panel dispatches window
  // CustomEvents and we react here. Same pattern Ship 78 set up
  // (nc:add-startpage-block) and PropertiesPanel uses for
  // nc:note-appearance-changed.
  //
  // For rename: the API call already happened in the panel; we
  // just refresh the tree, update selection, and follow URL —
  // mirrors the existing onAfterRename callback below.
  //
  // For delete: the API call has NOT happened yet; we own the
  // confirm-and-delete flow on desktop too (TreeContextMenu and
  // PropertiesPanel both ask VaultLayout to do it). The panel
  // confirmed already, so we just call onDeleteNote.
  useEffect(() => {
    function onRenamed(e: Event) {
      const detail = (e as CustomEvent<{ oldPath: string; newPath: string }>).detail;
      if (!detail) return;
      const { oldPath, newPath } = detail;
      const parent = parentOf(oldPath);
      void treeData.refresh(parent);
      const newName = newPath.slice(newPath.lastIndexOf('/') + 1) || newPath;
      // Selection follows the rename — same as onAfterRename does.
      if (selection?.kind === 'note' && selection.path === oldPath) {
        setSelection({ kind: 'note', path: newPath, name: newName });
      }
      // If editor is on this note, follow the rename.
      if (
        location.pathname === `/vaults/${vaultId}/note` &&
        searchParams.get('path') === oldPath
      ) {
        navigate(
          `/vaults/${vaultId}/note?path=${encodeURIComponent(newPath)}`,
          { replace: true },
        );
      }
    }
    function onDeleted(e: Event) {
      const detail = (e as CustomEvent<{ path: string }>).detail;
      if (!detail) return;
      // The mobile panel already showed a confirm; jump straight
      // to the action. onDeleteNote handles the API call, tree
      // refresh, selection clear, and URL bounce-to-parent.
      void onDeleteNote(detail.path);
    }
    window.addEventListener('nc:note-renamed', onRenamed);
    window.addEventListener('nc:note-deleted', onDeleted);
    return () => {
      window.removeEventListener('nc:note-renamed', onRenamed);
      window.removeEventListener('nc:note-deleted', onDeleted);
    };
  }, [
    treeData,
    selection,
    location.pathname,
    searchParams,
    navigate,
    vaultId,
    onDeleteNote,
  ]);

  // Defensive: vaultId comes from the route, so this should never
  // fire in practice. Placed AFTER all hooks so we don't violate
  // the Rules of Hooks if the param ever turns out missing.
  if (!vaultIdParam) {
    return null;
  }

  // Ship 81: shared rail-header content. Same JSX whether desktop
  // or mobile-expanded; only the wrapping container changes shape.
  // Extracted so we don't duplicate the three buttons.
  //
  // Ship 87: split the action buttons into their own variable so
  // the mobile merged toggle-row can render them without
  // duplicating the three button definitions.
  const actionButtons = (
    <span className="nc-rail-header-actions">
      {/*
        Daily-note button — always opens (or creates and
        opens) today's daily note. Idempotent server-side,
        so spamming this is harmless. Title shows the local
        date so the user can verify they're about to land
        on today's, not yesterday's. Ship 78: text "Daily+"
        to match the sibling 📄+ / 📁+ pattern (icon-or-
        word + plus glyph) — pre-Ship-78 the lone 📅 emoji
        read inconsistent with the other two buttons.
      */}
      <button
        type="button"
        className="nc-rail-header-button"
        title={`Today's daily note (${formatLocalDate(new Date())})`}
        onClick={() => void onOpenDailyNote()}
      >
        Daily+
      </button>
      <button
        type="button"
        className="nc-rail-header-button"
        title={`New note in ${toolbarParentLabel}`}
        onClick={() => onNewNoteUnder(toolbarParent)}
      >
        📄+
      </button>
      <button
        type="button"
        className="nc-rail-header-button"
        title={`New folder in ${toolbarParentLabel}`}
        onClick={() => onNewFolderUnder(toolbarParent)}
      >
        📁+
      </button>
    </span>
  );

  const railHeader = (
    <div className="nc-rail-header nc-rail-header-with-action">
      <span>Tree</span>
      {actionButtons}
    </div>
  );

  // Ship 81: shared tree content. Identical between desktop rail
  // and mobile expanded strip.
  const treeContent = (
    <div
      className="nc-rail-scroll"
      style={buildTreeStyle(treeAppearance.fontStack, treeAppearance.fontSize)}
      onMouseDown={handleScrollAreaMouseDown}
    >
      <TreeView
        vaultId={vaultId}
        variant={variant}
        data={treeData}
        selection={selection}
        onSelect={(sel) => {
          setSelection(sel);
          // Ship 87: no longer auto-collapsing the mobile tree
          // strip on row selection — the user wants the tree to
          // stay open above the editor (see initial-state default
          // and the removed /note auto-collapse effect at the top
          // of this component for the matching changes).
        }}
        onContextMenu={(sel, x, y) =>
          setContextMenu({ selection: sel, x, y })
        }
        newFolder={newFolder}
        newNote={newNote}
        rename={rename}
        onCreateFolder={onCreateFolder}
        onCreateNote={onCreateNote}
        onRenameFolder={onRenameFolder}
        onRenameNote={onRenameNote}
        onMoveNote={onMoveNote}
        onMoveFolder={onMoveFolder}
        moveModeItem={moveModeItem}
        onMoveModeExit={() => setMoveModeItem(null)}
        isStartpageActive={isOnStartpage}
        onSelectStartpage={onSelectStartpage}
      />
    </div>
  );

  return (
    <>
      <TopBar
        vault={vault ?? undefined}
        vaults={allVaults}
        onVaultUpdated={(updated) => {
          // Ship 91: splice the updated DTO back into the in-memory
          // list so the picker re-renders with the new icon/colour
          // immediately. Also update the active `vault` if that's
          // the one that changed — keeps any other consumers (e.g.
          // the tree/editor headers) consistent without a refetch.
          setAllVaults((prev) =>
            prev.map((v) => (v.id === updated.id ? updated : v)),
          );
          if (vault?.id === updated.id) {
            setVault(updated);
          }
        }}
        rightExtras={
          // Ship 81: hide the rail-toggle buttons (📁 ℹ️) on mobile.
          // The mobile layout forces tree-on-top and props-hidden;
          // toggling them would have no effect, so the buttons are
          // pointless clutter. Pass null on mobile to render an
          // empty slot instead.
          isMobile ? null : (
            <ToggleRailButtons
              slot="toggles"
              treeVisible={layout.treeVisible}
              propsVisible={layout.propsVisible}
              onToggleTree={() => layout.setTreeVisible(!layout.treeVisible)}
              onToggleProps={() => layout.setPropsVisible(!layout.propsVisible)}
              treeAppearance={treeAppearance}
            />
          )
        }
        rightSettings={
          // Ship 70: settings cog moved to the right of the account
          // menu. Same component instance, just rendering its
          // "settings" slot. Ship 80: variant + onVariantChange
          // dropped from the props since the Win7/Win11 picker is
          // gone (compact-only). Ship 81: hidden on mobile — the
          // user has finished configuring on desktop and doesn't
          // need the cog cluttering a narrow topbar. Templates is
          // hidden via CSS (the link is hardcoded inside TopBar).
          isMobile ? null : (
            <ToggleRailButtons
              slot="settings"
              treeVisible={layout.treeVisible}
              propsVisible={layout.propsVisible}
              onToggleTree={() => layout.setTreeVisible(!layout.treeVisible)}
              onToggleProps={() => layout.setPropsVisible(!layout.propsVisible)}
              treeAppearance={treeAppearance}
            />
          )
        }
      />

      {/*
        Ship 81: data-mobile attribute on the shell drives the
        mobile-only CSS rules in styles.css. Combined with
        data-tree-expanded it lets the stylesheet collapse the
        tree rail to a single-row strip when the user hasn't
        opened it. We avoid toggling React-rendered DOM (the rail
        always exists); CSS handles the height transition.
      */}
      <div
        className="nc-shell"
        data-mobile={isMobile ? 'true' : undefined}
        data-tree-expanded={isMobile && mobileTreeExpanded ? 'true' : undefined}
      >
        {effectiveTreeVisible && (
          isMobile ? (
            // Ship 81 — Mobile: render the tree as a plain block,
            // no ResizableRail (its inline width style would
            // override our full-width CSS, and the drag handle
            // is meaningless on touch). The rail-collapsed
            // mobile-strip behaviour comes entirely from CSS
            // reading the data-tree-expanded attribute on the
            // shell above.
            //
            // The strip header is the SAME .nc-rail-header that
            // desktop uses, but on mobile we make the whole strip
            // tappable to expand/collapse. We keep the action
            // buttons accessible in the expanded state.
            <div className="nc-rail nc-rail-left nc-rail-mobile">
              <div className="nc-rail-content">
                {/*
                  Ship 87: merged toggle + action-buttons row.
                  Pre-Ship-87, the chevron toggle and the
                  Daily+/📄+/📁+ row were two stacked rows (~44 +
                  30 = ~74px). On a phone that header took 10% of
                  the viewport before the first folder row even
                  appeared. Ship 87 puts both in the same flex
                  row at 44px tall.

                  The toggle stays a real <button> with the
                  chevron + label; the action buttons live in a
                  sibling span. Tapping an action button doesn't
                  bubble to the toggle (different element) so the
                  expand/collapse state stays put. The original
                  desktop {railHeader} is no longer rendered in
                  the mobile branch — its content is fully
                  represented by the merged row.
                */}
                <div className="nc-mobile-tree-row">
                  <button
                    type="button"
                    className="nc-mobile-tree-toggle"
                    onClick={() => setMobileTreeExpanded((v) => !v)}
                    aria-expanded={mobileTreeExpanded}
                    aria-label={
                      mobileTreeExpanded ? 'Collapse tree' : 'Expand tree'
                    }
                  >
                    <span className="nc-mobile-tree-toggle-chev">
                      {mobileTreeExpanded ? '▾' : '▸'}
                    </span>
                    {/*
                      Ship 89: label is "Show Tree" (not "Tree") to
                      make the button's purpose explicit on a phone
                      where there's no hover-tooltip affordance.
                      Followed by a visual `|` separator and, when
                      the tree is COLLAPSED and a note is selected,
                      the note's display name. The note name is
                      hidden when expanded — at that point the user
                      is navigating and the action buttons take the
                      right side of the row instead. CSS handles
                      the show/hide via .nc-shell[data-tree-expanded]
                      so we render the title-span unconditionally
                      and let CSS pick the visible state.
                    */}
                    <span className="nc-mobile-tree-toggle-label">
                      Show Tree
                    </span>
                    <span
                      className="nc-mobile-tree-toggle-sep"
                      aria-hidden="true"
                    >
                      |
                    </span>
                    <span className="nc-mobile-tree-toggle-title">
                      {selection && selection.kind === 'note'
                        ? // Strip .md off note names — the user knows
                          // the underlying file format, no need to
                          // shout it in the strip.
                          selection.name.toLowerCase().endsWith('.md')
                          ? selection.name.slice(0, -3)
                          : selection.name
                        : ''}
                    </span>
                  </button>
                  {actionButtons}
                </div>
                {/*
                  Tree content — always rendered; CSS hides it
                  when [data-tree-expanded] is absent. This lets
                  the browser keep the tree's scroll position and
                  React state across collapse/expand cycles.
                  Ship 87: removed the {railHeader} render from
                  this mobile branch; its content is now in the
                  merged row above.
                */}
                {treeContent}
              </div>
            </div>
          ) : (
            <ResizableRail
              side="left"
              width={layout.treeWidth}
              onWidthChange={layout.setTreeWidth}
            >
              {railHeader}
              {treeContent}
            </ResizableRail>
          )
        )}

        <main className="nc-shell-main">
          {/*
            Pages render here via the layout route's <Outlet />.
            This is the seam that lets us swap FolderPage ↔
            EditorPage without unmounting the surrounding shell
            (and therefore the tree).
          */}
          <Outlet context={{ vault }} />
        </main>

        {effectivePropsVisible && (
          <ResizableRail
            side="right"
            width={layout.propsWidth}
            onWidthChange={layout.setPropsWidth}
          >
            <PropertiesPanel
              vaultId={vaultId}
              selection={selection}
              variant={variant}
              onClose={() => layout.setPropsVisible(false)}
              /*
                Step 36: pass the move-mode flag for the *currently
                selected* item only. The Move button in the panel is
                only visible when there's a selection anyway, so we
                only care if the in-flight move is for that exact
                item. (Selection-change automatically clears
                moveModeItem via the effect above, so in practice
                isInMoveMode and "selection matches moveModeItem"
                drift apart only for one render frame at most.)
              */
              isInMoveMode={
                moveModeItem !== null
                && selection !== null
                && moveModeItem.kind === selection.kind
                && moveModeItem.path === selection.path
              }
              onStartMove={() => {
                if (!selection) return;
                // Toggle: if already in move mode for this item, the
                // button acts as Cancel. Otherwise arm it.
                setMoveModeItem((current) => {
                  if (
                    current !== null
                    && current.kind === selection.kind
                    && current.path === selection.path
                  ) {
                    return null;
                  }
                  return selection;
                });
              }}
              /*
                onAfterRename: post-rename housekeeping when the user
                renames via the properties panel's editable Name field.
                The panel itself already called notesApi.move /
                foldersApi.move; we just need to refresh the tree,
                update selection, and follow the URL — same pattern
                as onRenameNote / onRenameFolder elsewhere in this
                file.
              */
              onAfterRename={(kind, oldPath, newPath) => {
                const parent = parentOf(oldPath);
                void treeData.refresh(parent);
                const newName = newPath.slice(newPath.lastIndexOf('/') + 1) || newPath;

                if (kind === 'note') {
                  if (selection?.kind === 'note' && selection.path === oldPath) {
                    setSelection({ kind: 'note', path: newPath, name: newName });
                  }
                  // If editor is on this note, follow the rename.
                  if (
                    location.pathname === `/vaults/${vaultId}/note` &&
                    searchParams.get('path') === oldPath
                  ) {
                    navigate(
                      `/vaults/${vaultId}/note?path=${encodeURIComponent(newPath)}`,
                      { replace: true },
                    );
                  }
                } else {
                  if (selection?.kind === 'folder' && selection.path === oldPath) {
                    setSelection({ kind: 'folder', path: newPath, name: newName });
                  }
                  if (
                    location.pathname === `/vaults/${vaultId}` &&
                    searchParams.get('path') === oldPath
                  ) {
                    navigate(`/vaults/${vaultId}?path=${encodeURIComponent(newPath)}`);
                  }
                }
              }}
              /*
                onDelete: confirm + dispatch to the existing per-kind
                delete callbacks (which handle API call, tree refresh,
                URL navigation). The TreeContextMenu also confirms
                before calling those, so we keep the same wording
                pattern here for consistency.
              */
              onDelete={(kind, path) => {
                const name = path.slice(path.lastIndexOf('/') + 1) || path;
                if (kind === 'note') {
                  if (
                    window.confirm(
                      `Delete "${name}"? It will be moved to the vault's trash folder.`,
                    )
                  ) {
                    void onDeleteNote(path);
                  }
                } else {
                  if (
                    window.confirm(
                      `Delete folder "${name}"?\n\nThis only works for empty folders. Move or delete its notes first if it contains any.`,
                    )
                  ) {
                    void onDeleteFolder(path);
                  }
                }
              }}
            />
          </ResizableRail>
        )}
      </div>

      {contextMenu && (
        <TreeContextMenu
          selection={contextMenu.selection}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onDeleteNote={onDeleteNote}
          onDeleteFolder={onDeleteFolder}
          onNewFolderUnder={onNewFolderUnder}
          onNewNoteUnder={onNewNoteUnder}
          onRenameNote={(p) => rename.start('note', p)}
          onRenameFolder={(p) => rename.start('folder', p)}
          onShowProperties={onShowProperties}
        />
      )}
    </>
  );
}

/**
 * Outlet context shape. Pages can grab the vault metadata via
 * `useOutletContext<VaultLayoutContext>()` instead of refetching it
 * themselves — saves one round-trip per page mount.
 */
export interface VaultLayoutContext {
  vault: VaultDto | null;
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function nameFromPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Compact local-date label for the daily-note button tooltip.
 * Format: "2026-04-30" — unambiguous, locale-independent, and
 * matches the daily-note filename format the server uses on disk.
 * We deliberately avoid a localized weekday/month here to keep the
 * tooltip narrow; the rest of the UI handles the Danish weekday
 * display via formatDailyNoteLabel.
 */
function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear().toString().padStart(4, '0');
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
