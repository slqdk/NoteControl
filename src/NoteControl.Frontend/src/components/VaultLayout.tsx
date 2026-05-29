import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';

import type { DashboardDto, VaultDto } from '../api/types';
import { ApiError, dailyNotesApi, foldersApi, notesApi, vaultsApi } from '../api/client';
import { TopBar } from './TopBar';
import { TreeView, type TreeSelection } from './TreeView';
import { TreeContextMenu } from './TreeContextMenu';
import { DashboardList } from './DashboardList';
import { PropertiesPanel } from './PropertiesPanel';
import { ResizableRail } from './ResizableRail';
import { ToggleRailButtons } from './ToggleRailButtons';
import { RailHeaderAddMenu } from './RailHeaderAddMenu';
import { MobileNavBar, type MobileNavCurrent } from './MobileNavBar';
import {
  useTreeData,
  useRailLayout,
  useNewFolderPrompt,
  useNewNotePrompt,
  useRenamePrompt,
} from '../tree/treeState';
import { loadVariant, type TreeVariant } from '../tree/treeStyles';
import { useTreeAppearance, buildTreeStyle } from '../tree/treeAppearance';
import { useDashboards } from '../hooks/useDashboards';
import { useIsMobile } from '../hooks/useIsMobile';
import { useAuth } from '../auth/AuthContext';

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
 *     2. MobileNavBar — a stacked pair of horizontally-scrolling
 *        round-button rows replacing the pre-redesign collapsible
 *        tree strip:
 *          Row 1 (anchors): Assignments · Daily notes · root folders
 *          Row 2 (children): immediate subfolders + notes of the
 *                            currently-viewed folder (walks with you
 *                            as you drill in).
 *     3. Main content (folder page / editor) below.
 *     4. Properties panel hidden entirely on mobile — the editable
 *        fields show inline below the editor via MobileNoteProperties.
 *     5. On folder views, a mobile-only "Add note / Add folder" footer
 *        renders at the bottom of FolderPage's content area (see
 *        FolderPage.tsx + the new onCreateNote/onCreateFolder fields
 *        exposed on VaultLayoutContext).
 *   The user's persisted desktop preferences for treeVisible and
 *   propsVisible are LEFT ALONE while on mobile, so switching back
 *   to desktop restores their setup. Mobile uses the navbar above
 *   instead of the tree rail entirely.
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

  // Mobile redesign — the pre-redesign mobileTreeExpanded state and
  // the matching auto-collapse useEffect on /note URLs were removed
  // when the round-button MobileNavBar replaced the collapsible tree
  // strip. The navbar is always visible at the top of the mobile
  // shell; there's no expand/collapse to track anymore.

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

  // Signed-in user's id. Pulled from AuthContext so the topbar's
  // VaultPicker can split vaults into personal (owned by this user)
  // vs shared (owned by someone else but shared with the caller).
  // Null while auth is still 'loading' or 'anonymous' — the picker
  // treats null as "everything personal" for the brief mount window
  // so its layout doesn't flicker as auth resolves.
  const { state: authState } = useAuth();
  const currentUserId =
    authState.status === 'authenticated' ? authState.user.id : null;

  // Whether the caller can write to this vault. Derived from the
  // active vault's myRole (per-vault permission row, NOT the site-
  // wide UserDto.role — admins still need an explicit vault row to
  // open a vault). Drives every write affordance in the shell:
  //   - TopBar.canEdit  → hides Templates link, gates picker's
  //                       right-click-appearance popover
  //   - Daily Note +    → hidden for viewers (server gates the
  //                       openToday endpoint as editor-only)
  //   - RailHeaderAddMenu (the "+" dropdown) → hidden for viewers
  //   - TreeContextMenu → filters write items
  //   - PropertiesPanel → disables Editable* fields, hides Move /
  //                       Delete / Add Widget / Cover
  //   - MobileNavBar    → hides Daily Notes anchor
  //   - VaultLayoutContext.canEdit → forwarded to FolderPage and
  //                       EditorPage so they can gate their own
  //                       affordances (mobile FolderAddRow,
  //                       NoteEditor.forceReadOnly, etc.)
  //
  // Defaults to true mid-load (vault === null) so the brief window
  // before the metadata fetch resolves doesn't flash a viewer-mode
  // UI for users who'll turn out to be editors — most loads. The
  // worst case is the inverse (an editor briefly sees their own
  // affordances; a viewer briefly sees write affordances and then
  // they disappear). For viewers the flicker is one render cycle,
  // and clicking anything during that window would 403 anyway.
  // We default to optimistic-editor because it matches the more
  // common path.
  const canEdit = vault === null ? true : vault.myRole !== 'viewer';

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
  // Per-vault dashboards.
  //
  // Replaces the single "Startpage" pinned row from step 39. The
  // useDashboards hook owns the StartpageConfigDto for this vault
  // (initial fetch + debounced PUT on changes); we expose its data
  // and mutators downstream:
  //   - DashboardList (in the tree) reads `dashboards` and calls
  //     onSelect / onAdd / onRename / onDelete here.
  //   - DashboardPage (the canvas) reads `dashboards` via the
  //     outlet context and calls patchDashboard for block edits.
  //
  // Drives:
  //   1. The dashboard rows' active highlight (activeDashboardId).
  //   2. Suppression of the Properties panel on dashboard / legacy-
  //      startpage routes (isOnDashboardRoute).
  // -----------------------------------------------------------------
  const dashboardsHook = useDashboards(vaultId);

  // True when the user is currently on any dashboard URL (the new
  // /dashboards/:id form OR the legacy /startpage redirect target).
  // This is the "hide the props panel" gate; same role
  // isOnStartpage played pre-multi-dashboard.
  //
  // We compare against exact pathname patterns rather than
  // .includes() so a future /vaults/:id/dashboards/x/something
  // doesn't accidentally count. If we ever add nested routes here,
  // switch to startsWith with a trailing slash.
  const dashboardsPathPrefix = `/vaults/${vaultId}/dashboards/`;
  const isOnDashboardRoute =
    location.pathname === `/vaults/${vaultId}/startpage` ||
    (location.pathname.startsWith(dashboardsPathPrefix) &&
      // exactly one segment after /dashboards/
      !location.pathname.slice(dashboardsPathPrefix.length).includes('/'));

  // Which dashboard's id sits in the URL right now, if any. null on
  // the legacy /startpage placeholder (StartpagePage redirects to a
  // real id within the same render frame anyway) and on non-
  // dashboard routes.
  const activeDashboardId = location.pathname.startsWith(
    dashboardsPathPrefix,
  )
    ? location.pathname.slice(dashboardsPathPrefix.length).split('/')[0] ||
      null
    : null;

  // -----------------------------------------------------------------
  // Assignments route detection. Single boolean — the assignments
  // page has no per-row identity to track (one page per vault), so
  // there's no "active assignments id" the way there's an active
  // dashboard id.
  //
  // Same role as isOnDashboardRoute downstream:
  //   - Drives the active-highlight on the Assignments tree row
  //     (rendered into the assignmentsSlot).
  //   - Suppresses the properties panel reveal on this route
  //     (combined with the same dashboardPropsRevealed gating —
  //     see effectivePropsVisible below).
  // -----------------------------------------------------------------
  const isOnAssignmentsRoute =
    location.pathname === `/vaults/${vaultId}/assignments`;

  // Mobile redesign — current-location descriptor for MobileNavBar.
  //
  // The navbar uses this to (a) pick which row-1 button gets the
  // active ring and (b) pick the target folder for row 2 (the
  // contextual children row). Derivation is purely off the URL —
  // we don't trust component state because direct deep-links (e.g.
  // a bookmarked note) need to land with the right buttons lit.
  //
  // Computed unconditionally rather than gated on isMobile — the
  // cost is negligible (a regex test and a couple of string ops) and
  // it lets the navbar be a dumb prop consumer rather than recomputing
  // the same thing on every render. We only PASS it to <MobileNavBar>
  // inside the mobile branch below; desktop never reads it.
  const mobileNavCurrent: MobileNavCurrent = (() => {
    if (isOnAssignmentsRoute) return { kind: 'assignments' };
    if (isOnDashboardRoute) return { kind: 'dashboard' };
    if (location.pathname === `/vaults/${vaultId}/note`) {
      return { kind: 'note', path: searchParams.get('path') ?? '' };
    }
    // Folder view (root or ?path=…). The bare /vaults/:id index is
    // root; ?path=A/B is folder A/B.
    return { kind: 'folder', path: searchParams.get('path') ?? '' };
  })();

  // Auto-hide override for the props panel: NEVER persist this to
  // localStorage — we want the user's preferred propsVisible setting
  // to come back when they leave the startpage. So we compute an
  // "effective" visibility here and use it for rendering, but leave
  // layout.propsVisible alone.
  //
  // Ship 81: also hide the props panel entirely on mobile. Same
  // pattern — don't touch the persisted preference, just override
  // for the duration of the mobile viewport.
  // -----------------------------------------------------------------
  // Properties panel reveal override on dashboard routes.
  //
  // Pre-Ship: dashboards force-hid the panel because the panel had
  // nothing useful to show (only note/folder selections render).
  // Now the panel renders dashboard-specific properties (Name +
  // Delete) when on a dashboard route, but the user wants the
  // initial state to still be HIDDEN — they reveal it on demand
  // via the ℹ️ rail toggle.
  //
  // Mechanics:
  //   - dashboardPropsRevealed: ephemeral, defaults to false. Reset
  //     to false whenever the active dashboard id changes (so
  //     switching dashboards re-hides the panel — each dashboard
  //     gets a fresh reveal).
  //   - The rail toggle button continues to flip layout.propsVisible
  //     globally; we ALSO flip dashboardPropsRevealed when on a
  //     dashboard route, so a single click of the toggle does the
  //     right thing in both contexts.
  //
  // The user's persisted layout.propsVisible (their note/folder
  // preference) is left UNTOUCHED across dashboard navigation —
  // arriving at a note still uses whatever they set there.
  // -----------------------------------------------------------------
  const [dashboardPropsRevealed, setDashboardPropsRevealed] = useState(false);

  // Reset the reveal whenever the URL pivots to a different
  // dashboard. We compare directly against activeDashboardId so the
  // reset fires once per id-change; switching folder→dashboard
  // (activeDashboardId goes null→non-null) triggers it too, which
  // is the "always hide on load" behaviour the user asked for.
  useEffect(() => {
    if (activeDashboardId !== null) {
      setDashboardPropsRevealed(false);
    }
  }, [activeDashboardId]);

  // Same reset for the assignments route. Arriving at /assignments
  // (from anywhere) hides the panel; the user can reveal it via
  // the rail toggle. We don't preserve reveal state across leaves
  // and returns — same pattern dashboards use.
  useEffect(() => {
    if (isOnAssignmentsRoute) {
      setDashboardPropsRevealed(false);
    }
  }, [isOnAssignmentsRoute]);

  // Effective visibility:
  //   - On non-dashboard routes (folder, editor): same as before —
  //     user's persisted preference, hidden on mobile.
  //   - On dashboard routes: hidden by default; revealed only when
  //     the user has actively flipped it open this dashboard
  //     session.
  //   - On the assignments route: the page has no editable
  //     selection (no note/folder properties to surface), so we
  //     treat it the same as a dashboard route — hidden by default,
  //     revealable via the rail toggle through dashboardPropsRevealed.
  //     Reusing the same state keeps the toggle behaviour
  //     predictable: one click flips what the user sees regardless
  //     of which "panel-less" route they're on.
  const effectivePropsVisible = isMobile
    ? false
    : isOnDashboardRoute || isOnAssignmentsRoute
      ? dashboardPropsRevealed
      : layout.propsVisible;

  // Mobile redesign: the tree rail is no longer rendered on mobile
  // (the MobileNavBar above the main content owns navigation now).
  //
  // Desktop: the tree is now ALWAYS visible. The user-facing 📁
  // toggle that flipped layout.treeVisible has been removed, and
  // this derivation hard-forces the effective value to true so
  // that anyone with a stale "treeVisible = false" still persisted
  // in localStorage from before the toggle was removed gets
  // unstuck automatically. layout.treeVisible itself is left
  // untouched (the persistence machinery in tree/treeState.ts
  // stays in place) — only the effective value used by render
  // gates is overridden here.
  const effectiveTreeVisible = isMobile ? false : true;

  /**
   * Unified rail-toggle handler for the props panel. Routes to the
   * right state owner based on whether we're on a dashboard route:
   *
   *   - Dashboard route → flip dashboardPropsRevealed (ephemeral).
   *     Doesn't touch the persisted preference, so leaving the
   *     dashboard for a note restores the user's last note-side
   *     setting unchanged.
   *   - Anything else → flip layout.propsVisible (persisted).
   *
   * The button's apparent state (highlighted on / off) follows
   * effectivePropsVisible, which is what this handler toggles in
   * either branch — so a single click always inverts what the user
   * sees, no surprise.
   */
  const onTogglePropsPanel = useCallback(() => {
    if (isOnDashboardRoute || isOnAssignmentsRoute) {
      setDashboardPropsRevealed((v) => !v);
    } else {
      layout.setPropsVisible(!layout.propsVisible);
    }
  }, [isOnDashboardRoute, isOnAssignmentsRoute, layout]);

  /**
   * Navigate to a dashboard's URL. Same housekeeping as the legacy
   * onSelectStartpage: clear regular tree selection (so no folder /
   * note row stays highlighted in parallel) and exit move mode if
   * active. The DashboardList component calls this when the user
   * clicks a dashboard row.
   */
  const onSelectDashboard = useCallback(
    (id: string) => {
      setSelection(null);
      setMoveModeItem(null);
      navigate(`/vaults/${vaultId}/dashboards/${id}`);
    },
    [navigate, vaultId],
  );

  /**
   * Navigate to this vault's Assignments page. Same selection /
   * move-mode housekeeping as onSelectDashboard — clicking the
   * Assignments row in the tree shouldn't leave a folder or note
   * row highlighted in parallel. The Assignments tree row (built
   * below into the assignmentsSlot) calls this.
   */
  const onSelectAssignments = useCallback(() => {
    setSelection(null);
    setMoveModeItem(null);
    navigate(`/vaults/${vaultId}/assignments`);
  }, [navigate, vaultId]);

  /**
   * Add a new dashboard via useDashboards, then navigate to it so
   * the user lands on the empty canvas ready to add widgets. The
   * navigate happens AFTER the React state update so the URL
   * change has a row to highlight by the time it resolves.
   */
  const onAddDashboard = useCallback(() => {
    const newId = dashboardsHook.addDashboard();
    if (newId) {
      onSelectDashboard(newId);
    }
  }, [dashboardsHook, onSelectDashboard]);

  /**
   * Delete a dashboard. If the deleted one was the active dashboard
   * (i.e. its id is in the URL), navigate to whichever dashboard is
   * left first — otherwise the user would be looking at the
   * "this dashboard no longer exists" stub. Refuses (returns false
   * from the hook) when this would empty the list; the menu disables
   * the item in that case so this branch shouldn't fire, but we
   * still check the return value defensively.
   */
  const onDeleteDashboard = useCallback(
    (id: string) => {
      const wasActive = activeDashboardId === id;
      const fallback = (dashboardsHook.config?.dashboards ?? []).find(
        (d) => d.id !== id,
      );
      const ok = dashboardsHook.deleteDashboard(id);
      if (!ok) return;
      if (wasActive && fallback) {
        onSelectDashboard(fallback.id);
      }
    },
    [activeDashboardId, dashboardsHook, onSelectDashboard],
  );

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
    // Defence-in-depth: the buttons that invoke this (rail-header
    // Daily Note pill on desktop, MobileNavBar Daily Notes anchor)
    // are both hidden for viewers, so this guard should never
    // trigger via normal UI flow. It exists for paths that bypass
    // those buttons — e.g. a keyboard shortcut wired in a future
    // ship, a debugger-driven call, or a stale reference held by
    // a component that re-rendered between vault load and the
    // viewer-vs-editor flag flipping. Without this, a viewer who
    // somehow reached the call would see a "Request failed: 403
    // Forbidden" banner (the server gates openToday as editor-only
    // because it creates today's file on first call).
    if (!canEdit) return;
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
  }, [vaultId, treeData, navigate, canEdit]);

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
  //
  // Viewer-mode (canEdit=false): the entire actionButtons block
  // collapses to empty — both the Daily Note pill and the "+"
  // dropdown are write affordances and neither makes sense for a
  // read-only caller. We render an empty <span> rather than null
  // so the surrounding .nc-rail-header layout (which flex-justifies
  // around this element) stays predictable. The rail header itself
  // is then visually just an empty band above the tree; that's
  // intentional — the tree is still useful read-only, and removing
  // the band entirely would require restructuring the rail's CSS
  // grid more invasively than this ship warrants.
  const actionButtons = (
    <span className="nc-rail-header-actions">
      {canEdit && (
        <>
          {/*
            Daily-note pill on the LEFT. Always the most-used action in
            this row — opening (or idempotently creating) today's daily
            note. The 📅 glyph matches the Daily Notes folder icon in
            the tree below (see TreeView's isDailyNotesRoot branch),
            keeping the button and its target row visually paired.

            Modifier class --daily applies the pill styling on top of
            the shared rail-header-button base. The other actions
            (Add Note, Add Folder, Import, Add Dashboard) used to live
            next to this button as four separate icon-+plus buttons;
            they've been folded into the single "+" dropdown menu on
            the RIGHT (RailHeaderAddMenu) so the rail header reads as a
            clean pair: a labelled primary action on one end, a
            compact add-things menu on the other.

            Hidden for viewers: the openToday endpoint requires editor
            role (it creates today's file on first call).
          */}
          <button
            type="button"
            className="nc-rail-header-button nc-rail-header-button--daily"
            title={`Today's daily note (${formatLocalDate(new Date())})`}
            onClick={() => void onOpenDailyNote()}
          >
            <span className="nc-rail-header-button__icon" aria-hidden="true">📅</span>
            <span className="nc-rail-header-button__label">Daily Note +</span>
          </button>

          {/*
            The "+" dropdown — replaces the 🏠+ / 📄+ / import-chevron /
            📁+ row. Items in spec order: Add Note, Add Folder, Import,
            Add Dashboard. The dashboard add callback is gated on
            dashboardsHook.config being loaded (mirrors the old
            standalone button's disabled state); we pass null when not
            ready, and the menu disables that item with a tooltip.

            Mobile gets the same dropdown — gone is the desktop-only
            gate on dashboards + import. The menu is the same width on
            both viewports and the file picker / dashboard-canvas
            destinations don't change behaviour with viewport size, so
            the previous "desktop only" restrictions were really just
            "we ran out of room in the icon row" — which no longer
            applies.

            Hidden for viewers: every action it dispatches (new note,
            new folder, import, new dashboard) writes server-side and
            would 403.
          */}
          <RailHeaderAddMenu
            vaultId={vaultId}
            targetFolder={toolbarParent}
            targetLabel={toolbarParentLabel}
            onAddNote={() => onNewNoteUnder(toolbarParent)}
            onAddFolder={() => onNewFolderUnder(toolbarParent)}
            onImported={(target) => {
              void treeData.refresh(target);
              if (target !== '' && !treeData.expanded.has(target)) {
                treeData.toggle(target);
              }
            }}
            onAddDashboard={dashboardsHook.config ? onAddDashboard : null}
          />
        </>
      )}
    </span>
  );

  const railHeader = (
    /*
      Pre-Ship: the rail header rendered a "Tree" label on the
      left next to the action buttons. The label was redundant —
      the rail's purpose is obvious from its position and the
      buttons themselves carry their own labels. Dropped to give
      the action-buttons row more breathing room for the new
      dashboards button without forcing the rail wider.
    */
    <div className="nc-rail-header nc-rail-header-with-action">
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
        dashboardsSlot={
          dashboardsHook.config && (
            <DashboardList
              dashboards={dashboardsHook.config.dashboards}
              activeDashboardId={activeDashboardId}
              canDelete={dashboardsHook.config.dashboards.length > 1}
              onSelect={onSelectDashboard}
              onRename={dashboardsHook.renameDashboard}
              onDelete={onDeleteDashboard}
            />
          )
        }
        assignmentsSlot={
          /*
            Assignments row. One static clickable row below the
            dashboards section and above the folder rows. Always
            present (no per-vault config needed — the row exists
            regardless of whether the user has any assignments).
            The active-highlight class is the same one the dashboard
            rows use (.nc-tree-row-selected), so the colour matches
            without a bespoke style.

            We render this inline rather than as its own component
            because there's nothing to it (one row, one click, one
            highlight check) — pulling it into a presenter would
            be more files for no readability win.
          */
          <div
            className={[
              'nc-tree-row',
              // Keeps the bottom-divider visual + font-weight that
              // dashboards use. NB: this class is hidden on mobile
              // by the Ship 86 CSS rule (see styles.css). The
              // second class below counteracts that for THIS row
              // specifically, so dashboards stay hidden on mobile
              // (preserves their established workflow) but
              // Assignments stays visible — the user explicitly
              // asked for "always visible, mobile and desktop".
              'nc-tree-row-startpage',
              'nc-tree-row-assignments',
              isOnAssignmentsRoute ? 'nc-tree-row-selected' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="treeitem"
            aria-selected={isOnAssignmentsRoute}
            tabIndex={isOnAssignmentsRoute ? 0 : -1}
            onClick={onSelectAssignments}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectAssignments();
              }
            }}
            title="Assignments"
          >
            <span
              className="nc-tree-chevron nc-tree-chevron-empty"
              aria-hidden="true"
            />
            <span className="nc-tree-icon" aria-hidden="true">
              📋
            </span>
            <span className="nc-tree-label">Assignments</span>
          </div>
        }
      />
    </div>
  );

  return (
    <>
      <TopBar
        vault={vault ?? undefined}
        vaults={allVaults}
        currentUserId={currentUserId}
        canEdit={canEdit}
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
          // Ship 81: hide the rail-toggle button (ℹ️) on mobile.
          // The mobile layout forces tree-on-top and props-hidden;
          // toggling props would have no effect, so the button is
          // pointless clutter. Pass null on mobile to render an
          // empty slot instead. The 📁 folder-tree toggle that
          // used to share this slot was removed app-wide — the
          // tree is always visible on desktop now.
          isMobile ? null : (
            <ToggleRailButtons
              slot="toggles"
              propsVisible={effectivePropsVisible}
              onToggleProps={onTogglePropsPanel}
              treeAppearance={treeAppearance}
            />
          )
        }
        rightSettings={
          // Settings cog. Now renders BEFORE the account menu —
          // Ship 70 put it after, but the account menu has been
          // moved back to the right edge so it anchors the
          // topbar's rightmost slot. Same ToggleRailButtons
          // instance, just rendering its "settings" slot. Ship 80:
          // variant + onVariantChange dropped from the props since
          // the Win7/Win11 picker is gone (compact-only). Ship 81:
          // hidden on mobile — the user has finished configuring
          // on desktop and doesn't need the cog cluttering a
          // narrow topbar. Templates is hidden via CSS (the link
          // is hardcoded inside TopBar).
          isMobile ? null : (
            <ToggleRailButtons
              slot="settings"
              propsVisible={effectivePropsVisible}
              onToggleProps={onTogglePropsPanel}
              treeAppearance={treeAppearance}
            />
          )
        }
      />

      {/*
        Mobile redesign:
          - data-mobile remains on the shell so the mobile CSS rules
            (single-column flex, narrow gutters, etc.) keep applying.
          - data-tree-expanded was dropped along with the pre-redesign
            "Show Tree" collapsible strip. The dead CSS rules tied to
            that attribute will get cleaned up in a follow-up; leaving
            them in place for now keeps the diff focused on JSX.
          - <MobileNavBar /> renders ABOVE .nc-shell on mobile, taking
            the role the tree rail used to play. It's a sibling, not a
            child of .nc-shell, because the navbar is a top-level
            navigation strip (full viewport width, doesn't need
            single-column-stack styling from inside the shell).
      */}
      {isMobile && (
        <MobileNavBar
          vaultId={vaultId}
          rootListing={treeData.childrenByPath.get('') ?? null}
          cachedListings={treeData.childrenByPath}
          current={mobileNavCurrent}
          onSelectAssignments={onSelectAssignments}
          onOpenDailyNote={() => void onOpenDailyNote()}
          canEdit={canEdit}
        />
      )}

      <div
        className="nc-shell"
        data-mobile={isMobile ? 'true' : undefined}
      >
        {effectiveTreeVisible && (
          /* Desktop tree rail. Mobile no longer renders the tree —
             effectiveTreeVisible is false on mobile (see derivation
             above), so this whole block is desktop-only. */
          <ResizableRail
            side="left"
            width={layout.treeWidth}
            onWidthChange={layout.setTreeWidth}
          >
            {railHeader}
            {treeContent}
          </ResizableRail>
        )}

        <main className="nc-shell-main">
          {/*
            Dashboard load/save errors. Rendered here (above Outlet)
            rather than inside DashboardPage because the failure is
            tied to the layout-owned config — the same banner is
            relevant on the legacy /startpage redirect, and we'd
            rather not duplicate the UI in StartpagePage. On non-
            dashboard routes the user just sees the banner briefly
            until they navigate to a dashboard, which is fine: a
            failed save is worth surfacing wherever the user is.
          */}
          {(dashboardsHook.loadError || dashboardsHook.saveError) && (
            <div className="nc-form-error nc-startpage-save-error">
              {dashboardsHook.loadError ?? dashboardsHook.saveError}
            </div>
          )}
          {/*
            Pages render here via the layout route's <Outlet />.
            This is the seam that lets us swap FolderPage ↔
            EditorPage ↔ DashboardPage without unmounting the
            surrounding shell (and therefore the tree).
          */}
          <Outlet
            context={{
              vault,
              // Forwarded to pages so they can gate their own
              // write affordances. FolderPage uses it for the mobile
              // FolderAddRow visibility; EditorPage uses it for
              // NoteEditor's forceReadOnly. Default-true mid-load
              // matches the same optimistic-editor stance the rest
              // of the layout takes (see the canEdit derivation
              // near the top of this file).
              canEdit,
              dashboards: dashboardsHook.config?.dashboards ?? null,
              patchDashboard: dashboardsHook.patchDashboard,
              // Mobile redesign: FolderPage's mobile-only Add footer
              // calls these directly. Desktop folder views ignore
              // them (note/folder creation lives in the tree's rail
              // header buttons there). Kept on the context rather
              // than prop-drilled so future pages (search results,
              // a future "recent" view, etc.) can also hook into
              // creation without re-wiring.
              onCreateNote,
              onCreateFolder,
            }}
          />
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
              canEdit={canEdit}
              /*
                onClose flips visibility through the same unified
                handler the rail-toggle button uses, so the close
                ✕ behaves identically whether on a dashboard route
                (toggles ephemeral reveal) or a note/folder route
                (toggles persisted preference).
              */
              onClose={onTogglePropsPanel}
              /*
                Dashboard properties: when the URL points at a
                dashboard the panel switches into a dashboard-only
                mode (Name + Delete). The fields are passed
                unconditionally; PropertiesPanel checks
                dashboardSelection !== null to decide which mode
                to render.
              */
              dashboardSelection={
                isOnDashboardRoute && activeDashboardId
                  ? (dashboardsHook.config?.dashboards.find(
                      (d) => d.id === activeDashboardId,
                    ) ?? null)
                  : null
              }
              onDashboardRename={async (id, newName) => {
                // Duplicate-name check at the call site so
                // EditableName surfaces the rejection in its inline
                // status. The DashboardList inline rename does its
                // own dup check before calling renameDashboard, so
                // the data layer itself stays validation-light.
                const others = (
                  dashboardsHook.config?.dashboards ?? []
                ).filter((d) => d.id !== id);
                const lower = newName.trim().toLowerCase();
                if (others.some((o) => o.name.trim().toLowerCase() === lower)) {
                  throw new Error(
                    'Another dashboard already has this name.',
                  );
                }
                dashboardsHook.renameDashboard(id, newName);
              }}
              onDashboardDelete={onDeleteDashboard}
              canDeleteDashboard={
                (dashboardsHook.config?.dashboards.length ?? 0) > 1
              }
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
          canEdit={canEdit}
        />
      )}
    </>
  );
}

/**
 * Outlet context shape. Pages can grab the vault metadata and the
 * vault's dashboards via `useOutletContext<VaultLayoutContext>()`
 * instead of refetching them themselves — saves one round-trip per
 * page mount and keeps the tree-side dashboard list in sync with
 * whatever the page is doing on the canvas.
 */
export interface VaultLayoutContext {
  vault: VaultDto | null;
  /**
   * Whether the caller has at least editor role on this vault.
   * Derived from `vault.myRole !== 'viewer'`. Pages use it to gate
   * their own write affordances (FolderPage's mobile FolderAddRow,
   * EditorPage's NoteEditor.forceReadOnly, etc.) so the read-only
   * vs. write-capable behaviour stays consistent across the shell
   * and the page bodies.
   *
   * Defaults to true while `vault` is null (mid-load) — matches the
   * optimistic-editor default used elsewhere in the layout. The
   * brief window before the metadata fetch resolves doesn't flash
   * viewer-mode UI for users who'll turn out to be editors.
   */
  canEdit: boolean;
  /**
   * The vault's dashboards. null while the initial GET is in flight
   * or has failed. Always at least one entry once non-null (the
   * server seeds a default if the file is empty/legacy/missing).
   */
  dashboards: DashboardDto[] | null;
  /**
   * Apply a patch to one dashboard. The page passes the dashboard's
   * id and a function that builds the new value from the old. The
   * layout splices it back into its config and triggers a debounced
   * save. Used by DashboardPage for block-level edits.
   */
  patchDashboard: (
    id: string,
    patch: (d: DashboardDto) => DashboardDto,
  ) => void;
  /**
   * Create a new note under `parentPath` (use '' for vault root).
   * Resolves after the server has created the file, the tree cache
   * has been refreshed, and the editor has navigated to the new note.
   * Rejects with an Error whose message is the server's reason on
   * failure (duplicate name, invalid path, etc.) — callers should
   * surface that to the user.
   *
   * Used by FolderPage's mobile-only Add footer; desktop's note
   * creation goes through the "+" dropdown in the tree rail header
   * (see RailHeaderAddMenu).
   */
  onCreateNote: (parentPath: string, fileName: string) => Promise<void>;
  /**
   * Create a new folder under `parentPath`. Same resolve/reject
   * contract as onCreateNote — see that field for details.
   */
  onCreateFolder: (parentPath: string, name: string) => Promise<void>;
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
