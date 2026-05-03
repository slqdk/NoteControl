import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';

/**
 * Floating formatting toolbar that appears above any text selection.
 *
 * Visibility rules:
 *   - Selection must be non-empty
 *   - Selection must span at least 2 characters (avoids the menu
 *     popping up on a stray click that landed in a tiny range)
 *   - Selection must NOT be inside a code block — inline marks
 *     (bold, italic, code, link) don't apply inside fenced code,
 *     so the menu would offer no-ops
 *   - Editor must be focused / editable
 *
 * Position model:
 *   Computed from the selection's bounding rect via
 *   `editor.view.coordsAtPos`. Toolbar floats just above the
 *   selection's top edge, horizontally centered on its midpoint.
 *   We use `position: fixed` (viewport-relative) so the toolbar
 *   stays visible when the user scrolls within a long note.
 *
 * Why not @tiptap/extension-bubble-menu? It depends on tippy.js,
 * which would be a new dependency, and the positioning logic is
 * really maybe 30 lines. The codebase's TableToolbar follows the
 * same hand-rolled pattern (subscribe to selectionUpdate +
 * transaction, compute position from a DOM rect) and the
 * consistency is worth more than tippy's polish for a four-button
 * toolbar.
 *
 * Buttons offered: Bold, Italic, inline Code, Link. Headings and
 * strikethrough are deliberately excluded:
 *   - Headings are block-level — turning a paragraph into H2
 *     affects the whole paragraph, which is confusing UI for a
 *     selection-driven menu.
 *   - Strikethrough mark isn't part of StarterKit and would need
 *     its own extension.
 */
export interface BubbleMenuProps {
  editor: Editor | null;
}

interface BubblePosition {
  top: number;
  left: number;
}

const MIN_SELECTION_CHARS = 2;
// Distance in pixels between the selection's top edge and the
// toolbar's bottom edge. Keep small so the visual link to the
// selection is obvious; not 0 because some viewers run text
// underline through the selection's top.
const VERTICAL_GAP = 8;

export function BubbleMenu({ editor }: BubbleMenuProps) {
  const [active, setActive] = useState(false);
  const [position, setPosition] = useState<BubblePosition | null>(null);

  // Recompute visibility + position from the editor's current state
  // and the selection's bounding rect. Called on every selection
  // change AND on window scroll/resize so the toolbar stays
  // anchored as the user moves the page underneath it.
  useEffect(() => {
    if (!editor) return;

    function update() {
      if (!editor) return;

      // Bail out fast if the editor isn't focused — selection state
      // may be stale and we don't want the toolbar appearing for a
      // selection in an inactive editor (e.g. user clicked away to
      // focus the breadcrumb input).
      if (!editor.view.hasFocus()) {
        setActive(false);
        return;
      }

      const { state } = editor;
      const { selection } = state;
      const { from, to, empty } = selection;

      if (empty || (to - from) < MIN_SELECTION_CHARS) {
        setActive(false);
        return;
      }

      // Skip when the selection is inside a code block. The inline
      // marks we offer (bold, italic, code, link) are not applicable
      // there — code blocks render verbatim. isActive handles both
      // cursor-inside and selection-inside-block cases.
      if (editor.isActive('codeBlock')) {
        setActive(false);
        return;
      }

      // Bounding rect of the selection. coordsAtPos returns
      // viewport coordinates (left/top/right/bottom), one call per
      // endpoint. We span from min-top (highest point of the start
      // line) to max-anything for horizontal centering.
      let startCoords: { top: number; left: number; bottom: number };
      let endCoords: { top: number; left: number; right: number; bottom: number };
      try {
        startCoords = editor.view.coordsAtPos(from);
        endCoords = editor.view.coordsAtPos(to);
      } catch {
        // coordsAtPos can throw mid-transaction if the position is
        // briefly out of bounds. Hide rather than crash; the next
        // event will likely succeed.
        setActive(false);
        return;
      }

      // For a multi-line selection, pin the toolbar to the first
      // line's top so it doesn't jump around as the user extends
      // the selection downward. Horizontally center on the start-
      // to-end midpoint of the FIRST line — using endCoords.left
      // when the selection wraps would put the toolbar somewhere
      // strange (left edge of the next line).
      const top = startCoords.top - VERTICAL_GAP;
      const isSingleLine = Math.abs(startCoords.top - endCoords.top) < 4;
      const horizontalAnchor = isSingleLine
        ? (startCoords.left + endCoords.right) / 2
        : startCoords.left + 80;  // arbitrary offset for multi-line

      setPosition({ top, left: horizontalAnchor });
      setActive(true);
    }

    // Subscribe to the events that affect selection or document
    // structure. selectionUpdate covers caret movement and
    // selection extension; transaction covers content edits that
    // might shift positions; focus/blur cover the editor losing
    // focus to e.g. the breadcrumb.
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    editor.on('focus', update);
    editor.on('blur', update);

    // Window scroll/resize: viewport coordinates change, so the
    // toolbar needs to re-anchor. Passive scroll listener — we
    // never call preventDefault.
    window.addEventListener('scroll', update, { passive: true, capture: true });
    window.addEventListener('resize', update);

    update();

    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
      editor.off('focus', update);
      editor.off('blur', update);
      window.removeEventListener('scroll', update, { capture: true });
      window.removeEventListener('resize', update);
    };
  }, [editor]);

  if (!editor || !active || !position) return null;

  // ---- Action handlers ---------------------------------------------------
  // All four use chain().focus().X().run() so the editor regains
  // focus after the click (the button itself stole it). focus()
  // before the toggle ensures the selection is preserved when the
  // mark is applied.

  const toggleBold = () => {
    editor.chain().focus().toggleBold().run();
  };
  const toggleItalic = () => {
    editor.chain().focus().toggleItalic().run();
  };
  const toggleInlineCode = () => {
    editor.chain().focus().toggleCode().run();
  };

  /**
   * Link button. If the selection is already linked, unset the
   * link. Otherwise prompt for a URL and set it. We use
   * window.prompt — same simple-but-effective pattern the slash
   * menu's link command uses elsewhere in this app. A real dialog
   * with a paste-aware URL field is a future polish.
   */
  const handleLink = () => {
    if (editor.isActive('link')) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    // eslint-disable-next-line no-alert
    const href = window.prompt('Link URL:');
    if (href === null) return;        // user cancelled
    const trimmed = href.trim();
    if (trimmed === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().setLink({ href: trimmed }).run();
  };

  // Pre-compute active states so each button can show its
  // pressed/depressed style. Read once per render — cheap.
  const isBold = editor.isActive('bold');
  const isItalic = editor.isActive('italic');
  const isCode = editor.isActive('code');
  const isLink = editor.isActive('link');

  return (
    <div
      className="nc-bubble-menu"
      style={{
        // translateX(-50%) horizontally centers the menu on the
        // anchor point. translateY(-100%) flips it ABOVE the
        // anchor so the bottom edge of the menu sits at the
        // VERTICAL_GAP-offset top of the selection.
        position: 'fixed',
        top: `${position.top}px`,
        left: `${position.left}px`,
        transform: 'translate(-50%, -100%)',
        zIndex: 1000,
      }}
      // Prevent the menu from stealing focus from the editor when
      // the user mouses down on it. Without this, mousedown clears
      // the selection before the click handler runs, so the
      // toggle*() commands act on an empty range.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className={isBold ? 'nc-bubble-button nc-bubble-button-active' : 'nc-bubble-button'}
        onClick={toggleBold}
        title="Bold (Ctrl+B)"
      >
        <strong>B</strong>
      </button>
      <button
        type="button"
        className={isItalic ? 'nc-bubble-button nc-bubble-button-active' : 'nc-bubble-button'}
        onClick={toggleItalic}
        title="Italic (Ctrl+I)"
      >
        <em>I</em>
      </button>
      <button
        type="button"
        className={isCode ? 'nc-bubble-button nc-bubble-button-active' : 'nc-bubble-button'}
        onClick={toggleInlineCode}
        title="Inline code (Ctrl+E)"
      >
        <code>{'<>'}</code>
      </button>
      <button
        type="button"
        className={isLink ? 'nc-bubble-button nc-bubble-button-active' : 'nc-bubble-button'}
        onClick={handleLink}
        title={isLink ? 'Remove link' : 'Add link'}
      >
        🔗
      </button>
    </div>
  );
}
