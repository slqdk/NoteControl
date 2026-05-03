import { type DragEvent, type MouseEvent, type ReactNode } from 'react';

/**
 * One row in the tree. Common to both folder and note rows; the
 * caller chooses the icon and whether to render a chevron.
 *
 * The component itself is variant-agnostic — visual differences
 * between 'compact' and 'comfortable' come from CSS rules at the
 * <TreeView> root that cascade into these rows.
 */
export interface TreeNodeProps {
  label: string;
  /** 0 = root level. Each step adds left padding for indentation. */
  depth: number;
  /** Show a chevron (▶ / ▼) ahead of the icon. Folders only. */
  hasChevron: boolean;
  isExpanded?: boolean;
  isSelected: boolean;
  isLoading?: boolean;
  /** "📁" / "📝" or whatever the variant prefers. */
  icon: ReactNode;
  /** Click on the chevron — only fires when hasChevron is true. */
  onChevronClick?: (e: MouseEvent) => void;
  /** Click on the row body. */
  onRowClick: (e: MouseEvent) => void;
  /** Right-click on the row body. */
  onContextMenu: (e: MouseEvent) => void;
  /** Optional double-click handler. Useful for "expand and navigate". */
  onDoubleClick?: (e: MouseEvent) => void;

  // ----- Drag-and-drop (step 5; refined in step 36 for move-mode) -----
  //
  // Step 5 made every row draggable by default (any row that received
  // an onDragStart was marked draggable=true). Step 36 inverts that:
  // drag is OFF unless the caller passes dragEnabled={true}. TreeView
  // sets dragEnabled only on the row that's currently in "move mode"
  // — entered via the Properties panel's Move button. This kills the
  // accidental-drag problem and the always-on grab cursor.
  //
  // Drop targets are unaffected: the onDragOver/onDrop/etc. handlers
  // stay live on every folder row regardless of dragEnabled, so the
  // single move-mode source can be dropped anywhere valid.

  /**
   * Whether THIS row is draggable as a source. Defaults to false.
   * Drop-target handlers are always live (when supplied).
   */
  dragEnabled?: boolean;
  /**
   * Whether this row is the current drag SOURCE — so we can dim it
   * during the drag. Cosmetic; does not affect drag mechanics.
   */
  isDragSource?: boolean;
  /**
   * Drop-target highlight state. 'valid' shows green outline,
   * 'invalid' shows red. Undefined = no highlight.
   */
  dropHighlight?: 'valid' | 'invalid' | undefined;
  /**
   * Called when the row starts being dragged. Caller fills in the
   * source identity into shared state.
   */
  onDragStart?: (e: DragEvent) => void;
  /** Called on dragend (cleanup). */
  onDragEnd?: (e: DragEvent) => void;
  /**
   * Called when a drag enters this row's bounding box. Use to
   * compute and set drop-validity highlight.
   */
  onDragEnter?: (e: DragEvent) => void;
  /**
   * Called continuously while a drag is over this row. Must call
   * preventDefault() if the drop is valid here, otherwise the
   * browser refuses to fire the subsequent 'drop' event. Caller
   * decides validity.
   */
  onDragOver?: (e: DragEvent) => void;
  /** Called when the drag leaves this row. Use to clear highlight. */
  onDragLeave?: (e: DragEvent) => void;
  /** Called when something is dropped on this row. */
  onDrop?: (e: DragEvent) => void;
}

export function TreeNode({
  label,
  depth,
  hasChevron,
  isExpanded,
  isSelected,
  isLoading,
  icon,
  onChevronClick,
  onRowClick,
  onContextMenu,
  onDoubleClick,
  dragEnabled = false,
  isDragSource,
  dropHighlight,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
}: TreeNodeProps) {
  const INDENT_PX = 14;

  // Compose row classes. Drag-related classes are additive on top
  // of the base/selected/loading states. nc-tree-row-drag-enabled is
  // step 36's signal to CSS: "show grab cursor + dashed outline so
  // the user sees this row is in move mode." Without it, the row
  // stays in its normal default-cursor state.
  const rowClass = [
    'nc-tree-row',
    isSelected ? 'nc-tree-row-selected' : '',
    isLoading ? 'nc-tree-row-loading' : '',
    dragEnabled ? 'nc-tree-row-drag-enabled' : '',
    isDragSource ? 'nc-tree-row-drag-source' : '',
    dropHighlight === 'valid' ? 'nc-tree-row-drop-valid' : '',
    dropHighlight === 'invalid' ? 'nc-tree-row-drop-invalid' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={rowClass}
      style={{ paddingLeft: depth * INDENT_PX }}
      onClick={onRowClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={hasChevron ? isExpanded : undefined}
      tabIndex={isSelected ? 0 : -1}
      // draggable is now driven solely by the explicit dragEnabled
      // prop. We still wire onDragStart/End so that *if* something
      // ever becomes draggable (move mode active), the handlers fire;
      // when dragEnabled=false the browser ignores them anyway.
      draggable={dragEnabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span
        className={[
          'nc-tree-chevron',
          hasChevron ? '' : 'nc-tree-chevron-empty',
          isExpanded ? 'nc-tree-chevron-open' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={(e) => {
          if (hasChevron && onChevronClick) {
            // Stop propagation so the row's onClick doesn't ALSO
            // toggle/select. Critical when rowClickExpands=true:
            // without this, clicking the chevron would fire both
            // onChevronClick and onRowClick, double-toggling and
            // generally confusing the state.
            e.stopPropagation();
            onChevronClick(e);
          }
        }}
        aria-hidden="true"
      >
        {hasChevron ? (isExpanded ? '▾' : '▸') : ''}
      </span>
      <span className="nc-tree-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="nc-tree-label">{label}</span>
    </div>
  );
}
