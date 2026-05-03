import { Extension } from '@tiptap/core';

/**
 * Keyboard shortcut: when the user has drag-selected ALL the cells
 * in a table and presses Del or Backspace, delete the entire table.
 *
 * Why this is needed: TipTap's @tiptap/extension-table treats a
 * CellSelection (drag from one cell to another) as "delete the
 * SELECTED cell contents" when the user presses Del. To get rid
 * of the table itself the user would need a NodeSelection on the
 * table, which is awkward to create from the keyboard.
 *
 * Our heuristic: if every cell in the table is part of the
 * current CellSelection, the user clearly meant "delete the whole
 * thing". We intercept Del/Backspace in that case and call
 * deleteTable().
 *
 * For partial selections (some cells selected) we fall through to
 * the default behavior — clearing the selected cells' content
 * without removing the table.
 *
 * Detection: we count the number of cells in the table and the
 * number of cells in the selection. If they match, every cell is
 * selected. We avoid trying to import the prosemirror-tables
 * CellSelection class directly (TS module shape varies between
 * versions); instead we duck-type via `selection.isCellSelection`-
 * style checks on properties we know exist.
 */
export const TableDeleteShortcut = Extension.create({
  name: 'tableDeleteShortcut',

  addKeyboardShortcuts() {
    return {
      Backspace: () => deleteTableIfAllCellsSelected(this.editor),
      Delete: () => deleteTableIfAllCellsSelected(this.editor),
    };
  },
});

function deleteTableIfAllCellsSelected(editor: {
  state: { selection: unknown };
  chain: () => { focus: () => { deleteTable: () => { run: () => boolean } } };
}): boolean {
  const sel = editor.state.selection as {
    $anchorCell?: { node: (depth: number) => { childCount: number } };
    $headCell?: { node: (depth: number) => { childCount: number } };
    ranges?: ReadonlyArray<unknown>;
  };

  // Not a CellSelection — let the default Del/Backspace behavior
  // run. The two duck-type properties below ($anchorCell and
  // $headCell) are unique to CellSelection.
  if (!sel.$anchorCell || !sel.$headCell) {
    return false;
  }

  // Count cells in the containing table. A CellSelection's
  // $anchorCell.node(-1) is the row; node(-2) is the table.
  // We sum row.childCount across all rows (cell counts) to get
  // the total cell count of the table.
  let totalCells = 0;
  try {
    const table = (sel.$anchorCell as unknown as { node: (depth: number) => { childCount: number; child: (i: number) => { childCount: number } } }).node(-2);
    for (let r = 0; r < table.childCount; r++) {
      totalCells += table.child(r).childCount;
    }
  } catch {
    return false;
  }

  // Count cells in the selection. CellSelection.ranges has one
  // entry per selected cell.
  const selectedCells = sel.ranges?.length ?? 0;

  if (selectedCells > 0 && selectedCells === totalCells) {
    editor.chain().focus().deleteTable().run();
    return true;
  }

  // Not "all cells selected" — fall through to default behavior.
  return false;
}
