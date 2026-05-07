import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';

/**
 * Floating toolbar with table-manipulation actions.
 *
 * Layout: a horizontal pill of fast-action buttons, plus a "•••"
 * button on the right that toggles an options panel below the pill.
 *
 *   Fast-action row (always visible when in a table):
 *     ↑+   ↓+   |   ←+   →+   |   ⬌   ⬍   |   H   |   •••
 *     row above, row below, col left, col right, del-row, del-col,
 *     toggle header row, options menu
 *
 *   Options panel (revealed by •••):
 *     - Row height           [number input | presets: Auto / 24 / 32 / 48]
 *     - Header column        [toggle]
 *     - Cell alignment       [Left | Center | Right]   (current cell)
 *     - Merge cells / Split cell                       (current selection)
 *
 * Visibility model is unchanged from the previous version: track
 * the editor's selection state via `selectionUpdate` + `transaction`,
 * compute position from the bounding rect of the active <table>.
 *
 * The options panel state (open/closed) is local to this component
 * and survives transaction-driven re-positioning — opening it,
 * clicking a button that mutates the table, then seeing the panel
 * stay open is the desired UX. We close the panel only on:
 *   - explicit click on the ••• button while open
 *   - selection moving outside the table (component unmounts)
 *   - Escape key
 */
export interface TableToolbarProps {
  editor: Editor | null;
}

interface ToolbarPosition {
  top: number;
  left: number;
  /**
   * 'above' (default) renders 40px above the table.
   * 'below' kicks in when the table's top edge is too close to
   * the topbar — then we render just below the table's top edge.
   * Note we use 'top edge' not 'bottom edge' because tall tables
   * would push the "below" placement way down the screen.
   */
  placement: 'above' | 'below';
}

// Estimated rendered width of the fast-action row, used for
// horizontal clamping. Eight buttons + three separators ~ 320px.
// The options-panel width when open is wider — we don't clamp on
// the open width because the panel renders below the row, leaving
// the row's clamping accurate, and the panel's own positioning
// is left-aligned with the row.
const TABLE_TOOLBAR_WIDTH_ESTIMATE = 320;

// Same clamping fallback as BubbleMenu — keep in sync with that
// module's FALLBACK_TOP_INSET.
const FALLBACK_TOP_INSET = 8;

// Clamp values for the row-height input. Matches the parseHTML
// clamp in TableWithOptions so a hand-edited markdown file can't
// store a value the toolbar wouldn't allow.
const ROW_HEIGHT_MIN = 16;
const ROW_HEIGHT_MAX = 400;

// Preset row heights surfaced in the panel. "Auto" maps to null
// (no rowHeight attribute → default content-driven height).
const ROW_HEIGHT_PRESETS: Array<{ label: string; value: number | null }> = [
  { label: 'Auto', value: null },
  { label: '24px', value: 24 },
  { label: '32px', value: 32 },
  { label: '48px', value: 48 },
  { label: '64px', value: 64 },
];

export function TableToolbar({ editor }: TableToolbarProps) {
  const [active, setActive] = useState(false);
  const [position, setPosition] = useState<ToolbarPosition | null>(null);

  // Options panel disclosure. Local to this component instance.
  const [panelOpen, setPanelOpen] = useState(false);

  // Mirror of the current table's rowHeight attribute for the panel
  // input's controlled value. We re-read it from the editor on every
  // selection/transaction update so the input reflects the table the
  // user is currently inside.
  const [currentRowHeight, setCurrentRowHeight] = useState<number | null>(null);

  // Mirror of the current cell's align attribute (for highlighting
  // the active alignment button).
  const [currentAlign, setCurrentAlign] = useState<string | null>(null);

  // Visibility + position recompute. Called on every transaction
  // and on window scroll. Also reads attribute mirrors out of the
  // current selection so the panel inputs reflect the active table.
  useEffect(() => {
    if (!editor) return;

    function update() {
      if (!editor) return;
      const inTable = editor.isActive('table');
      setActive(inTable);

      if (!inTable) {
        setPosition(null);
        // Reset the panel when leaving a table — the next table
        // the user enters should start with the panel closed.
        setPanelOpen(false);
        return;
      }

      // Read the active table's rowHeight + the active cell's align
      // out of the editor state so our panel mirrors stay current.
      // We use editor.getAttributes('table') and 'tableCell' — TipTap
      // walks up the selection's ancestor nodes to find the matching
      // attrs. For a header cell the same attrs come back via
      // getAttributes('tableHeader'); we check both.
      const tableAttrs = editor.getAttributes('table');
      const cellAttrs = editor.getAttributes('tableCell');
      const headerAttrs = editor.getAttributes('tableHeader');
      const activeCellAttrs = Object.keys(cellAttrs).length > 0 ? cellAttrs : headerAttrs;

      setCurrentRowHeight(
        typeof tableAttrs.rowHeight === 'number' ? tableAttrs.rowHeight : null,
      );
      setCurrentAlign(
        typeof activeCellAttrs.align === 'string' ? activeCellAttrs.align : null,
      );

      // Find the <table> DOM node containing the current selection.
      const view = editor.view;
      const { from } = editor.state.selection;
      let domNode: Node | null;
      try {
        domNode = view.domAtPos(from).node;
      } catch {
        // Selection might be in a position that doesn't have a stable
        // DOM mapping in some edge cases; bail out.
        setPosition(null);
        return;
      }
      let el: HTMLElement | null = (domNode instanceof HTMLElement
        ? domNode
        : (domNode?.parentElement ?? null));
      while (el && el.tagName !== 'TABLE') {
        el = el.parentElement;
      }
      if (!el) {
        setPosition(null);
        return;
      }

      const rect = el.getBoundingClientRect();

      // Pick "above" or "below" based on whether the toolbar would
      // clip behind the topbar at its 40px-above position. Same
      // approach BubbleMenu uses; we look up the topbar's bottom
      // rather than hardcode --nc-topbar-h so a wrapped multi-row
      // mobile topbar is handled correctly.
      const topbarEl = document.querySelector('.nc-topbar') as HTMLElement | null;
      const minVisibleTop = topbarEl
        ? topbarEl.getBoundingClientRect().bottom + 4
        : FALLBACK_TOP_INSET;
      const wouldClipAbove = rect.top - 40 < minVisibleTop;
      const placement: 'above' | 'below' = wouldClipAbove ? 'below' : 'above';

      // Top placement:
      //   above: 40px above the table (existing behaviour)
      //   below: 8px below the table's top edge — sits inside the
      //          table's first row, which is fine because the
      //          toolbar is a fixed overlay; user can still see
      //          the cell underneath through the toolbar's spaces.
      const top = placement === 'above' ? rect.top - 40 : rect.top + 8;

      // Clamp left so the toolbar can't slide off either viewport
      // edge. Wide tables that the user has horizontally scrolled
      // can put rect.left at a negative number; the clamp pulls
      // the toolbar back on-screen with a small inset.
      const minLeft = 8;
      const maxLeft = window.innerWidth - TABLE_TOOLBAR_WIDTH_ESTIMATE - 8;
      const clampedLeft = Math.min(Math.max(rect.left, minLeft), maxLeft);

      // Clamp the toolbar's bottom edge to the visualViewport bottom
      // so the soft keyboard can't hide it. Toolbar height is ~32px
      // (one row of buttons + padding); estimate it. Same approach
      // BubbleMenu uses; see useVisualViewportBottom.ts for the
      // rationale.
      //
      // NOTE: when the panel is open, the visible toolbar is taller
      // (~32px row + ~140px panel). We don't change the clamp on
      // panel open; instead the panel's own CSS uses `max-height`
      // and overflow-y: auto so it never visually escapes the
      // viewport. Keeps positioning stable as the user toggles.
      const TABLE_TOOLBAR_HEIGHT_ESTIMATE = 32;
      const vv = window.visualViewport;
      const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      const topMax = visibleBottom - TABLE_TOOLBAR_HEIGHT_ESTIMATE - 4;
      const clampedTop = Math.min(top, topMax);

      setPosition({
        top: clampedTop,
        left: clampedLeft,
        placement,
      });
    }

    update();

    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    window.addEventListener('scroll', update, true); // capture-phase
    window.addEventListener('resize', update);

    // visualViewport changes (soft keyboard show/hide) don't fire
    // window.resize on iOS Safari. Subscribe directly so the
    // keyboard-aware clamp recomputes when the keyboard appears.
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    }

    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      if (vv) {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      }
    };
  }, [editor]);

  // Escape closes the panel (but doesn't deactivate the toolbar
  // itself — the toolbar stays bound to selection state).
  useEffect(() => {
    if (!panelOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPanelOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [panelOpen]);

  // Reset the panel disclosure when the editor instance changes
  // (e.g. switching notes). Without this, the panel would briefly
  // flash with the previous note's state on the new note's mount.
  const editorRef = useRef(editor);
  useEffect(() => {
    if (editorRef.current !== editor) {
      setPanelOpen(false);
      editorRef.current = editor;
    }
  }, [editor]);

  if (!editor || !active || !position) return null;

  // Each button calls a built-in TipTap table command. We use
  // `chain().focus()` so the editor keeps focus after the
  // operation — otherwise clicking the button would blur the
  // editor and the next operation needs a click into a cell first.
  function call(fn: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) {
    if (!editor) return;
    fn(editor.chain().focus()).run();
  }

  // Apply a row height to the current table. `null` clears the
  // attribute (table reverts to content-driven row sizing).
  // We use updateAttributes('table', ...) which TipTap implements
  // by walking up to find the nearest table node and patching its
  // attrs in a single transaction — clean undo step.
  function setRowHeight(value: number | null) {
    if (!editor) return;
    editor.chain().focus().updateAttributes('table', { rowHeight: value }).run();
  }

  // Apply alignment to the current cell (the cell containing the
  // selection's anchor). We use the table extension's built-in
  // setCellAttribute command — works on either tableCell or
  // tableHeader cells. Setting to null clears.
  function setAlign(value: 'left' | 'center' | 'right' | null) {
    if (!editor) return;
    // Toggle behaviour: clicking the active alignment clears it.
    const next = currentAlign === value ? null : value;
    editor.chain().focus().setCellAttribute('align', next).run();
  }

  return (
    <div
      className="nc-table-toolbar-wrap"
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        zIndex: 50,
      }}
      // preventDefault on mousedown keeps the editor from blurring
      // when a button is clicked. Without this, the editor's
      // selection collapses and subsequent table commands have
      // nowhere to act.
      onMouseDown={(e) => e.preventDefault()}
    >
      {/* Fast-action row — same buttons as before. */}
      <div className="nc-table-toolbar">
        <ToolbarButton
          title="Add row above"
          onClick={() => call((c) => c.addRowBefore())}
        >
          ⬆+
        </ToolbarButton>
        <ToolbarButton
          title="Add row below"
          onClick={() => call((c) => c.addRowAfter())}
        >
          ⬇+
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton
          title="Add column left"
          onClick={() => call((c) => c.addColumnBefore())}
        >
          ⬅+
        </ToolbarButton>
        <ToolbarButton
          title="Add column right"
          onClick={() => call((c) => c.addColumnAfter())}
        >
          ➡+
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton
          title="Delete row"
          onClick={() => call((c) => c.deleteRow())}
          danger
        >
          ⬌
        </ToolbarButton>
        <ToolbarButton
          title="Delete column"
          onClick={() => call((c) => c.deleteColumn())}
          danger
        >
          ⬍
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton
          title="Toggle header row"
          onClick={() => call((c) => c.toggleHeaderRow())}
        >
          H
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton
          title={panelOpen ? 'Close options' : 'More options'}
          onClick={() => setPanelOpen((p) => !p)}
          active={panelOpen}
        >
          •••
        </ToolbarButton>
      </div>

      {/* Options panel — only rendered when toggled open. */}
      {panelOpen && (
        <TableOptionsPanel
          editor={editor}
          rowHeight={currentRowHeight}
          align={currentAlign}
          onSetRowHeight={setRowHeight}
          onSetAlign={setAlign}
          onCall={call}
        />
      )}
    </div>
  );
}

// ---- Options panel -------------------------------------------------

interface TableOptionsPanelProps {
  editor: Editor;
  rowHeight: number | null;
  align: string | null;
  onSetRowHeight: (value: number | null) => void;
  onSetAlign: (value: 'left' | 'center' | 'right' | null) => void;
  onCall: (fn: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => void;
}

function TableOptionsPanel({
  editor,
  rowHeight,
  align,
  onSetRowHeight,
  onSetAlign,
  onCall,
}: TableOptionsPanelProps) {
  // Local input value. We use a controlled string so the user can
  // type freely (including a transient empty value while editing)
  // without snapping. We commit to the editor on blur OR on Enter,
  // and on preset-button clicks. This mirrors the input pattern in
  // RssBlockSettingsPopup.
  const [inputValue, setInputValue] = useState<string>(rowHeight != null ? String(rowHeight) : '');

  // Re-sync local input when the upstream value changes (e.g. user
  // clicked a preset, or moved into a different table).
  useEffect(() => {
    setInputValue(rowHeight != null ? String(rowHeight) : '');
  }, [rowHeight]);

  function commit(raw: string) {
    if (raw === '') {
      onSetRowHeight(null);
      return;
    }
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return;
    const clamped = Math.min(Math.max(n, ROW_HEIGHT_MIN), ROW_HEIGHT_MAX);
    onSetRowHeight(clamped);
  }

  // canMerge / canSplit — let TipTap tell us via its can() API so
  // we can disable the buttons when the action wouldn't apply.
  // can() runs the command's check phase without mutating, so it's
  // cheap and gives us the same yes/no the command would return.
  // We re-evaluate on every panel render — the panel only renders
  // while the toolbar is visible, so the cost is negligible.
  const canMerge = editor.can().mergeCells();
  const canSplit = editor.can().splitCell();

  return (
    <div
      className="nc-table-options-panel"
      role="dialog"
      aria-label="Table options"
    >
      {/* Row height -------------------------------------------------- */}
      <div className="nc-table-options-row">
        <label className="nc-table-options-label" htmlFor="nc-table-row-height">
          Row height
        </label>
        <div className="nc-table-options-row-h-input">
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
            className="nc-table-options-input"
          />
          <span className="nc-table-options-unit">px</span>
        </div>
      </div>
      <div className="nc-table-options-presets">
        {ROW_HEIGHT_PRESETS.map((preset) => {
          const isActive = preset.value === rowHeight;
          return (
            <button
              key={preset.label}
              type="button"
              className={
                isActive
                  ? 'nc-table-options-preset nc-table-options-preset-active'
                  : 'nc-table-options-preset'
              }
              onClick={() => onSetRowHeight(preset.value)}
              title={preset.value == null ? 'Reset to default' : `Set row height to ${preset.value}px`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div className="nc-table-options-divider" />

      {/* Cell alignment --------------------------------------------- */}
      <div className="nc-table-options-row">
        <span className="nc-table-options-label">Cell align</span>
        <div className="nc-table-options-align-group">
          <AlignButton title="Align left"   value="left"   active={align === 'left'}   onClick={() => onSetAlign('left')}>⇤</AlignButton>
          <AlignButton title="Align center" value="center" active={align === 'center'} onClick={() => onSetAlign('center')}>⇔</AlignButton>
          <AlignButton title="Align right"  value="right"  active={align === 'right'}  onClick={() => onSetAlign('right')}>⇥</AlignButton>
        </div>
      </div>

      <div className="nc-table-options-divider" />

      {/* Header column toggle --------------------------------------- */}
      <div className="nc-table-options-row">
        <span className="nc-table-options-label">Header column</span>
        <button
          type="button"
          className="nc-table-options-action"
          onClick={() => onCall((c) => c.toggleHeaderColumn())}
          title="Toggle the leftmost column as a header"
        >
          Toggle
        </button>
      </div>

      <div className="nc-table-options-divider" />

      {/* Merge / split ---------------------------------------------- */}
      <div className="nc-table-options-row">
        <span className="nc-table-options-label">Cells</span>
        <div className="nc-table-options-merge-group">
          <button
            type="button"
            className="nc-table-options-action"
            onClick={() => onCall((c) => c.mergeCells())}
            disabled={!canMerge}
            title={canMerge ? 'Merge selected cells' : 'Select multiple cells to merge'}
          >
            Merge
          </button>
          <button
            type="button"
            className="nc-table-options-action"
            onClick={() => onCall((c) => c.splitCell())}
            disabled={!canSplit}
            title={canSplit ? 'Split this merged cell' : 'Cell is not merged'}
          >
            Split
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Small button components ---------------------------------------

interface ToolbarButtonProps {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  active?: boolean;
}

function ToolbarButton({ title, onClick, children, danger, active }: ToolbarButtonProps) {
  const classes = ['nc-table-toolbar-btn'];
  if (danger) classes.push('nc-table-toolbar-btn-danger');
  if (active) classes.push('nc-table-toolbar-btn-active');
  return (
    <button type="button" className={classes.join(' ')} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

function ToolbarSeparator() {
  return <span className="nc-table-toolbar-sep" aria-hidden="true" />;
}

interface AlignButtonProps {
  title: string;
  value: 'left' | 'center' | 'right';
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
          ? 'nc-table-options-align nc-table-options-align-active'
          : 'nc-table-options-align'
      }
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}
