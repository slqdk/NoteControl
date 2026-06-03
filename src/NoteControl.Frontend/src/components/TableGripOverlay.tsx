import { useEffect, useRef, useState, useCallback } from 'react';
import type { Editor } from '@tiptap/core';

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
 *       * positions the editor's cursor inside the first cell of the
 *         target row/column/table — this is what subsequent commands
 *         (addRowBefore, deleteColumn, updateAttributes('table', ...))
 *         act on
 *       * raises a window event `nc:table-popup-open` with the selection
 *         scope (`row`, `column`, `table`). The TablePopup component
 *         listens for this event and renders itself.
 *
 *   - Grips fade out when the pointer leaves the table, UNLESS the
 *     popup is currently open — in that case the grip for the active
 *     selection stays visible (a small "you are here" affordance).
 *     The popup tells us via `nc:table-popup-close` when it closes.
 *
 * Why cursor-positioning (not a true CellSelection):
 *
 *   prosemirror-tables exposes CellSelection for "all cells in this
 *   row are visually selected with a blue tint", but reaching that
 *   API safely across TipTap minor versions adds an import path we
 *   don't otherwise need (@tiptap/pm/tables may not be exported in
 *   every release; it failed to load in earlier testing). The
 *   structural commands the popup runs — addRowBefore, deleteColumn,
 *   updateAttributes('table', ...), toggleHeaderRow, etc — all work
 *   correctly when the cursor is in ANY cell of the affected row/
 *   column. The trade-off is purely visual: the user sees only the
 *   focused cell highlighted, not all cells in the scope. The
 *   popup's own "Row 2 / Column 3 / Table" header makes the scope
 *   obvious anyway.
 *
 * Positioning model:
 *
 *   Hoveredtable is the live DOM element. Grip coordinates come from
 *   getBoundingClientRect on each <tr>/<td>/<th>. Recomputed on:
 *     - hover entry / table switch (mousemove)
 *     - editor.on('transaction') (table mutations may add/remove rows)
 *     - window scroll (capture-phase) and resize
 */
export interface TableGripOverlayProps {
  editor: Editor | null;
  /**
   * When true, the editor is in read-only mode (released note, viewer
   * role, archive viewer). The grips suppress themselves entirely —
   * no hover detection, no render — because every action the grip
   * would expose is a structural edit (add/delete row, add/delete
   * column, change row height, merge cells, etc.) and those make no
   * sense against a locked note.
   *
   * Defaults to false so existing call sites that don't know about
   * lock state (TemplateEditor — templates are never locked) keep
   * working without churn.
   */
  locked?: boolean;
}

type SelectionScope = 'row' | 'column' | 'table';

interface ActiveSelection {
  scope: SelectionScope;
  // For row/column: the 0-based index. For 'table': undefined.
  // Used as a label by the popup and for highlighting the active grip.
  index?: number;
}

interface GripGeometry {
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

// How far OUTSIDE the table edge the grips render. A small gap reads
// better than touching the border.
const GRIP_OFFSET = 4;

export function TableGripOverlay({ editor, locked = false }: TableGripOverlayProps) {
  const [hoveredTable, setHoveredTable] = useState<HTMLTableElement | null>(null);
  const [geometry, setGeometry] = useState<GripGeometry | null>(null);
  const [active, setActive] = useState<ActiveSelection | null>(null);

  // Mirror active in a ref so document-level event handlers can read
  // the latest value without re-binding when active changes.
  const activeRef = useRef<ActiveSelection | null>(null);
  useEffect(() => { activeRef.current = active; }, [active]);

  // When the editor transitions to locked (release lock or viewer
  // role takeover), drop any in-flight hover / active state so the
  // grips disappear immediately. The render early-return below also
  // covers the steady-state case; this effect handles the live
  // transition where state was set up moments before lock flipped.
  useEffect(() => {
    if (locked) {
      setHoveredTable(null);
      setGeometry(null);
      setActive(null);
    }
  }, [locked]);

  // Compute grip positions for a given table. Returns null on bad
  // input (table detached, etc).
  const recomputeGeometry = useCallback((tbl: HTMLTableElement | null) => {
    if (!tbl || !tbl.isConnected) {
      setGeometry(null);
      return;
    }
    const tableRect = tbl.getBoundingClientRect();
    const rows = Array.from(
      tbl.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tr'),
    );
    const rowRects = rows.map((tr) => (tr as HTMLElement).getBoundingClientRect());

    // Column geometry from the first row's cells. Merged cells in
    // row 0 will produce a slightly off-centre column grip — rare in
    // practice; tolerable cost.
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
      rowRects,
      colXs,
      colWidths,
      topY: tableRect.top,
      leftX: tableRect.left,
    });
  }, []);

  // Pointer detection at the document level. Document (not editor
  // root) so that hovering a grip — which renders OUTSIDE the editor
  // DOM as a fixed-position sibling — doesn't trigger a hover-out
  // that drops the grips before the user can click. The closest()
  // checks identify which "engaged" surface the pointer is on:
  // table cell, grip, or popup.
  useEffect(() => {
    if (!editor) return;
    // Locked editor: don't bind the hover detector at all. The hover-
    // drop effect above already cleared any existing state; this just
    // saves the per-mousemove work. The effect re-runs when `locked`
    // flips, so we re-bind once on unlock.
    if (locked) return;
    const editorRoot = editor.view.dom; // .ProseMirror

    function onMove(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // 1. Over a table cell inside the editor.
      const tbl = target.closest('table') as HTMLTableElement | null;
      if (tbl && editorRoot.contains(tbl)) {
        if (tbl !== hoveredTable) {
          // Table identity changed (just entered, or switched tables).
          // Recompute geometry once.
          setHoveredTable(tbl);
          recomputeGeometry(tbl);
        }
        // Same table as before — geometry is cached and refreshed by
        // the transaction/scroll/resize listeners. No work here.
        return;
      }

      // 2. Over a grip or the popup itself. Keep the state.
      if (target.closest('.nc-table-grip') || target.closest('.nc-table-popup')) {
        return;
      }

      // 3. Anywhere else. Drop hover unless pinned by an open popup.
      if (!activeRef.current && hoveredTable) {
        setHoveredTable(null);
        setGeometry(null);
      }
    }

    document.addEventListener('mousemove', onMove);
    return () => {
      document.removeEventListener('mousemove', onMove);
    };
  }, [editor, hoveredTable, recomputeGeometry, locked]);

  // Geometry refresh on editor / window changes while a table is
  // active. Cheap — only bound when hoveredTable exists.
  useEffect(() => {
    if (!editor || !hoveredTable) return;

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

  // Popup-close listener — drop the "pinned" state when the popup
  // closes (Esc, click-outside, action that dismisses).
  useEffect(() => {
    function onClose() {
      setActive(null);
      setHoveredTable(null);
      setGeometry(null);
    }
    window.addEventListener('nc:table-popup-close', onClose);
    return () => window.removeEventListener('nc:table-popup-close', onClose);
  }, []);

  // ---- click handlers --------------------------------------------

  // Position the editor's cursor inside the first cell of the row at
  // `index`, then signal the popup to open in row scope.
  function selectRow(index: number) {
    if (!editor || !hoveredTable) return;
    const rows = Array.from(
      hoveredTable.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tr'),
    );
    const targetRow = rows[index] as HTMLElement | undefined;
    const firstCell = targetRow?.querySelector(':scope > td, :scope > th') as HTMLElement | undefined;
    moveCursorInto(editor, firstCell);
    setActive({ scope: 'row', index });
    fireOpen('row', index);
  }

  function selectColumn(index: number) {
    if (!editor || !hoveredTable) return;
    const firstRow = hoveredTable.querySelector(
      ':scope > tbody > tr, :scope > thead > tr, :scope > tr',
    ) as HTMLElement | null;
    const targetCell = firstRow?.querySelectorAll(':scope > td, :scope > th')[index] as HTMLElement | undefined;
    moveCursorInto(editor, targetCell);
    setActive({ scope: 'column', index });
    fireOpen('column', index);
  }

  function selectTable() {
    if (!editor || !hoveredTable) return;
    const firstCell = hoveredTable.querySelector('td, th') as HTMLElement | null;
    moveCursorInto(editor, firstCell ?? undefined);
    setActive({ scope: 'table' });
    fireOpen('table');
  }

  // ---- render -----------------------------------------------------

  if (!editor) return null;
  // Locked editor: render nothing. The effects above also keep state
  // clear and skip the mousemove listener — this is the steady-state
  // guard.
  if (locked) return null;
  if (!hoveredTable || !geometry) return null;

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

// ----- helpers -----------------------------------------------------

/**
 * Position the editor's cursor inside the given cell DOM element. No-
 * op if the element isn't found or the mapping throws. Using
 * setTextSelection (rather than building a CellSelection) keeps this
 * file's dependencies to @tiptap/core only — no @tiptap/pm subpaths.
 */
function moveCursorInto(editor: Editor, cellEl: HTMLElement | undefined): void {
  if (!cellEl) return;
  try {
    const view = editor.view;
    const pos = view.posAtDOM(cellEl, 0);
    editor.chain().focus().setTextSelection(pos).run();
  } catch {
    // posAtDOM can throw if the DOM-to-pm mapping isn't stable; fall
    // through silently. The popup will still open and act on whatever
    // selection the editor currently has.
  }
}

/**
 * Raise the popup-open event. TablePopup listens on the window and
 * mounts itself; we keep the two components decoupled.
 */
function fireOpen(scope: SelectionScope, index?: number): void {
  window.dispatchEvent(
    new CustomEvent('nc:table-popup-open', {
      detail: { scope, index },
    }),
  );
}
