import { useEffect, useRef, useState, useCallback } from 'react';
import type { Editor } from '@tiptap/core';
import { CellSelection, TableMap } from '@tiptap/pm/tables';

/**
 * Grip overlay for tables.
 *
 * Behaviour:
 *
 *   - When the pointer hovers any <table> inside the ProseMirror DOM,
 *     small "grip" handles fade in:
 *       * one per body row, on the LEFT edge of the row
 *       * one per column, on the TOP edge above the first cell
 *       * one in the TOP-LEFT corner of the table (selects the whole table)
 *
 *   - Clicking a grip:
 *       * runs the matching TipTap command (selectRow / selectColumn /
 *         selectTable) — this also tints all cells in the selection
 *         via the existing `.selectedCell` CSS rule
 *       * raises a window event `nc:table-popup-open` with the selection
 *         scope (`row`, `column`, `table`). The TablePopup component
 *         listens for this event and renders itself.
 *
 *   - Grips fade out when the pointer leaves the table, UNLESS the
 *     popup is currently open — in that case the grip for the active
 *     selection stays visible (a small "you are here" affordance).
 *     The popup tells us via `nc:table-popup-close` when it closes.
 *
 * Positioning model:
 *
 *   The overlay is a single fixed-position div covering the viewport.
 *   Inside it we render absolutely-positioned grip elements whose
 *   coordinates come from `getBoundingClientRect()` on the active
 *   table and each of its <tr>/<td>/<th> children. We recompute the
 *   coordinates on:
 *     - pointermove inside the editor (cheap — only when over a table)
 *     - editor.on('transaction') (table mutations may add/remove rows)
 *     - window scroll (capture-phase) and resize
 *
 *   The cost of `getBoundingClientRect` is fine for the row/column
 *   counts a markdown note holds (rarely more than 30 cells), and the
 *   hover-only model means we don't pay anything when the user isn't
 *   pointing at a table.
 *
 * Why a single component (not one per table):
 *
 *   ProseMirror reconstructs the DOM on every transaction; binding
 *   React state to individual <table> nodes via portals is fragile.
 *   Listening once on the editor root, tracking "currently hovered
 *   table" as a single piece of state, and re-deriving grip positions
 *   from that table's live rect on every recompute is simpler and
 *   survives DOM rebuilds for free.
 */
export interface TableGripOverlayProps {
  editor: Editor | null;
}

type SelectionScope = 'row' | 'column' | 'table';

interface ActiveSelection {
  scope: SelectionScope;
  // For row/column: the 0-based index of the selected row/column. For
  // table: undefined. The popup uses this for its title; the grip
  // overlay uses it to highlight which grip is "the active one".
  index?: number;
}

interface GripGeometry {
  tableRect: DOMRect;
  rowRects: DOMRect[];   // one per <tr>
  colXs: number[];       // x-position of each column's left edge (viewport)
  colWidths: number[];   // width of each column
  topY: number;          // top edge of the table (viewport)
  leftX: number;         // left edge of the table (viewport)
}

// Grip dimensions in pixels. Kept small — the grip is decorative
// chrome, not the main editing surface. The hit-target is enlarged
// via padding on the button so clicking is still easy.
const GRIP_SIZE = 8;

// How far OUTSIDE the table edge the grips render. Negative means
// "outside the table". A few pixels of gap reads better than touching
// the border.
const GRIP_OFFSET = 4;

export function TableGripOverlay({ editor }: TableGripOverlayProps) {
  // The <table> element the pointer is currently over. Null when the
  // pointer isn't over any table. State (not ref) because the render
  // depends on it — we mount grips only when this is non-null.
  const [hoveredTable, setHoveredTable] = useState<HTMLTableElement | null>(null);

  // Geometry derived from hoveredTable. Recomputed on every event that
  // could move the table. Stored in state so React re-renders the
  // positioned grips when it changes.
  const [geometry, setGeometry] = useState<GripGeometry | null>(null);

  // Active selection (driven by clicks on grips). Persists past the
  // hover-out — that's the whole point: clicking a grip "pins" the
  // selection so the popup has something to act on.
  const [active, setActive] = useState<ActiveSelection | null>(null);

  // We keep a ref of the active state too, so handlers reading it
  // inside event listeners (which capture stale closures otherwise)
  // see the latest value.
  const activeRef = useRef<ActiveSelection | null>(null);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Recompute the geometry for the currently hovered table. Bails out
  // if the table is gone (DOM rebuild between mouseover and recompute).
  const recomputeGeometry = useCallback((tbl: HTMLTableElement | null) => {
    if (!tbl || !tbl.isConnected) {
      setGeometry(null);
      return;
    }
    const tableRect = tbl.getBoundingClientRect();
    const rows = Array.from(tbl.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tr'));
    const rowRects = rows.map((tr) => (tr as HTMLElement).getBoundingClientRect());

    // Column geometry: take the first row's cells as the column model.
    // Cells with colspan > 1 split into multiple column slots; we
    // approximate by taking each cell's left/width as its primary
    // column. For merged cells this gives a slightly wider grip — a
    // tolerable trade-off for the rare merged-header case.
    const firstRow = rows[0] as HTMLElement | undefined;
    const cellEls = firstRow
      ? Array.from(firstRow.querySelectorAll(':scope > td, :scope > th'))
      : [];
    const colXs: number[] = [];
    const colWidths: number[] = [];
    for (const cell of cellEls) {
      const r = (cell as HTMLElement).getBoundingClientRect();
      colXs.push(r.left);
      colWidths.push(r.width);
    }

    setGeometry({
      tableRect,
      rowRects,
      colXs,
      colWidths,
      topY: tableRect.top,
      leftX: tableRect.left,
    });
  }, []);

  // Wire pointer detection. We listen on `document` (not just the
  // editor root) because grips render OUTSIDE the editor DOM (as
  // fixed-position siblings), and using editor-only listeners would
  // drop the hover state the moment the pointer moved toward a grip
  // — the grips would disappear before the user could click them.
  // The document-level check finds whichever of {table cell, grip,
  // popup} the pointer is over and treats those three as "still
  // engaged with the table".
  useEffect(() => {
    if (!editor) return;
    const editorRoot = editor.view.dom; // .ProseMirror

    function onMove(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // First priority: pointer is on a table cell INSIDE the editor.
      const tbl = target.closest('table') as HTMLTableElement | null;
      if (tbl && editorRoot.contains(tbl)) {
        if (tbl !== hoveredTable) {
          // Table identity changed (just entered, or switched between
          // two tables). Recompute geometry to position grips.
          setHoveredTable(tbl);
          recomputeGeometry(tbl);
        }
        // Same table as before — geometry is already cached. The
        // separate transaction/scroll/resize listeners handle any
        // case where the cached geometry could go stale. Skipping
        // the recompute here keeps mousemove handling free for the
        // common "just typing in a cell" case.
        return;
      }

      // Second priority: pointer is on a grip or the popup. Keep
      // whatever we had — these elements are part of the "table
      // editing surface" from the user's perspective.
      if (target.closest('.nc-table-grip') || target.closest('.nc-table-popup')) {
        return;
      }

      // Otherwise: pointer is elsewhere. Drop hover unless the popup
      // is currently pinning the state.
      if (!activeRef.current && hoveredTable) {
        setHoveredTable(null);
        setGeometry(null);
      }
    }

    document.addEventListener('mousemove', onMove);
    return () => {
      document.removeEventListener('mousemove', onMove);
    };
  }, [editor, hoveredTable, recomputeGeometry]);

  // Recompute geometry on transactions (e.g. add/remove row), scroll,
  // resize. Cheap — only runs when there's an active table.
  useEffect(() => {
    if (!editor) return;
    if (!hoveredTable) return;

    function refresh() {
      recomputeGeometry(hoveredTable);
    }

    editor.on('transaction', refresh);
    window.addEventListener('scroll', refresh, true);
    window.addEventListener('resize', refresh);

    return () => {
      editor.off('transaction', refresh);
      window.removeEventListener('scroll', refresh, true);
      window.removeEventListener('resize', refresh);
    };
  }, [editor, hoveredTable, recomputeGeometry]);

  // Listen for popup close events so we can drop the "pinned" state.
  // The popup raises this when the user clicks outside / presses Esc /
  // selects an action that should dismiss.
  useEffect(() => {
    function onClose() {
      setActive(null);
      // Re-evaluate whether to keep the grips up: if the pointer is
      // still over the table we kept the geometry for, leave it. The
      // next mousemove will refresh. Easier: drop everything; next
      // pointermove rebuilds it within ~16ms.
      setHoveredTable(null);
      setGeometry(null);
    }
    window.addEventListener('nc:table-popup-close', onClose);
    return () => window.removeEventListener('nc:table-popup-close', onClose);
  }, []);

  // Re-acquire the table after the editor finishes a transaction that
  // replaces the table's DOM node. The DOM identity changes but the
  // cursor / selection lives on. If we still have an "active" pin but
  // the old hoveredTable element was removed, look it up again from
  // the selection.
  useEffect(() => {
    if (!editor) return;
    if (!active) return;

    function syncFromSelection() {
      if (!editor) return;
      const view = editor.view;
      const { from } = editor.state.selection;
      let domNode: Node | null;
      try {
        domNode = view.domAtPos(from).node;
      } catch {
        return;
      }
      let el: HTMLElement | null = domNode instanceof HTMLElement
        ? domNode
        : (domNode?.parentElement ?? null);
      while (el && el.tagName !== 'TABLE') el = el.parentElement;
      if (el && el !== hoveredTable) {
        setHoveredTable(el as HTMLTableElement);
        recomputeGeometry(el as HTMLTableElement);
      } else if (el) {
        recomputeGeometry(el as HTMLTableElement);
      }
    }

    editor.on('transaction', syncFromSelection);
    return () => {
      editor.off('transaction', syncFromSelection);
    };
  }, [editor, active, hoveredTable, recomputeGeometry]);

  // Helpers to fire selection commands. Each builds a CellSelection
  // directly via prosemirror-tables — the upstream @tiptap/extension-
  // table doesn't expose selectRow/selectColumn/selectTable as
  // editor commands (only the structural ones like addRowBefore,
  // deleteColumn, etc), so we work at the ProseMirror layer.
  //
  // The flow for all three is:
  //   1. find a DOM cell inside the target row/column/table
  //   2. translate that DOM cell to a ProseMirror position
  //   3. build the appropriate CellSelection
  //   4. dispatch a transaction that sets the selection
  // After dispatch, prosemirror-tables paints `.selectedCell` on every
  // cell in the selection (the CSS rule at styles.css already handles
  // the visual highlight), and the rest of the popup machinery acts
  // on whatever editor.state.selection is.
  function selectRow(index: number) {
    if (!editor || !hoveredTable) return;
    const rows = Array.from(hoveredTable.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tr'));
    const targetRow = rows[index] as HTMLElement | undefined;
    const firstCell = targetRow?.querySelector(':scope > td, :scope > th') as HTMLElement | undefined;
    if (!firstCell) return;

    const cellPos = posOfCell(editor, firstCell);
    if (cellPos == null) return;

    const view = editor.view;
    const $cell = view.state.doc.resolve(cellPos);
    const rowSel = CellSelection.rowSelection($cell);
    view.dispatch(view.state.tr.setSelection(rowSel));
    view.focus();

    setActive({ scope: 'row', index });
    fireOpen('row', index);
  }

  function selectColumn(index: number) {
    if (!editor || !hoveredTable) return;
    const firstRow = hoveredTable.querySelector(':scope > tbody > tr, :scope > thead > tr, :scope > tr') as HTMLElement | null;
    const targetCell = firstRow?.querySelectorAll(':scope > td, :scope > th')[index] as HTMLElement | undefined;
    if (!targetCell) return;

    const cellPos = posOfCell(editor, targetCell);
    if (cellPos == null) return;

    const view = editor.view;
    const $cell = view.state.doc.resolve(cellPos);
    const colSel = CellSelection.colSelection($cell);
    view.dispatch(view.state.tr.setSelection(colSel));
    view.focus();

    setActive({ scope: 'column', index });
    fireOpen('column', index);
  }

  function selectTable() {
    if (!editor || !hoveredTable) return;

    // Find first and last cell DOM nodes so we can span the whole
    // table. The TableMap-based approach below is more robust if the
    // table has merged cells; we fall back to first/last cell traversal
    // for the simple path.
    const firstCellDom = hoveredTable.querySelector('td, th') as HTMLElement | null;
    if (!firstCellDom) return;

    const firstCellPos = posOfCell(editor, firstCellDom);
    if (firstCellPos == null) return;

    const view = editor.view;
    const $first = view.state.doc.resolve(firstCellPos);

    // Walk up from the resolved cell pos to find the table node and
    // use TableMap to enumerate all cells. Selecting from the first
    // cell to the last cell gives us the whole table.
    let tableDepth = -1;
    for (let d = $first.depth; d >= 0; d--) {
      if ($first.node(d).type.name === 'table') {
        tableDepth = d;
        break;
      }
    }
    if (tableDepth < 0) return;

    const tableNode = $first.node(tableDepth);
    const tableStart = $first.start(tableDepth);
    const map = TableMap.get(tableNode);
    if (map.map.length === 0) return;

    // First cell at map index 0; last cell at map index length-1.
    // The map stores absolute positions within the table node, so
    // we add tableStart to map them to document positions.
    const firstPos = tableStart + map.map[0];
    const lastPos = tableStart + map.map[map.map.length - 1];

    const $a = view.state.doc.resolve(firstPos);
    const $b = view.state.doc.resolve(lastPos);
    const tableSel = new CellSelection($a, $b);
    view.dispatch(view.state.tr.setSelection(tableSel));
    view.focus();

    setActive({ scope: 'table' });
    fireOpen('table');
  }

  if (!editor) return null;
  if (!hoveredTable || !geometry) return null;

  // Row grips: one per row, on the left edge.
  const rowGrips = geometry.rowRects.map((r, i) => {
    const isActive = active?.scope === 'row' && active.index === i;
    const top = r.top + (r.height - GRIP_SIZE) / 2;
    const left = geometry.leftX - GRIP_SIZE - GRIP_OFFSET;
    return (
      <button
        key={`row-${i}`}
        type="button"
        className={isActive ? 'nc-table-grip nc-table-grip-row nc-table-grip-active' : 'nc-table-grip nc-table-grip-row'}
        style={{ position: 'fixed', top, left }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => selectRow(i)}
        title={`Select row ${i + 1}`}
        aria-label={`Select row ${i + 1}`}
      />
    );
  });

  // Column grips: one per column, on the top edge.
  const colGrips = geometry.colXs.map((x, i) => {
    const isActive = active?.scope === 'column' && active.index === i;
    const top = geometry.topY - GRIP_SIZE - GRIP_OFFSET;
    const left = x + (geometry.colWidths[i] - GRIP_SIZE) / 2;
    return (
      <button
        key={`col-${i}`}
        type="button"
        className={isActive ? 'nc-table-grip nc-table-grip-col nc-table-grip-active' : 'nc-table-grip nc-table-grip-col'}
        style={{ position: 'fixed', top, left }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => selectColumn(i)}
        title={`Select column ${i + 1}`}
        aria-label={`Select column ${i + 1}`}
      />
    );
  });

  // Corner grip: top-left of the table, selects the whole table.
  const cornerActive = active?.scope === 'table';
  const cornerTop = geometry.topY - GRIP_SIZE - GRIP_OFFSET;
  const cornerLeft = geometry.leftX - GRIP_SIZE - GRIP_OFFSET;

  return (
    <>
      <button
        key="corner"
        type="button"
        className={cornerActive ? 'nc-table-grip nc-table-grip-corner nc-table-grip-active' : 'nc-table-grip nc-table-grip-corner'}
        style={{ position: 'fixed', top: cornerTop, left: cornerLeft }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => selectTable()}
        title="Select table"
        aria-label="Select table"
      />
      {rowGrips}
      {colGrips}
    </>
  );
}

// ----- prosemirror position helpers --------------------------------

/**
 * Translate a DOM <td> / <th> element into the ProseMirror document
 * position OF the cell node. We compute this by mapping the cell's
 * DOM position to a pm pos via view.posAtDOM, then walking up the
 * resolved position until we hit a node with type 'tableCell' or
 * 'tableHeader' — that node's `before()` position is the position
 * of the cell node itself, which is what CellSelection wants for
 * its anchors.
 *
 * Returns null on failure (DOM detached, posAtDOM threw, no cell
 * ancestor found).
 */
function posOfCell(editor: Editor, cellEl: HTMLElement): number | null {
  try {
    const view = editor.view;
    // posAtDOM with offset 0 gives a position inside the cell. We
    // then resolve and walk up to the cell node itself.
    const inside = view.posAtDOM(cellEl, 0);
    const $p = view.state.doc.resolve(inside);
    for (let d = $p.depth; d >= 0; d--) {
      const n = $p.node(d);
      if (n.type.name === 'tableCell' || n.type.name === 'tableHeader') {
        return $p.before(d);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Raise the "popup should open with this scope" event. TablePopup
 * listens for this and renders itself. We use a window event rather
 * than a shared context because the popup and the grip overlay are
 * mounted independently inside the editor shell; an event keeps them
 * decoupled.
 */
function fireOpen(scope: SelectionScope, index?: number) {
  window.dispatchEvent(
    new CustomEvent('nc:table-popup-open', {
      detail: { scope, index },
    }),
  );
}
