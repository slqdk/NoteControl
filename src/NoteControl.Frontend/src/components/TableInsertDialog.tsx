import { useEffect, useRef, useState } from 'react';

/**
 * Modal dialog shown when the user picks "Table" from the slash
 * menu. Lets the user pick rows, columns, whether to include a
 * header row, and an optional row height before inserting.
 *
 * Why a modal vs an inline picker (Notion-style hover grid): the
 * controls include a numeric height input which doesn't fit well in
 * the slash menu's narrow filter list. A small centered modal gives
 * us room for clear labels and presets, and matches the visual
 * weight of a "you're about to insert structure" decision.
 *
 * Lifecycle:
 *   - Opened by the slash menu's Table command via a ref handler
 *     wired up in NoteEditor / TemplateEditor (the host editor
 *     owns the open state).
 *   - The slash menu has already deleted the trigger range ("/" +
 *     filter text) before opening — this dialog is purely an
 *     insertion form.
 *   - On confirm: calls onInsert(opts). The host editor then runs
 *     the actual insertTable command so this dialog stays free of
 *     editor knowledge.
 *   - On cancel / Escape / click-outside: calls onCancel and the
 *     host removes the dialog.
 */

export interface TableInsertOpts {
  rows: number;
  cols: number;
  withHeaderRow: boolean;
  /** null = leave rowHeight attribute unset (default, content-driven). */
  rowHeight: number | null;
}

export interface TableInsertDialogProps {
  onInsert: (opts: TableInsertOpts) => void;
  onCancel: () => void;
}

// Same clamp range as the toolbar's row-height input.
const ROW_HEIGHT_MIN = 16;
const ROW_HEIGHT_MAX = 400;

// Sane bounds for rows/cols. Above these the table becomes unwieldy
// and may slow the editor; below 1 has no meaning.
const ROWS_MIN = 1;
const ROWS_MAX = 50;
const COLS_MIN = 1;
const COLS_MAX = 20;

// Defaults: match the previous slash-menu behaviour (3×3 with header)
// so the muscle-memory case of "Enter, Enter" gives the same result.
const DEFAULT_ROWS = 3;
const DEFAULT_COLS = 3;
const DEFAULT_WITH_HEADER = true;
const DEFAULT_ROW_HEIGHT: number | null = null;

const ROW_HEIGHT_PRESETS: Array<{ label: string; value: number | null }> = [
  { label: 'Auto', value: null },
  { label: '24px', value: 24 },
  { label: '32px', value: 32 },
  { label: '48px', value: 48 },
  { label: '64px', value: 64 },
];

export function TableInsertDialog({ onInsert, onCancel }: TableInsertDialogProps) {
  const [rows, setRows] = useState(DEFAULT_ROWS);
  const [cols, setCols] = useState(DEFAULT_COLS);
  const [withHeaderRow, setWithHeaderRow] = useState(DEFAULT_WITH_HEADER);
  const [rowHeight, setRowHeight] = useState<number | null>(DEFAULT_ROW_HEIGHT);

  // Local string for the row-height input — same controlled-string
  // pattern as the toolbar's input so users can type freely.
  const [rowHeightInput, setRowHeightInput] = useState<string>('');

  // Focus the rows input on mount so keyboard users can immediately
  // start typing dimensions. Tabindex order then walks naturally
  // through cols → header toggle → row-height → buttons.
  const rowsRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    rowsRef.current?.focus();
    rowsRef.current?.select();
  }, []);

  // Click-outside to close; same pattern as RssBlockSettingsPopup.
  // mousedown rather than click so a quick gesture that releases on
  // a different element still closes predictably.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onCancel();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  function clampRows(n: number): number {
    if (Number.isNaN(n)) return DEFAULT_ROWS;
    return Math.min(Math.max(n, ROWS_MIN), ROWS_MAX);
  }

  function clampCols(n: number): number {
    if (Number.isNaN(n)) return DEFAULT_COLS;
    return Math.min(Math.max(n, COLS_MIN), COLS_MAX);
  }

  function commitRowHeightInput(raw: string) {
    if (raw.trim() === '') {
      setRowHeight(null);
      return;
    }
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return;
    const clamped = Math.min(Math.max(n, ROW_HEIGHT_MIN), ROW_HEIGHT_MAX);
    setRowHeight(clamped);
    setRowHeightInput(String(clamped));
  }

  function pickPreset(value: number | null) {
    setRowHeight(value);
    setRowHeightInput(value != null ? String(value) : '');
  }

  function handleInsert() {
    onInsert({
      rows: clampRows(rows),
      cols: clampCols(cols),
      withHeaderRow,
      rowHeight,
    });
  }

  return (
    // Backdrop click is handled via the card's click-outside detector
    // above (mousedown anywhere outside the card → cancel). The
    // backdrop element below is purely visual (dimming).
    <div className="nc-table-insert-backdrop">
      <div
        ref={cardRef}
        className="nc-table-insert-card"
        role="dialog"
        aria-label="Insert table"
        aria-modal="true"
      >
        <div className="nc-table-insert-header">
          <span className="nc-table-insert-title">Insert table</span>
          <button
            type="button"
            className="nc-table-insert-close"
            onClick={onCancel}
            title="Cancel"
            aria-label="Cancel"
          >
            ×
          </button>
        </div>

        <div className="nc-table-insert-body">
          {/* Dimensions row -------------------------------------- */}
          <div className="nc-table-insert-dim-row">
            <label className="nc-table-insert-field">
              <span>Rows</span>
              <input
                ref={rowsRef}
                type="number"
                min={ROWS_MIN}
                max={ROWS_MAX}
                step={1}
                value={rows}
                onChange={(e) => setRows(parseInt(e.target.value, 10))}
                onBlur={(e) => setRows(clampRows(parseInt(e.target.value, 10)))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleInsert();
                  }
                }}
              />
            </label>
            <label className="nc-table-insert-field">
              <span>Columns</span>
              <input
                type="number"
                min={COLS_MIN}
                max={COLS_MAX}
                step={1}
                value={cols}
                onChange={(e) => setCols(parseInt(e.target.value, 10))}
                onBlur={(e) => setCols(clampCols(parseInt(e.target.value, 10)))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleInsert();
                  }
                }}
              />
            </label>
          </div>

          {/* Header-row toggle ----------------------------------- */}
          <label className="nc-table-insert-checkbox">
            <input
              type="checkbox"
              checked={withHeaderRow}
              onChange={(e) => setWithHeaderRow(e.target.checked)}
            />
            <span>Include header row</span>
          </label>

          {/* Row height ------------------------------------------ */}
          <div className="nc-table-insert-rowheight">
            <label className="nc-table-insert-field nc-table-insert-rowheight-input">
              <span>Row height</span>
              <div className="nc-table-insert-rowheight-input-wrap">
                <input
                  type="number"
                  min={ROW_HEIGHT_MIN}
                  max={ROW_HEIGHT_MAX}
                  step={1}
                  placeholder="Auto"
                  value={rowHeightInput}
                  onChange={(e) => setRowHeightInput(e.target.value)}
                  onBlur={(e) => commitRowHeightInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRowHeightInput((e.target as HTMLInputElement).value);
                      // Don't auto-submit on the height field — Enter
                      // here commits the value, then the user can
                      // press Enter again on the Insert button.
                    }
                  }}
                />
                <span className="nc-table-insert-unit">px</span>
              </div>
            </label>
            <div className="nc-table-insert-presets">
              {ROW_HEIGHT_PRESETS.map((preset) => {
                const isActive = preset.value === rowHeight;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    className={
                      isActive
                        ? 'nc-table-insert-preset nc-table-insert-preset-active'
                        : 'nc-table-insert-preset'
                    }
                    onClick={() => pickPreset(preset.value)}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
            {/* Honest note: explain the round-trip cost so the user
                understands why "Auto" is the cleanest choice. */}
            <div className="nc-table-insert-hint">
              A non-default row height saves the table as raw HTML
              inside the <code>.md</code> file (same as callouts).
              Plain tables stay as markdown pipe syntax.
            </div>
          </div>
        </div>

        <div className="nc-table-insert-footer">
          <button
            type="button"
            className="nc-table-insert-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="nc-table-insert-confirm"
            onClick={handleInsert}
          >
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}
