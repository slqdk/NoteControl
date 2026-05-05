import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import type { TreeSelection } from './TreeView';

export interface TreeContextMenuProps {
  selection: TreeSelection;
  x: number;
  y: number;
  onClose: () => void;
  onDeleteNote: (notePath: string) => void;
  onDeleteFolder: (folderPath: string) => void;
  onNewFolderUnder: (parentPath: string) => void;
  onNewNoteUnder: (parentPath: string) => void;
  onRenameNote: (notePath: string) => void;
  onRenameFolder: (folderPath: string) => void;
  onShowProperties: (sel: TreeSelection) => void;
}

/**
 * Context-menu items for one tree selection. As of step 7b-1 every
 * action is wired to a real endpoint — no more "coming soon" rows.
 */
export function TreeContextMenu({
  selection,
  x,
  y,
  onClose,
  onDeleteNote,
  onDeleteFolder,
  onNewFolderUnder,
  onNewNoteUnder,
  onRenameNote,
  onRenameFolder,
  onShowProperties,
}: TreeContextMenuProps) {
  const items: ContextMenuItem[] =
    selection.kind === 'note'
      ? [
          {
            label: 'Open',
            onClick: () => {
              /* row-click already navigated */
            },
          },
          { label: null },
          {
            label: 'Rename…',
            onClick: () => onRenameNote(selection.path),
            accelerator: 'F2',
          },
          {
            label: 'Delete',
            onClick: () => {
              if (
                window.confirm(
                  `Delete "${selection.name}"? It will be moved to the vault's trash folder.`,
                )
              ) {
                onDeleteNote(selection.path);
              }
            },
            accelerator: 'Del',
          },
          { label: null },
          {
            label: 'Properties',
            onClick: () => onShowProperties(selection),
            accelerator: 'Alt+Enter',
            // Ship 85: on mobile, the desktop right-rail Properties
            // panel is force-hidden (Ship 81). Tapping this item
            // would do nothing visible. Note properties on mobile
            // live at the bottom of the editor (Ship 84's
            // MobileNoteProperties); the user already has access
            // there. Hide this entry on phones to avoid a dead
            // menu choice.
            mobileHidden: true,
          },
        ]
      : [
          {
            label: 'Open',
            onClick: () => {
              /* row-click already navigated */
            },
          },
          { label: null },
          {
            label: 'New note here',
            onClick: () => onNewNoteUnder(selection.path),
          },
          {
            label: 'New folder',
            onClick: () => onNewFolderUnder(selection.path),
          },
          { label: null },
          {
            label: 'Rename…',
            onClick: () => onRenameFolder(selection.path),
            accelerator: 'F2',
          },
          {
            label: 'Delete folder',
            onClick: () => {
              if (
                window.confirm(
                  `Delete folder "${selection.name}"?\n\nThis only works for empty folders. Move or delete its notes first if it contains any.`,
                )
              ) {
                onDeleteFolder(selection.path);
              }
            },
            accelerator: 'Del',
          },
          { label: null },
          {
            label: 'Properties',
            onClick: () => onShowProperties(selection),
            accelerator: 'Alt+Enter',
            // Ship 85: hidden on mobile. Folder properties have no
            // mobile UI yet (Ship 84 was notes-only); the right-
            // rail panel that this would open is force-hidden on
            // phones (Ship 81). Tapping it would do nothing.
            mobileHidden: true,
          },
        ];

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
