import { useEffect, useMemo, useRef, useState } from 'react';
import katex from 'katex';

/**
 * Math editor popover — opens when the user clicks a math node
 * in the editor, or via slash-menu / bubble-menu / shortcut for
 * fresh insertion.
 *
 * Three panes:
 *   1. Textarea (left): the LaTeX source. Auto-focused.
 *   2. Live preview (right): KaTeX-rendered output of whatever's
 *      currently in the textarea. Updates on every keystroke
 *      (KaTeX is synchronous; no debounce needed).
 *   3. Symbol palette (bottom): clickable grid of common LaTeX
 *      symbols, grouped by category. Click → insert at cursor in
 *      the textarea. Some entries are templates (with $1, $2
 *      placeholders); inserting a template positions the cursor
 *      at the first placeholder so the user can immediately fill
 *      in the operand.
 *
 * Commit:
 *   - Ctrl/Cmd+Enter            → commit + close
 *   - "Insert" button           → commit + close
 *   - Click outside              → commit + close (autosave gesture)
 *   - Escape                    → cancel + close (no commit)
 *   - "Cancel" button           → cancel + close
 *
 * Why click-outside commits (not cancels): the host editor treats
 * blur as a save trigger throughout the app, and re-using that
 * idiom here means the user doesn't need to learn a different
 * "did my edit save?" question for math vs note body.
 */
export interface MathEditPopoverProps {
  /** Anchor x in viewport coords (popover clamps itself to viewport). */
  x: number;
  /** Anchor y in viewport coords. */
  y: number;
  initialLatex: string;
  isBlock: boolean;
  onCommit: (latex: string) => void;
  onClose: () => void;
}

interface SymbolEntry {
  label: string;
  /**
   * The string to insert at the cursor. If it contains `$1`, the
   * caret lands on that token (and `$1` is removed from the
   * inserted text) so the user can type the operand directly.
   * Subsequent `$N` tokens are also stripped, but the caret only
   * lands on `$1` — they're documentation for the user who reads
   * the inserted source.
   */
  insert: string;
  /** Optional alt label (longer, shown as title attribute). */
  title?: string;
}

interface SymbolGroup {
  name: string;
  symbols: SymbolEntry[];
}

/**
 * Palette content — kept inline because the file is short and
 * the data doesn't need to be reused. ~60 symbols across 6
 * groups. Order within a group is "most common first".
 */
const SYMBOL_GROUPS: SymbolGroup[] = [
  {
    name: 'Structure',
    symbols: [
      { label: 'x²', insert: '$1^{2}', title: 'Squared' },
      { label: 'xⁿ', insert: '$1^{$2}', title: 'Superscript' },
      { label: 'xₙ', insert: '$1_{$2}', title: 'Subscript' },
      { label: 'a/b', insert: '\\frac{$1}{$2}', title: 'Fraction' },
      { label: '√', insert: '\\sqrt{$1}', title: 'Square root' },
      { label: 'ⁿ√', insert: '\\sqrt[$1]{$2}', title: 'Nth root' },
      { label: '( )', insert: '\\left( $1 \\right)', title: 'Auto-sized parentheses' },
      { label: '[ ]', insert: '\\left[ $1 \\right]', title: 'Auto-sized brackets' },
      { label: '{ }', insert: '\\left\\{ $1 \\right\\}', title: 'Auto-sized braces' },
      { label: '|x|', insert: '\\left| $1 \\right|', title: 'Absolute value' },
    ],
  },
  {
    name: 'Operators',
    symbols: [
      { label: '×', insert: '\\times' },
      { label: '÷', insert: '\\div' },
      { label: '·', insert: '\\cdot', title: 'Centered dot' },
      { label: '±', insert: '\\pm' },
      { label: '∓', insert: '\\mp' },
      { label: '∑', insert: '\\sum_{$1}^{$2}', title: 'Summation' },
      { label: '∏', insert: '\\prod_{$1}^{$2}', title: 'Product' },
      { label: '∫', insert: '\\int_{$1}^{$2}', title: 'Integral' },
      { label: '∂', insert: '\\partial' },
      { label: '∇', insert: '\\nabla' },
      { label: '∞', insert: '\\infty' },
    ],
  },
  {
    name: 'Relations',
    symbols: [
      { label: '≤', insert: '\\le' },
      { label: '≥', insert: '\\ge' },
      { label: '≠', insert: '\\neq' },
      { label: '≈', insert: '\\approx' },
      { label: '≡', insert: '\\equiv' },
      { label: '∝', insert: '\\propto' },
      { label: '∼', insert: '\\sim' },
      { label: '∈', insert: '\\in' },
      { label: '∉', insert: '\\notin' },
      { label: '⊆', insert: '\\subseteq' },
      { label: '⊂', insert: '\\subset' },
    ],
  },
  {
    name: 'Arrows',
    symbols: [
      { label: '→', insert: '\\to' },
      { label: '←', insert: '\\leftarrow' },
      { label: '↔', insert: '\\leftrightarrow' },
      { label: '⇒', insert: '\\Rightarrow' },
      { label: '⇐', insert: '\\Leftarrow' },
      { label: '⇔', insert: '\\Leftrightarrow' },
      { label: '⟶', insert: '\\longrightarrow' },
      { label: '↦', insert: '\\mapsto' },
    ],
  },
  {
    name: 'Greek',
    symbols: [
      { label: 'α', insert: '\\alpha' },
      { label: 'β', insert: '\\beta' },
      { label: 'γ', insert: '\\gamma' },
      { label: 'δ', insert: '\\delta' },
      { label: 'ε', insert: '\\epsilon' },
      { label: 'θ', insert: '\\theta' },
      { label: 'λ', insert: '\\lambda' },
      { label: 'μ', insert: '\\mu' },
      { label: 'π', insert: '\\pi' },
      { label: 'ρ', insert: '\\rho' },
      { label: 'σ', insert: '\\sigma' },
      { label: 'τ', insert: '\\tau' },
      { label: 'φ', insert: '\\phi' },
      { label: 'ω', insert: '\\omega' },
      { label: 'Γ', insert: '\\Gamma' },
      { label: 'Δ', insert: '\\Delta' },
      { label: 'Θ', insert: '\\Theta' },
      { label: 'Λ', insert: '\\Lambda' },
      { label: 'Π', insert: '\\Pi' },
      { label: 'Σ', insert: '\\Sigma' },
      { label: 'Φ', insert: '\\Phi' },
      { label: 'Ω', insert: '\\Omega' },
    ],
  },
  {
    name: 'Structures',
    symbols: [
      {
        label: 'matrix',
        insert: '\\begin{pmatrix} $1 & $2 \\\\ $3 & $4 \\end{pmatrix}',
        title: '2x2 matrix in parentheses',
      },
      {
        label: 'cases',
        insert: '\\begin{cases} $1 & \\text{if } $2 \\\\ $3 & \\text{otherwise} \\end{cases}',
        title: 'Cases (piecewise)',
      },
      { label: 'text', insert: '\\text{$1}', title: 'Literal text inside math' },
      { label: 'overline', insert: '\\overline{$1}' },
      { label: 'hat', insert: '\\hat{$1}' },
      { label: 'vec', insert: '\\vec{$1}' },
      { label: 'sin', insert: '\\sin' },
      { label: 'cos', insert: '\\cos' },
      { label: 'log', insert: '\\log' },
      { label: 'ln', insert: '\\ln' },
    ],
  },
];

/**
 * Approximate popover footprint. Used to clamp the anchor into
 * viewport space. The numbers don't need to be exact — they're
 * "what the user sees" and a few pixels of slack on either side
 * is fine.
 */
const POPOVER_WIDTH = 560;
const POPOVER_HEIGHT = 420;

export function MathEditPopover({
  x,
  y,
  initialLatex,
  isBlock,
  onCommit,
  onClose,
}: MathEditPopoverProps) {
  const [latex, setLatex] = useState(initialLatex);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Clamp the anchor inside the viewport. Edge of viewport on the
  // right → push the popover left. Edge of viewport on the bottom
  // → push above instead of below.
  const clamped = useMemo(() => {
    const vw =
      typeof window !== 'undefined' ? window.innerWidth : POPOVER_WIDTH;
    const vh =
      typeof window !== 'undefined' ? window.innerHeight : POPOVER_HEIGHT;
    let cx = x;
    let cy = y;
    if (cx + POPOVER_WIDTH > vw - 8) cx = vw - POPOVER_WIDTH - 8;
    if (cx < 8) cx = 8;
    if (cy + POPOVER_HEIGHT > vh - 8) cy = vh - POPOVER_HEIGHT - 8;
    if (cy < 8) cy = 8;
    return { cx, cy };
  }, [x, y]);

  // --- Auto-focus the textarea once when the popover opens. ----
  useEffect(() => {
    const t = textareaRef.current;
    if (!t) return;
    t.focus();
    // Place the cursor at the end of any existing source.
    const len = t.value.length;
    t.setSelectionRange(len, len);
  }, []);

  // --- Live preview --------------------------------------------
  useEffect(() => {
    const target = previewRef.current;
    if (!target) return;
    if (latex.trim() === '') {
      target.innerHTML =
        '<span style="opacity:0.55;font-style:italic;">(preview)</span>';
      return;
    }
    try {
      katex.render(latex, target, {
        displayMode: isBlock,
        throwOnError: false,
        output: 'html',
        strict: false,
        trust: false,
      });
    } catch {
      target.textContent = `[math error] ${latex}`;
    }
  }, [latex, isBlock]);

  // --- Commit / cancel keybindings ------------------------------
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onCommit(latex);
      return;
    }
    // Plain Enter in inline-math textarea: still commits (inline
    // math is a one-line affair). In block-math textarea, Enter
    // inserts a newline (multi-line LaTeX is normal for matrix /
    // cases / aligned environments).
    if (e.key === 'Enter' && !isBlock && !e.shiftKey) {
      e.preventDefault();
      onCommit(latex);
      return;
    }
  };

  // --- Outside-click → commit ----------------------------------
  //
  // We listen on mousedown (not click) because:
  //   - mousedown fires before focus moves, so the textarea hasn't
  //     yet lost focus when our handler runs, and
  //   - matches the close-on-outside-click pattern used elsewhere
  //     (VaultAppearancePopover etc.).
  // We commit on outside-click (consistent with the editor's
  // "click away = save" convention), and cancel on Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const target = e.target as Node | null;
      if (target && root.contains(target)) return;
      onCommit(latex);
    };
    // Stash 0ms so the mousedown that OPENED the popover doesn't
    // immediately close it (that mousedown is processed in the
    // same tick and would hit the document handler).
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onDown);
    };
  }, [latex, onCommit]);

  // --- Palette → insert at cursor ------------------------------
  const insertSymbol = (entry: SymbolEntry) => {
    const t = textareaRef.current;
    if (!t) return;
    const before = t.value.slice(0, t.selectionStart);
    const after = t.value.slice(t.selectionEnd);
    let inserted = entry.insert;
    let caretOffset = inserted.length;
    // Find $1 token and route the caret there. Strip all $N
    // tokens before computing the final string.
    const dollarOneIdx = inserted.indexOf('$1');
    if (dollarOneIdx >= 0) {
      caretOffset = dollarOneIdx;
    }
    inserted = inserted.replace(/\$\d+/g, '');
    const next = before + inserted + after;
    setLatex(next);
    // Schedule the caret update after React commits the new
    // textarea value — we can't move the selection on a stale
    // DOM. requestAnimationFrame is overkill here; a microtask
    // (setTimeout 0) is enough and avoids the rAF overhead.
    setTimeout(() => {
      const target = textareaRef.current;
      if (!target) return;
      target.focus();
      const pos = before.length + caretOffset;
      target.setSelectionRange(pos, pos);
    }, 0);
  };

  return (
    <div
      ref={rootRef}
      className="nc-math-popover"
      style={{
        position: 'fixed',
        left: clamped.cx,
        top: clamped.cy,
        width: POPOVER_WIDTH,
        zIndex: 9000,
      }}
      onMouseDown={(e) => {
        // Stop ProseMirror from stealing focus when the user clicks
        // inside the popover (on a palette button, etc). Without
        // this, clicking a palette glyph would blur the textarea
        // and the inserted symbol would land at a stale cursor.
        // The textarea itself is unaffected because its own
        // onMouseDown bubbles up to here and then we ALLOW the
        // default focus action by NOT preventDefault'ing.
        if (e.target !== textareaRef.current) {
          e.preventDefault();
        }
      }}
    >
      <div className="nc-math-popover-header">
        <strong>{isBlock ? 'Block math' : 'Inline math'}</strong>
        <span className="nc-math-popover-hint">
          {isBlock
            ? 'Ctrl+Enter to insert · Esc to cancel'
            : 'Enter to insert · Esc to cancel'}
        </span>
      </div>

      <div className="nc-math-popover-body">
        <textarea
          ref={textareaRef}
          className="nc-math-popover-source"
          value={latex}
          onChange={(e) => setLatex(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          placeholder={
            isBlock
              ? 'LaTeX block math source\\n(multi-line allowed)'
              : 'LaTeX inline math source'
          }
          rows={isBlock ? 6 : 3}
        />
        <div className="nc-math-popover-preview-wrap">
          <div className="nc-math-popover-preview-label">Preview</div>
          <div ref={previewRef} className="nc-math-popover-preview" />
        </div>
      </div>

      <div className="nc-math-popover-palette">
        {SYMBOL_GROUPS.map((g) => (
          <div key={g.name} className="nc-math-palette-group">
            <div className="nc-math-palette-group-label">{g.name}</div>
            <div className="nc-math-palette-row">
              {g.symbols.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  className="nc-math-palette-button"
                  onMouseDown={(e) => {
                    // preventDefault keeps the textarea focused so
                    // the cursor stays where it was — the wrapper
                    // also preventDefault's, but we belt-and-braces
                    // here in case our parent handler is bypassed.
                    e.preventDefault();
                    insertSymbol(s);
                  }}
                  title={s.title ?? s.label}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="nc-math-popover-footer">
        <button
          type="button"
          className="nc-math-popover-button-secondary"
          onMouseDown={(e) => {
            e.preventDefault();
            onClose();
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="nc-math-popover-button-primary"
          onMouseDown={(e) => {
            e.preventDefault();
            onCommit(latex);
          }}
        >
          Insert
        </button>
      </div>
    </div>
  );
}
