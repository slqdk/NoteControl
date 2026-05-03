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
}

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
      // Float the toolbar 40px above the table, left-aligned with
      // it. The 40px gap matches our other floating toolbars
      // (image, video) so the visual rhythm is consistent.
      setPosition({
        top: rect.top - 40,
        left: rect.left,
      });
    }

    update();

    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    window.addEventListener('scroll', update, true); // capture-phase: catch scrolling in any ancestor
    window.addEventListener('resize', update);

    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
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
