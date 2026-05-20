import { type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import type { NoteSummaryDto } from '../api/types';
import { TreeNode } from './TreeNode';
import { NewFolderInputRow } from './NewFolderInputRow';
import { NewNoteInputRow } from './NewNoteInputRow';
import { RenameInputRow } from './RenameInputRow';
import type {
  TreeData,
  NewFolderPromptState,
  NewNotePromptState,
  RenamePromptState,
} from '../tree/treeState';
import type { TreeVariant } from '../tree/treeStyles';
import { formatDailyNoteLabel, isDailyNotesRoot } from '../utils/dailyNoteDisplay';
import {
  computeDropDest,
  isValidDropTarget,
  useTreeDragDrop,
} from '../utils/treeDragDrop';
import { useTreeBehaviour } from '../settings/treeBehaviour';
import { requestNavigation } from '../hooks/navigationGuard';

/**
 * Selection in the tree. Drives row highlight and properties panel.
 */
export interface TreeSelection {
  kind: 'folder' | 'note';
  path: string;
  name: string;
}

export interface TreeViewProps {
  vaultId: string;
  variant: TreeVariant;
  data: TreeData;
  selection: TreeSelection | null;
  onSelect: (sel: TreeSelection) => void;
  onContextMenu: (sel: TreeSelection, x: number, y: number) => void;
  showNotes?: boolean;

  // Pending UI prompts (each at most one active across the tree).
  newFolder: NewFolderPromptState;
  newNote: NewNotePromptState;
  rename: RenamePromptState;

  // Submission handlers — wired by VaultLayout to the API.
  onCreateFolder: (parentPath: string, name: string) => Promise<void>;
  onCreateNote: (parentPath: string, fileName: string) => Promise<void>;
  onRenameFolder: (oldPath: string, newName: string) => Promise<void>;
  onRenameNote: (oldPath: string, newName: string) => Promise<void>;
  /**
   * Move (drag-and-drop) handlers — receive the FULL new path,
   * unlike rename which only takes a new name. Wired to
   * notesApi.move / foldersApi.move plus tree refresh.
   */
  onMoveNote: (oldPath: string, newPath: string) => Promise<void>;
  onMoveFolder: (oldPath: string, newPath: string) => Promise<void>;

  // ----- Step 36: opt-in move mode -----
  //
  // Drag is OFF by default; the only row that can be dragged is the
  // one in move mode. VaultLayout owns the moveModeItem state; it
  // sets it from the Properties panel's Move button and clears it
  // on selection-change/Escape/successful-drop/cancel.

  /**
   * The row that's currently in "move mode" (draggable). null when
   * move mode is not active. When non-null and matching a rendered
   * row's identity, that row gets dragEnabled and the cosmetic
   * "this is draggable" outline.
   */
  moveModeItem: TreeSelection | null;
  /**
   * Called when the move ends. Three exit paths trigger this:
   *   - successful drop on a valid target
   *   - drag aborted (drop on invalid target, drop outside, Esc-while-dragging)
   *   - drop landed but executeMove threw
   * VaultLayout sets moveModeItem to null in response. Selection-
   * change and Escape-while-not-dragging clear move mode too, but
   * those are handled directly inside VaultLayout (no need to round-
   * trip through this prop).
   */
  onMoveModeExit: () => void;

  // ----- Dashboards section at the top of the tree -----
  //
  // Multi-dashboard restructure: replaced the single synthetic
  // Startpage row that used to live here. The dashboards section
  // is fully owned by VaultLayout (which has the data via
  // useDashboards) and rendered into this slot. TreeView itself
  // doesn't know about dashboards — it just drops the slot in
  // above the folder rows so the visual position is preserved.
  //
  // The slot is rendered with role="treeitem" rows internally; we
  // don't wrap it in another container because the `nc-tree`
  // parent already serves as the role="tree" host.

  /**
   * ReactNode rendered at the very top of the tree, above the
   * vault's folder rows. VaultLayout passes the DashboardList
   * component here. Empty / null is allowed (the tree just
   * starts with folder rows).
   */
  dashboardsSlot?: ReactNode;

  /**
   * ReactNode rendered directly below the dashboards section and
   * above the vault's folder rows. VaultLayout passes the
   * Assignments tree row here (a single clickable row that
   * navigates to /vaults/:vaultId/assignments). Same slot pattern
   * as dashboardsSlot — TreeView stays ignorant of what it's
   * rendering; the layout owns the data, navigation, and active-
   * highlight logic. Empty / null is allowed.
   */
  assignmentsSlot?: ReactNode;
}

export function TreeView({
  vaultId,
  variant,
  data,
  selection,
  onSelect,
  onContextMenu,
  showNotes = true,
  newFolder,
  newNote,
  rename,
  onCreateFolder,
  onCreateNote,
  onRenameFolder,
  onRenameNote,
  onMoveNote,
  onMoveFolder,
  moveModeItem,
  onMoveModeExit,
  dashboardsSlot,
  assignmentsSlot,
}: TreeViewProps) {
  const navigate = useNavigate();
  const dnd = useTreeDragDrop();
  const treeBehaviour = useTreeBehaviour();

  /**
   * Execute the move once the user releases the mouse on a valid
   * target. Calls the right server endpoint based on source kind,
   * then surfaces errors via window.alert (matches existing
   * delete-error pattern in VaultLayout). On success the parent
   * callbacks refresh the affected folders.
   */
  async function executeMove(
    source: { kind: 'folder' | 'note'; path: string },
    targetFolder: string,
  ): Promise<void> {
    const dest = computeDropDest(source.path, targetFolder);
    try {
      if (source.kind === 'note') {
        await onMoveNote(source.path, dest);
      } else {
        await onMoveFolder(source.path, dest);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Move failed.';
      // eslint-disable-next-line no-alert
      window.alert(`Could not move: ${msg}`);
    }
  }

  /**
   * Build the set of drag handlers for one tree row. Pass the row's
   * identity (kind + path); we figure out from moveModeItem whether
   * it's a drag source, and from rowKind=='folder' whether it's a
   * drop target.
   *
   * Two-sided invariant in step 36:
   *   - DRAG SOURCE handlers (onDragStart/End + dragEnabled flag)
   *     are gated on this row being the move-mode row.
   *   - DROP TARGET handlers (onDragEnter/Over/Leave/Drop) stay live
   *     on every folder row regardless. Without this, the move-mode
   *     row would have nowhere to drop.
   */
  function rowDragHandlers(
    rowKind: 'folder' | 'note',
    rowPath: string,
  ): Partial<{
    dragEnabled: boolean;
    isDragSource: boolean;
    dropHighlight: 'valid' | 'invalid' | undefined;
    onDragStart: (e: DragEvent) => void;
    onDragEnd: (e: DragEvent) => void;
    onDragEnter: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  }> {
    // Step 36: this row is draggable iff it's the move-mode row.
    const isMoveModeRow =
      moveModeItem !== null
      && moveModeItem.kind === rowKind
      && moveModeItem.path === rowPath;

    // The "dnd source is THIS row" check — used only for cosmetic
    // dimming during an active drag. Distinct from isMoveModeRow,
    // because moveModeItem can be set BEFORE the user starts dragging
    // (button-armed state), and `dnd.source` is set DURING the drag.
    const isSource =
      dnd.source?.kind === rowKind && dnd.source.path === rowPath;

    // Drop targets are folders only. Notes don't accept drops.
    const isDropTarget = rowKind === 'folder';

    // Compute highlight: only show when this row is the currently
    // hovered drop target.
    let dropHighlight: 'valid' | 'invalid' | undefined;
    if (
      isDropTarget
      && dnd.hover?.folderPath === rowPath
      && dnd.source !== null
    ) {
      dropHighlight = dnd.hover.valid ? 'valid' : 'invalid';
    }

    return {
      // dragEnabled goes to TreeNode and ultimately to draggable={...}
      // on the row div. Only true for the single row armed for moving.
      dragEnabled: isMoveModeRow,
      isDragSource: isSource,
      dropHighlight,

      // Source handlers — fire only on the armed row. We still wire
      // them unconditionally because `draggable=false` makes the
      // browser ignore them anyway, and conditional spread would
      // make this object harder to reason about.
      onDragStart: (e) => {
        if (!isMoveModeRow) return; // belt-and-suspenders
        dnd.start({ kind: rowKind, path: rowPath });
        // dataTransfer must have SOMETHING set or Firefox refuses
        // to start the drag. Type+payload don't matter — we use
        // the React-side dnd state for everything.
        try {
          e.dataTransfer.setData('text/plain', rowPath);
          e.dataTransfer.effectAllowed = 'move';
        } catch {
          // some browsers throw if dataTransfer is locked; ignore
        }
      },
      onDragEnd: () => {
        // Always clear the in-flight drag state. Then exit move mode.
        // This covers ALL the "drag is over" cases — successful drop,
        // dropped-on-invalid, dropped-outside, Esc-during-drag — so
        // VaultLayout doesn't need to chase down each one. The
        // selection-change effect there is a separate exit path
        // (covers "user clicked another row before dragging").
        dnd.end();
        onMoveModeExit();
      },

      // Drop-target handlers stay live on every folder row regardless
      // of move mode. The dnd.source check below short-circuits when
      // there's no active drag, so these are effectively no-ops outside
      // of move mode.
      ...(isDropTarget
        ? {
            onDragEnter: (e: DragEvent) => {
              if (!dnd.source) return;
              const valid = isValidDropTarget(dnd.source, rowPath);
              dnd.setHoverFolder(rowPath, valid);
              if (valid) e.preventDefault();
            },
            onDragOver: (e: DragEvent) => {
              if (!dnd.source) return;
              const valid = isValidDropTarget(dnd.source, rowPath);
              if (valid) {
                // preventDefault is REQUIRED for the browser to
                // fire the subsequent drop event. Without it the
                // drop just becomes a no-op.
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }
            },
            onDragLeave: (e: DragEvent) => {
              // Containment check: dragleave fires every time the
              // cursor crosses ANY internal boundary, including
              // between the row and its child spans. We only want
              // to clear hover when the cursor actually exits the
              // row's bounds. relatedTarget is what the cursor
              // entered; if that's still inside currentTarget the
              // drag never actually left.
              const related = e.relatedTarget as Node | null;
              const current = e.currentTarget as Node;
              if (related && current.contains(related)) return;
              dnd.clearHoverFolder(rowPath);
            },
            onDrop: (e: DragEvent) => {
              e.preventDefault();
              e.stopPropagation();
              const src = dnd.source;
              dnd.end();
              if (!src) return;
              if (!isValidDropTarget(src, rowPath)) return;
              void executeMove(src, rowPath);
              // onDragEnd above will fire and call onMoveModeExit.
            },
          }
        : {}),
    };
  }

  /**
   * Both folder and note navigation consult the global navigation
   * guard before dispatching to react-router AND before updating
   * tree selection. The guard is a no-op when no editor is
   * mounted, or when the editor is clean. When the editor is
   * dirty it tries to save; if the save fails, the guard shows a
   * "save failed" dialog and asks the user to choose
   * stay-and-retry vs discard-and-leave.
   *
   * Selection is updated only on 'allow' so that a blocked
   * navigation doesn't leave the properties panel pointing at the
   * new row while the URL still points at the old one. The chevron-
   * toggle (rowClickExpands) still runs at the click site - that
   * doesn't navigate, so it doesn't go through the guard.
   *
   * For non-editor navigation contexts (the folder view) the
   * guard is null, requestNavigation returns 'allow' immediately,
   * and the click goes through with no perceptible latency.
   */
  async function navigateToFolder(path: string, sel: TreeSelection) {
    const verdict = await requestNavigation();
    if (verdict === 'block') return;
    onSelect(sel);
    if (path === '') {
      navigate(`/vaults/${vaultId}`);
    } else {
      navigate(`/vaults/${vaultId}?path=${encodeURIComponent(path)}`);
    }
  }

  async function navigateToNote(path: string, sel: TreeSelection) {
    const verdict = await requestNavigation();
    if (verdict === 'block') return;
    onSelect(sel);
    navigate(`/vaults/${vaultId}/note?path=${encodeURIComponent(path)}`);
  }

  function nameFromPath(path: string): string {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? path : path.slice(idx + 1);
  }

  function renderFolder(folderPath: string, depth: number): JSX.Element[] {
    const isRoot = folderPath === '';
    const expanded = isRoot ? true : data.expanded.has(folderPath);
    const listing = data.childrenByPath.get(folderPath);
    const loading = data.loadingByPath.has(folderPath);
    const error = data.errorByPath.get(folderPath);

    const rows: JSX.Element[] = [];

    if (!isRoot) {
      // If this folder is being renamed, render the rename input
      // instead of the normal row.
      if (rename.prompt && rename.prompt.kind === 'folder' && rename.prompt.path === folderPath) {
        const parent = parentOf(folderPath);
        const parentListing = data.childrenByPath.get(parent);
        const siblingNames = parentListing
          ? parentListing.subfolders.map((s) => s.name.toLowerCase())
          : [];
        rows.push(
          <RenameInputRow
            key={`rename-folder:${folderPath}`}
            depth={depth}
            initialName={nameFromPath(folderPath)}
            siblingNames={siblingNames}
            icon={folderIcon(variant, expanded, folderPath)}
            onCancel={rename.cancel}
            onSubmit={async (newName) => {
              await onRenameFolder(folderPath, newName);
              rename.cancel();
            }}
          />,
        );
      } else {
        const isSelected =
          selection?.kind === 'folder' && selection.path === folderPath;
        // Empty-folder gray-out: a folder we've loaded once and seen
        // to contain zero subfolders + zero notes gets the muted
        // visual treatment. The eager one-level pre-fetch in
        // useTreeData populates these listings shortly after the
        // parent's listing arrives, so most folders go from "we
        // don't know" → "known empty" automatically without the
        // user expanding anything.
        //
        // Folders that haven't been pre-fetched yet stay in the
        // un-greyed default state — `undefined` listing is NOT the
        // same as "empty", and rendering "we don't know" as
        // grey-out would make the whole tree look dead on first
        // paint. Once the listing lands we re-render and the row
        // greys correctly.
        //
        // We read off the `listing` already pulled at the top of
        // renderFolder rather than re-calling .get; same value, one
        // fewer Map lookup per row.
        const isKnownEmpty =
          listing !== undefined
          && listing.subfolders.length === 0
          && listing.notes.length === 0;
        rows.push(
          <TreeNode
            key={`folder:${folderPath}`}
            label={formatDailyNoteLabel(folderPath) ?? nameFromPath(folderPath)}
            depth={depth}
            hasChevron
            isExpanded={expanded}
            isSelected={isSelected}
            isLoading={loading}
            isEmpty={isKnownEmpty}
            icon={folderIcon(variant, expanded, folderPath)}
            onChevronClick={() => data.toggle(folderPath)}
            onRowClick={() => {
              const sel: TreeSelection = {
                kind: 'folder',
                path: folderPath,
                name: nameFromPath(folderPath),
              };
              void navigateToFolder(folderPath, sel);
              // Step 36: when "whole row toggles expand" is on, a
              // single row click also toggles the folder's expand
              // state. The chevron-only mode (rowClickExpands=false)
              // skips this — only the chevron toggles. Double-click
              // still toggles in either mode (handled below).
              //
              // Toggle happens AFTER select so the highlight resolves
              // first; the user sees "this row is now selected" and
              // simultaneously "this row just expanded/collapsed".
              if (treeBehaviour.rowClickExpands) {
                data.toggle(folderPath);
              }
            }}
            onContextMenu={(e: MouseEvent) => {
              const sel: TreeSelection = {
                kind: 'folder',
                path: folderPath,
                name: nameFromPath(folderPath),
              };
              onSelect(sel);
              onContextMenu(sel, e.clientX, e.clientY);
            }}
            // Double-click ALWAYS toggles expand, regardless of the
            // rowClickExpands setting. Even users who like chevron-
            // only-expand expect double-click to do something useful;
            // making it a second toggle (so dbl-click is a no-op net
            // effect) is the predictable behaviour. The first click
            // already selected/navigated; the second click toggles.
            onDoubleClick={() => data.toggle(folderPath)}
            {...rowDragHandlers('folder', folderPath)}
          />,
        );
      }
    }

    if (expanded) {
      if (error) {
        rows.push(
          <div
            key={`error:${folderPath}`}
            className="nc-tree-error"
            style={{ paddingLeft: (depth + 1) * 14 + 28 }}
          >
            {error}
          </div>,
        );
      } else if (loading && !listing) {
        rows.push(
          <div
            key={`loading:${folderPath}`}
            className="nc-tree-loading-row"
            style={{ paddingLeft: (depth + 1) * 14 + 28 }}
          >
            Loading…
          </div>,
        );
      } else if (listing) {
        // Inline new-folder input
        if (newFolder.prompt && newFolder.prompt.parentPath === folderPath) {
          rows.push(
            <NewFolderInputRow
              key={`new-folder:${folderPath}`}
              depth={depth + (isRoot ? 0 : 1)}
              existingNames={listing.subfolders.map((s) => s.name.toLowerCase())}
              onCancel={newFolder.cancel}
              onSubmit={async (name) => {
                await onCreateFolder(folderPath, name);
                newFolder.cancel();
              }}
            />,
          );
        }
        // Inline new-note input
        if (newNote.prompt && newNote.prompt.parentPath === folderPath) {
          rows.push(
            <NewNoteInputRow
              key={`new-note:${folderPath}`}
              depth={depth + (isRoot ? 0 : 1)}
              existingNoteFileNames={listing.notes.map((n) => n.name.toLowerCase())}
              onCancel={newNote.cancel}
              onSubmit={async (fileName) => {
                await onCreateNote(folderPath, fileName);
                newNote.cancel();
              }}
            />,
          );
        }
        // Subfolders. We sort here so that "Daily Notes" — when it
        // appears as a top-level folder — is pinned to the top of
        // the tree. Everything else stays alphabetical (the server
        // already returns them alphabetically; we re-sort because
        // Array.prototype.sort is stable and our extra key is
        // additive).
        const sortedSubs = [...listing.subfolders].sort((a, b) => {
          const ar = isRoot && a.name === 'Daily Notes' ? 0 : 1;
          const br = isRoot && b.name === 'Daily Notes' ? 0 : 1;
          if (ar !== br) return ar - br;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        for (const sub of sortedSubs) {
          rows.push(...renderFolder(sub.path, depth + (isRoot ? 0 : 1)));
        }
        // Notes
        if (showNotes) {
          for (const note of listing.notes) {
            rows.push(renderNote(note, depth + (isRoot ? 0 : 1), listing.notes));
          }
        }
        if (
          listing.subfolders.length === 0 &&
          (!showNotes || listing.notes.length === 0) &&
          !isRoot &&
          !(newFolder.prompt && newFolder.prompt.parentPath === folderPath) &&
          !(newNote.prompt && newNote.prompt.parentPath === folderPath)
        ) {
          rows.push(
            <div
              key={`empty:${folderPath}`}
              className="nc-tree-empty-row"
              style={{ paddingLeft: (depth + 1) * 14 + 28 }}
            >
              (empty)
            </div>,
          );
        }
      }
    }

    return rows;
  }

  function renderNote(
    note: NoteSummaryDto,
    depth: number,
    siblings: NoteSummaryDto[],
  ): JSX.Element {
    // Rename in progress for this note? Replace the row with the input.
    if (rename.prompt && rename.prompt.kind === 'note' && rename.prompt.path === note.path) {
      const siblingNames = siblings.map((n) => n.name.toLowerCase());
      return (
        <RenameInputRow
          key={`rename-note:${note.path}`}
          depth={depth}
          initialName={stripMdExtension(note.name)}
          siblingNames={siblingNames}
          icon={noteIcon(variant)}
          onCancel={rename.cancel}
          onSubmit={async (newName) => {
            await onRenameNote(note.path, newName);
            rename.cancel();
          }}
        />
      );
    }

    const isSelected =
      selection?.kind === 'note' && selection.path === note.path;
    return (
      <TreeNode
        key={`note:${note.path}`}
        label={formatDailyNoteLabel(note.path) ?? stripMdExtension(note.name)}
        depth={depth}
        hasChevron={false}
        isSelected={isSelected}
        icon={noteIcon(variant)}
        onRowClick={() => {
          const sel: TreeSelection = { kind: 'note', path: note.path, name: note.name };
          void navigateToNote(note.path, sel);
        }}
        onContextMenu={(e: MouseEvent) => {
          const sel: TreeSelection = { kind: 'note', path: note.path, name: note.name };
          onSelect(sel);
          onContextMenu(sel, e.clientX, e.clientY);
        }}
        {...rowDragHandlers('note', note.path)}
      />
    );
  }

  // Root drop zone — sentinel area at the bottom of the tree.
  // Dropping here moves the source to the vault root. We render
  // it only when a drag is active (no clutter when not dragging).
  // The classes mirror the row highlight system.
  const rootDropActive = dnd.source !== null;
  const rootValid =
    rootDropActive && dnd.source !== null
      ? isValidDropTarget(dnd.source, '')
      : false;
  const rootHover = dnd.hover?.folderPath === '';
  const rootHighlight = rootHover
    ? rootValid
      ? 'nc-tree-root-drop-valid'
      : 'nc-tree-root-drop-invalid'
    : '';

  return (
    <div className={`nc-tree nc-tree-${variant}`} role="tree">
      {/*
        Dashboards section, rendered at the very top of the tree,
        above Daily Notes and any user folders. Replaced the single
        pinned Startpage row that used to live here in step 39.
        VaultLayout owns the data (via useDashboards) and renders a
        <DashboardList /> into this slot — TreeView itself stays
        ignorant of dashboards' shape, which keeps the selection /
        drag-and-drop plumbing below unaware of the new entity type
        (dashboards aren't TreeSelections, they have their own
        selection model based on the URL).
      */}
      {dashboardsSlot}

      {/*
        Assignments row. A single clickable tree row that
        navigates to the vault's Assignments page. Lives between
        the dashboards section and the folder rows because the
        user asked for it to sit "below the dashbordlist and
        above the daily notes". Same slot pattern as
        dashboardsSlot — VaultLayout owns the data, navigation,
        and active-highlight; TreeView just inserts the node.
      */}
      {assignmentsSlot}

      {renderFolder('', 0)}
      {rootDropActive && (
        <div
          className={`nc-tree-root-drop ${rootHighlight}`}
          onDragEnter={(e) => {
            if (!dnd.source) return;
            const valid = isValidDropTarget(dnd.source, '');
            dnd.setHoverFolder('', valid);
            if (valid) e.preventDefault();
          }}
          onDragOver={(e) => {
            if (!dnd.source) return;
            const valid = isValidDropTarget(dnd.source, '');
            if (valid) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }
          }}
          onDragLeave={(e) => {
            const related = e.relatedTarget as Node | null;
            const current = e.currentTarget as Node;
            if (related && current.contains(related)) return;
            dnd.clearHoverFolder('');
          }}
          onDrop={(e) => {
            e.preventDefault();
            const src = dnd.source;
            dnd.end();
            if (!src) return;
            if (!isValidDropTarget(src, '')) return;
            void executeMove(src, '');
          }}
        >
          Drop here to move to vault root
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------- helpers

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function folderIcon(_variant: TreeVariant, expanded: boolean, folderPath: string): string {
  // Step 39: the Daily Notes root folder gets a calendar glyph to
  // mirror the topbar's daily-note button (which uses the same
  // emoji). Year/month/date children inside it keep the standard
  // folder/note icons — see isDailyNotesRoot for the rationale.
  if (isDailyNotesRoot(folderPath)) return '📅';
  return expanded ? '📂' : '📁';
}

function noteIcon(_variant: TreeVariant): string {
  return '📄';
}

function stripMdExtension(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}
