import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';

/**
 * Unified table popup.
 *
 * Rendered when the user clicks a grip on the TableGripOverlay. The
 * grip raises a `nc:table-popup-open` window event with a selection
 * scope (`row`, `column`, or `table`); we listen, mount, and show
 * actions appropriate to that scope.
 *
 * Scope → actions:
 *
 *   row:
 *     - Add row above
 *     - Add row below
 *     - Delete row
 *     - Row height (input + Auto/24/32/48/64 presets)
 *     - Toggle header row
 *
 *   column:
 *     - Add column left
 *     - Add column right
 *     - Delete column
 *     - Cell align (left / center / right)   [acts on the column's cells]
 *     - Toggle header column
 *
 *   table:
 *     - Row height (input + presets)
 *     - Toggle header row
 *     - Toggle header column
 *     - Merge cells / Split cell   (enabled when a multi-cell selection
 *                                    or a merged cell exists)
 *     - Delete table
 *
 * Row height applies to the whole table — there is only one rowHeight
 * attribute per table — so it appears in both "row" and "table" scopes.
 * Picking a row and changing the height changes every row; this is the
 * intentional design carried forward from the previous toolbar (one
 * knob per table).
 *
 * Dismissal:
 *
 *   - Escape key                → close (and re-focus editor)
 *   - click outside the popup   → close
 *   - selection moves outside the table (editor transaction)
 *                               → close
 *   - the editor changes (new note loaded)
 *                               → close
 *
 *   On close we dispatch `nc:table-popup-close` so the grip overlay
 *   can drop its "active" pin.
 *
 * Positioning:
 *
 *   The popup positions itself relative to the active table's bounding
 *   rect — same model as the old TableToolbar. It clamps inside the
 *   viewport with a small inset and uses the topbar's actual bottom
 *   (not a hardcoded value) so a wrapped mobile topbar works.
 */
export interface TablePopupProps {
  editor: Editor | null;
}

type SelectionScope = 'row' | 'column' | 'table';

interface PopupState {
  scope: SelectionScope;
  index?: number; // 0-based row/column index; undefined for 'table'
}

interface PopupPosition {
  top: number;
  left: number;
}

const ROW_HEIGHT_MIN = 16;
const ROW_HEIGHT_MAX = 400;

const ROW_HEIGHT_PRESETS: Array<{ label: string; value: number | null }> = [
  { label: 'Auto', value: null },
  { label: '24px', value: 24 },
  { label: '32px', value: 32 },
  { label: '48px', value: 48 },
  { label: '64px', value: 64 },
];

// Estimated popup width for the horizontal clamp. The actual width
// is min-width 280 / max-width 360 in CSS; we clamp on the upper
// bound so the popup never slides off the right edge.
const POPUP_WIDTH_ESTIMATE = 360;

const FALLBACK_TOP_INSET = 8;

export function TablePopup({ editor }: TablePopupProps) {
  // The popup is "open" iff this state is non-null. Set by the open
  // event; cleared on dismissal.
  const [state, setState] = useState<PopupState | null>(null);

  // Position of the popup. Recomputed on transactions / scroll /
  // resize while open.
  const [position, setPosition] = useState<PopupPosition | null>(null);

  // Current rowHeight attr on the active table, mirrored so the
  // input/presets render the right active state.
  const [rowHeight, setRowHeight] = useState<number | null>(null);

  // For merge/split availability.
  const [canMerge, setCanMerge] = useState(false);
  const [canSplit, setCanSplit] = useState(false);

  // Track the active cell's align (for the column-scope alignment
  // button highlight). Driven off the selection's first cell.
  const [currentAlign, setCurrentAlign] = useState<string | null>(null);

  // Ref to the popup DOM so the outside-click handler can ignore
  // clicks on the popup itself.
  const popupRef = useRef<HTMLDivElement | null>(null);

  // ----- open / close wiring ---------------------------------------

  useEffect(() => {
    function onOpen(e: Event) {
      const ce = e as CustomEvent<{ scope: SelectionScope; index?: number }>;
      if (!ce.detail) return;
      setState({ scope: ce.detail.scope, index: ce.detail.index });
    }
    window.addEventListener('nc:table-popup-open', onOpen);
    return () => window.removeEventListener('nc:table-popup-open', onOpen);
  }, []);

  // Dismiss helper. Single source of truth — also fires the close
  // event for the grip overlay.
  function close() {
    setState(null);
    setPosition(null);
    window.dispatchEvent(new CustomEvent('nc:table-popup-close'));
  }

  // Escape key closes.
  useEffect(() => {
    if (!state) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // close is stable enough — re-binding on every state change is
    // fine and avoids stale-closure worries.
  }, [state]);

  // Click-outside closes. We listen on the document and check
  // whether the click target is inside the popup. Grip clicks are
  // handled by the overlay (which dispatches a fresh open event); we
  // want grip clicks to *replace* the state, not close-then-open, so
  // we ignore clicks on elements with `.nc-table-grip`.
  useEffect(() => {
    if (!state) return;
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (popupRef.current && popupRef.current.contains(target)) return;
      if (target.closest('.nc-table-grip')) return;
      // Click landed somewhere outside both — dismiss.
      close();
    }
    // Use a slight delay before binding so the click that opened
    // the popup doesn't immediately close it via this handler.
    const id = setTimeout(() => {
      document.addEventListener('mousedown', onClick);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onClick);
    };
  }, [state]);

  // Close if the editor leaves the table (selection moved out) or
  // the editor instance changes (note switched).
  useEffect(() => {
    if (!editor || !state) return;

    function check() {
      if (!editor) return;
      if (!editor.isActive('table')) {
        close();
      }
    }
    editor.on('transaction', check);
    editor.on('selectionUpdate', check);
    return () => {
      editor.off('transaction', check);
      editor.off('selectionUpdate', check);
    };
  }, [editor, state]);

  const editorRef = useRef(editor);
  useEffect(() => {
    if (editorRef.current !== editor) {
      if (state) close();
      editorRef.current = editor;
    }
    // We only react to editor identity changes; state in deps
    // would re-fire close on every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // ----- positioning + attribute mirroring -------------------------

  useEffect(() => {
    if (!editor || !state) return;

    function reposition() {
      if (!editor) return;

      // Find the active table by walking up from the selection.
      const view = editor.view;
      const { from } = editor.state.selection;
      let domNode: Node | null;
      try {
        domNode = view.domAtPos(from).node;
      } catch {
        setPosition(null);
        return;
      }
      let el: HTMLElement | null = domNode instanceof HTMLElement
        ? domNode
        : (domNode?.parentElement ?? null);
      while (el && el.tagName !== 'TABLE') el = el.parentElement;
      if (!el) {
        setPosition(null);
        return;
      }

      const rect = el.getBoundingClientRect();

      // Mirror rowHeight and align attributes.
      const tableAttrs = editor.getAttributes('table');
      setRowHeight(typeof tableAttrs.rowHeight === 'number' ? tableAttrs.rowHeight : null);

      const cellAttrs = editor.getAttributes('tableCell');
      const headerAttrs = editor.getAttributes('tableHeader');
      const activeCellAttrs = Object.keys(cellAttrs).length > 0 ? cellAttrs : headerAttrs;
      setCurrentAlign(typeof activeCellAttrs.align === 'string' ? activeCellAttrs.align : null);

      setCanMerge(editor.can().mergeCells());
      setCanSplit(editor.can().splitCell());

      // Place the popup ABOVE the table's selected row/column when
      // possible, otherwise just below the table's top edge inside
      // the first row.
      const topbarEl = document.querySelector('.nc-topbar') as HTMLElement | null;
      const minVisibleTop = topbarEl
        ? topbarEl.getBoundingClientRect().bottom + 4
        : FALLBACK_TOP_INSET;

      // Default placement: above the table by ~8px, plus the
      // popup's estimated height (we use a conservative 240px so
      // most layouts fit; the popup's max-height keeps it bounded).
      const POPUP_HEIGHT_ESTIMATE = 240;
      let top = rect.top - POPUP_HEIGHT_ESTIMATE - 8;
      if (top < minVisibleTop) {
        // Not enough room above. Drop it below the table.
        top = rect.bottom + 8;
      }

      const minLeft = 8;
      const maxLeft = window.innerWidth - POPUP_WIDTH_ESTIMATE - 8;
      const clampedLeft = Math.min(Math.max(rect.left, minLeft), maxLeft);

      // visualViewport-aware clamp on bottom edge (soft keyboard).
      const vv = window.visualViewport;
      const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      const topMax = visibleBottom - POPUP_HEIGHT_ESTIMATE - 4;
      const clampedTop = Math.min(top, topMax);

      setPosition({ top: clampedTop, left: clampedLeft });
    }

    reposition();
    editor.on('transaction', reposition);
    editor.on('selectionUpdate', reposition);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', reposition);
      vv.addEventListener('scroll', reposition);
    }

    return () => {
      editor.off('transaction', reposition);
      editor.off('selectionUpdate', reposition);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      if (vv) {
        vv.removeEventListener('resize', reposition);
        vv.removeEventListener('scroll', reposition);
      }
    };
  }, [editor, state]);

  if (!editor || !state || !position) return null;

  // ----- action helpers --------------------------------------------

  function call(fn: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) {
    if (!editor) return;
    fn(editor.chain().focus()).run();
  }

  function setRowHeightAttr(value: number | null) {
    if (!editor) return;
    editor.chain().focus().updateAttributes('table', { rowHeight: value }).run();
  }

  function setAlign(value: 'left' | 'center' | 'right' | null) {
    if (!editor) return;
    const next = currentAlign === value ? null : value;
    editor.chain().focus().setCellAttribute('align', next).run();
  }

  // ----- render scope-appropriate sections -------------------------

  const showRowSection = state.scope === 'row';
  const showColumnSection = state.scope === 'column';
  const showTableSection = state.scope === 'table';

  const title =
    state.scope === 'row'    ? `Row ${(state.index ?? 0) + 1}` :
    state.scope === 'column' ? `Column ${(state.index ?? 0) + 1}` :
                                'Table';

  return (
    <div
      ref={popupRef}
      className="nc-table-popup"
      role="dialog"
      aria-label={`${title} options`}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        zIndex: 50,
      }}
      // Prevent the editor from blurring when interacting with the popup.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="nc-table-popup-header">
        <span className="nc-table-popup-title">{title}</span>
        <button
          type="button"
          className="nc-table-popup-close"
          onClick={close}
          title="Close (Esc)"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* ------------------------ Row scope ------------------------ */}
      {showRowSection && (
        <>
          <div className="nc-table-popup-section">
            <div className="nc-table-popup-actions">
              <button
                type="button"
                className="nc-table-popup-action"
                onClick={() => call((c) => c.addRowBefore())}
                title="Add a row above the selected row"
              >
                + Row above
              </button>
              <button
                type="button"
                className="nc-table-popup-action"
                onClick={() => call((c) => c.addRowAfter())}
                title="Add a row below the selected row"
              >
                + Row below
              </button>
              <button
                type="button"
                className="nc-table-popup-action nc-table-popup-action-danger"
                onClick={() => { call((c) => c.deleteRow()); close(); }}
                title="Delete the selected row"
              >
                Delete row
              </button>
            </div>
          </div>

          <div className="nc-table-popup-divider" />

          <RowHeightSection
            value={rowHeight}
            onSet={setRowHeightAttr}
          />

          <div className="nc-table-popup-divider" />

          <div className="nc-table-popup-section">
            <div className="nc-table-popup-row">
              <span className="nc-table-popup-label">Header row</span>
              <button
                type="button"
                className="nc-table-popup-action"
                onClick={() => call((c) => c.toggleHeaderRow())}
                title="Toggle the top row as a header"
              >
                Toggle
              </button>
            </div>
          </div>
        </>
      )}

      {/* --------------------- Column scope ----------------------- */}
      {showColumnSection && (
        <>
          <div className="nc-table-popup-section">
            <div className="nc-table-popup-actions">
              <button
                type="button"
                className="nc-table-popup-action"
                onClick={() => call((c) => c.addColumnBefore())}
                title="Add a column to the left of the selected column"
              >
                + Column left
              </button>
              <button
                type="button"
                className="nc-table-popup-action"
                onClick={() => call((c) => c.addColumnAfter())}
                title="Add a column to the right of the selected column"
              >
                + Column right
              </button>
              <button
                type="button"
                className="nc-table-popup-action nc-table-popup-action-danger"
                onClick={() => { call((c) => c.deleteColumn()); close(); }}
                title="Delete the selected column"
              >
                Delete column
              </button>
            </div>
          </div>

          <div className="nc-table-popup-divider" />

          <div className="nc-table-popup-section">
            <div className="nc-table-popup-row">
              <span className="nc-table-popup-label">Cell align</span>
              <div className="nc-table-popup-align-group">
                <AlignButton title="Align left"   active={currentAlign === 'left'}   onClick={() => setAlign('left')}>⇤</AlignButton>
                <AlignButton title="Align center" active={currentAlign === 'center'} onClick={() => setAlign('center')}>⇔</AlignButton>
                <AlignButton title="Align right"  active={currentAlign === 'right'}  onClick={() => setAlign('right')}>⇥</AlignButton>
              </div>
            </div>
          </div>

          <div className="nc-table-popup-divider" />

          <div className="nc-table-popup-section">
            <div className="nc-table-popup-row">
              <span className="nc-table-popup-label">Header column</span>
              <button
                type="button"
                className="nc-table-popup-action"
                onClick={() => call((c) => c.toggleHeaderColumn())}
                title="Toggle the leftmost column as a header"
              >
                Toggle
              </button>
            </div>
          </div>
        </>
      )}

      {/* ---------------------- Table scope ----------------------- */}
      {showTableSection && (
        <>
          <RowHeightSection
            value={rowHeight}
            onSet={setRowHeightAttr}
          />

          <div className="nc-table-popup-divider" />

          <div className="nc-table-popup-section">
            <div className="nc-table-popup-row">
              <span className="nc-table-popup-label">Header row</span>
              <button
                type="button"
                className="nc-table-popup-action"
                onClick={() => call((c) => c.toggleHeaderRow())}
                title="Toggle the top row as a header"
              >
                Toggle
              </button>
            </div>
            <div className="nc-table-popup-row">
              <span className="nc-table-popup-label">Header column</span>
              <button
                type="button"
                className="nc-table-popup-action"
                onClick={() => call((c) => c.toggleHeaderColumn())}
                title="Toggle the leftmost column as a header"
              >
                Toggle
              </button>
            </div>
          </div>

          <div className="nc-table-popup-divider" />

          <div className="nc-table-popup-section">
            <div className="nc-table-popup-row">
              <span className="nc-table-popup-label">Cells</span>
              <div className="nc-table-popup-merge-group">
                <button
                  type="button"
                  className="nc-table-popup-action"
                  onClick={() => call((c) => c.mergeCells())}
                  disabled={!canMerge}
                  title={canMerge ? 'Merge selected cells' : 'Select multiple cells to merge'}
                >
                  Merge
                </button>
                <button
                  type="button"
                  className="nc-table-popup-action"
                  onClick={() => call((c) => c.splitCell())}
                  disabled={!canSplit}
                  title={canSplit ? 'Split this merged cell' : 'Cell is not merged'}
                >
                  Split
                </button>
              </div>
            </div>
          </div>

          <div className="nc-table-popup-divider" />

          <div className="nc-table-popup-section">
            <button
              type="button"
              className="nc-table-popup-action nc-table-popup-action-danger nc-table-popup-action-wide"
              onClick={() => { call((c) => c.deleteTable()); close(); }}
              title="Delete the entire table"
            >
              Delete table
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ----- subsections -------------------------------------------------

interface RowHeightSectionProps {
  value: number | null;
  onSet: (value: number | null) => void;
}

function RowHeightSection({ value, onSet }: RowHeightSectionProps) {
  // Controlled input — same pattern as the previous toolbar's panel.
  // Commits on blur or Enter; preset buttons commit immediately.
  const [inputValue, setInputValue] = useState<string>(value != null ? String(value) : '');

  useEffect(() => {
    setInputValue(value != null ? String(value) : '');
  }, [value]);

  function commit(raw: string) {
    if (raw === '') {
      onSet(null);
      return;
    }
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return;
    const clamped = Math.min(Math.max(n, ROW_HEIGHT_MIN), ROW_HEIGHT_MAX);
    onSet(clamped);
  }

  return (
    <div className="nc-table-popup-section">
      <div className="nc-table-popup-row">
        <label className="nc-table-popup-label" htmlFor="nc-table-row-height">
          Row height
        </label>
        <div className="nc-table-popup-rh-input">
          <input
            id="nc-table-row-height"
            type="number"
            min={ROW_HEIGHT_MIN}
            max={ROW_HEIGHT_MAX}
            step={1}
            placeholder="Auto"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit((e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="nc-table-popup-input"
          />
          <span className="nc-table-popup-unit">px</span>
        </div>
      </div>
      <div className="nc-table-popup-presets">
        {ROW_HEIGHT_PRESETS.map((preset) => {
          const isActive = preset.value === value;
          return (
            <button
              key={preset.label}
              type="button"
              className={
                isActive
                  ? 'nc-table-popup-preset nc-table-popup-preset-active'
                  : 'nc-table-popup-preset'
              }
              onClick={() => onSet(preset.value)}
              title={preset.value == null ? 'Reset to default' : `Set row height to ${preset.value}px`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ----- small buttons ----------------------------------------------

interface AlignButtonProps {
  title: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function AlignButton({ title, active, onClick, children }: AlignButtonProps) {
  return (
    <button
      type="button"
      className={
        active
          ? 'nc-table-popup-align nc-table-popup-align-active'
          : 'nc-table-popup-align'
      }
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}
