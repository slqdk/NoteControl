import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';

/**
 * Floating toolbar with table-manipulation actions.
 *
 * Visibility model:
 *   - Tracks the editor's selection state via subscribing to
 *     `selectionUpdate` and `transaction` events.
 *   - When the cursor is inside a table cell (`editor.isActive('table')`)
 *     we show the toolbar; otherwise it's hidden.
 *   - Position is computed from the bounding rect of the active
 *     <table> element in the DOM. Toolbar floats just above the
 *     table's top edge.
 *
 * Why not @tiptap/extension-bubble-menu? BubbleMenu attaches to
 * the user's selection range, which jumps around as the user
 * navigates between cells. We want the toolbar pinned to the
 * table's top regardless of which cell is active — easier to
 * compute that ourselves than to fight BubbleMenu's defaults.
 *
 * The toolbar is fixed-positioned (relative to viewport, not
 * editor) so it stays visible while the user scrolls within a
 * long note. We update its position on every editor transaction
 * AND on window scroll to keep it anchored to the table.
 */
export interface TableToolbarProps {
  editor: Editor | null;
}

interface ToolbarPosition {
  top: number;
  left: number;
  /**
   * Ship 83: 'above' (default) renders 40px above the table.
   * 'below' kicks in when the table's top edge is too close to
   * the topbar — then we render just below the table's top edge.
   * Note we use 'top edge' not 'bottom edge' because tall tables
   * would push the "below" placement way down the screen.
   */
  placement: 'above' | 'below';
}

// Ship 83: estimated rendered toolbar width for horizontal clamping.
// Toolbar has 8 buttons + 3 separators ≈ 280px on a phone. If the
// menu ever grows, switch to ref-based measurement.
const TABLE_TOOLBAR_WIDTH_ESTIMATE = 280;

// Same clamping fallback as BubbleMenu — kept in sync with that
// module's FALLBACK_TOP_INSET.
const FALLBACK_TOP_INSET = 8;

export function TableToolbar({ editor }: TableToolbarProps) {
  const [active, setActive] = useState(false);
  const [position, setPosition] = useState<ToolbarPosition | null>(null);

  // Recompute visibility + position from the editor's current state
  // and DOM. Called on every transaction and on window scroll.
  useEffect(() => {
    if (!editor) return;

    function update() {
      if (!editor) return;
      // isActive('table') returns true when any selection point is
      // inside a table node. Cheaper than walking the doc manually.
      const inTable = editor.isActive('table');
      setActive(inTable);

      if (!inTable) {
        setPosition(null);
        return;
      }

      // Find the <table> DOM node containing the current selection.
      // We start from the selection's anchor DOM node and walk up
      // until we hit a TABLE element. ProseMirror's
      // `domAtPos(selection.from)` gives us the anchor node.
      const view = editor.view;
      const { from } = editor.state.selection;
      let domNode: Node | null;
      try {
        domNode = view.domAtPos(from).node;
      } catch {
        // The selection might be in a position that doesn't have a
        // stable DOM mapping in some edge cases; bail out.
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

      // Ship 83: pick "above" or "below" based on whether the
      // toolbar would clip behind the topbar at its 40px-above
      // position. Same approach BubbleMenu uses; we look up the
      // topbar's bottom rather than hardcode --nc-topbar-h so a
      // wrapped multi-row mobile topbar is handled correctly.
      const topbarEl = document.querySelector('.nc-topbar') as HTMLElement | null;
      const minVisibleTop = topbarEl
        ? topbarEl.getBoundingClientRect().bottom + 4
        : FALLBACK_TOP_INSET;
      const wouldClipAbove = rect.top - 40 < minVisibleTop;
      const placement: 'above' | 'below' = wouldClipAbove ? 'below' : 'above';

      // Top:
      //   above: 40px above the table (existing behaviour)
      //   below: 8px below the table's top edge — sits inside the
      //          table's first row, which is fine because the
      //          toolbar is a fixed overlay; user can still see
      //          the cell underneath through the toolbar's spaces.
      const top = placement === 'above' ? rect.top - 40 : rect.top + 8;

      // Ship 83: clamp left so the toolbar can't slide off either
      // viewport edge. Wide tables that the user has horizontally
      // scrolled can put rect.left at a negative number; the
      // clamp pulls the toolbar back on-screen with a small inset.
      const minLeft = 8;
      const maxLeft = window.innerWidth - TABLE_TOOLBAR_WIDTH_ESTIMATE - 8;
      const clampedLeft = Math.min(Math.max(rect.left, minLeft), maxLeft);

      // Ship 85: clamp the toolbar's bottom edge to the visualViewport
      // bottom so the soft keyboard can't hide it. Toolbar height
      // is ~32px (one row of buttons + padding); estimate it.
      // Same approach BubbleMenu uses; see useVisualViewportBottom.ts
      // for the rationale.
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
    window.addEventListener('scroll', update, true); // capture-phase: catch scrolling in any ancestor
    window.addEventListener('resize', update);

    // Ship 85: visualViewport changes (soft keyboard show/hide)
    // don't fire window.resize on iOS Safari. Subscribe directly
    // so the keyboard-aware clamp recomputes when the keyboard
    // appears/disappears.
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

  if (!editor || !active || !position) return null;

  // Each button calls a built-in TipTap table command. We use
  // `chain().focus()` so the editor keeps focus after the
  // operation — otherwise clicking the button would blur the
  // editor and the next operation needs a click into a cell first.
  function call(fn: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) {
    if (!editor) return;
    fn(editor.chain().focus()).run();
  }

  return (
    <div
      className="nc-table-toolbar"
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
      {/*
        No "delete table" button here. The user deletes a table by
        drag-selecting all its cells (top-left to bottom-right) and
        pressing Del or Backspace — the editor catches that as a
        signal to remove the entire table. Keeps the toolbar focused
        on row/column ops; deletion is a destructive action that
        feels safer behind a deliberate selection gesture.
      */}
    </div>
  );
}

interface ToolbarButtonProps {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}

function ToolbarButton({ title, onClick, children, danger }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={
        danger
          ? 'nc-table-toolbar-btn nc-table-toolbar-btn-danger'
          : 'nc-table-toolbar-btn'
      }
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ToolbarSeparator() {
  return <span className="nc-table-toolbar-sep" aria-hidden="true" />;
}
