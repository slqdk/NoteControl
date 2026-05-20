import { useEffect, useRef, useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import katex from 'katex';

import { MathEditPopover } from './MathEditPopover';

/**
 * Renders a math (LaTeX) node — inline or block — via KaTeX and
 * exposes click-to-edit through MathEditPopover.
 *
 * KaTeX renders LaTeX source to HTML synchronously (no async font
 * loading hand-shake required at the API layer — fonts are normal
 * stylesheet @font-face declarations that the browser resolves
 * lazily). On invalid source KaTeX renders the source text in red
 * by default; we leave that behaviour in place because:
 *
 *   - the user sees instantly that their LaTeX has a syntax error,
 *   - the offending source isn't lost (it sits in the .latex attr
 *     either way; the red rendering is purely visual).
 *
 * Output mode:
 *   - inline math: KaTeX displayMode=false; sits in a <span> so
 *     surrounding text flows around it.
 *   - block math:  KaTeX displayMode=true; sits in a centred <div>.
 *
 * Click → opens the edit popover anchored at the node's bounding
 * rect. The popover handles its own outside-click + Escape close.
 * On commit, we run the editor's updateMathLatex command.
 *
 * --- Why the popover anchor uses getBoundingClientRect not the
 *     event coordinates ---
 *
 * Event coordinates would jump if the user mis-clicks the
 * rendered KaTeX glyphs (each KaTeX letter is its own span; a
 * click on a glyph's rect, not the math container's rect, would
 * anchor the popover next to that glyph). Using the wrapper's
 * rect anchors consistently to the same spot regardless of
 * where in the math the user clicked.
 */
export function MathNodeView({
  node,
  updateAttributes,
  editor,
  selected,
  deleteNode,
}: NodeViewProps) {
  const isBlock = node.type.name === 'mathBlock';
  const latex = (node.attrs.latex as string) ?? '';

  const containerRef = useRef<HTMLSpanElement | HTMLDivElement | null>(null);
  const [popoverAnchor, setPopoverAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // --- Auto-open popover when this node is freshly inserted -------
  //
  // Slash menu / bubble menu / Ctrl+Shift+M insertion paths create
  // a math node with an empty `latex` attr; the user expects the
  // editor to pop open immediately so they can type the source.
  // We detect "freshly inserted" by checking on first mount: if
  // latex is empty, open the popover anchored on this node's
  // bounding rect.
  //
  // We deliberately don't trigger on every latex==='' render —
  // only the initial mount — because users can re-edit a math
  // node and then commit-with-empty (which calls deleteNode in
  // the commit handler), and we don't want a deletion path that
  // first re-opens the popover.
  useEffect(() => {
    if (!editor.isEditable) return;
    if (latex !== '') return;
    // Defer by one frame so the wrapper element is mounted and
    // has a measurable bounding rect.
    const id = window.requestAnimationFrame(() => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPopoverAnchor({
        x: rect.left,
        y: isBlock ? rect.bottom + 4 : rect.top - 4,
      });
    });
    return () => window.cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);     // mount only

  // --- KaTeX rendering --------------------------------------------
  //
  // KaTeX writes to an existing element via katex.render. We
  // re-run on every change to `latex` so live edits from the
  // popover reflect immediately. The render target is a child
  // span/div inside the wrapper so we can keep React-managed
  // chrome (edit affordance) separate from KaTeX-managed HTML.
  const renderTargetRef = useRef<HTMLSpanElement | HTMLDivElement | null>(null);

  useEffect(() => {
    const target = renderTargetRef.current;
    if (!target) return;
    // Empty source: show a tiny placeholder so users can still
    // click the node to open the editor. An empty rendered
    // KaTeX area has zero width and is unclickable.
    if (latex.trim() === '') {
      target.textContent = isBlock ? '∅ (empty block math)' : '∅';
      return;
    }
    try {
      katex.render(latex, target as HTMLElement, {
        displayMode: isBlock,
        throwOnError: false,
        output: 'html',
        // strict:false lets a few common LaTeX-isms slide that
        // KaTeX would otherwise warn about (mathit on
        // multi-letter spans, etc.). Errors still render in red
        // via throwOnError:false → KaTeX's built-in red-text
        // fallback for unknown commands.
        strict: false,
        // Trust nothing — KaTeX disallows \href, \includegraphics,
        // \url etc. by default with trust:false (the default), and
        // we leave that alone. We don't want clipboard LaTeX to
        // sneak in clickable links.
        trust: false,
      });
    } catch (err) {
      // throwOnError:false should make this unreachable, but
      // belt-and-braces: render the source verbatim if KaTeX
      // somehow throws.
      target.textContent = `[math error] ${latex}`;
    }
  }, [latex, isBlock]);

  // --- Click → open popover ---------------------------------------
  //
  // Mouse down on the wrapper anchors the popover and selects the
  // node. We anchor at the wrapper's bottom-left for block math
  // (popover hangs below the math) and top-left for inline math
  // (popover overlaps slightly above to avoid covering surrounding
  // text). The popover clamps itself to viewport.
  const handleOpenEditor = (e: React.MouseEvent) => {
    if (!editor.isEditable) return;     // locked notes: no edit popover
    e.preventDefault();
    e.stopPropagation();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPopoverAnchor({
      x: rect.left,
      y: isBlock ? rect.bottom + 4 : rect.top - 4,
    });
  };

  const handleClosePopover = () => setPopoverAnchor(null);

  const handleCommit = (newLatex: string) => {
    const trimmed = newLatex.trim();
    if (trimmed === '') {
      // Empty commit: delete the whole node (saves us from leaving
      // an unclickable invisible empty math node behind).
      deleteNode();
      setPopoverAnchor(null);
      return;
    }
    updateAttributes({ latex: newLatex });
    setPopoverAnchor(null);
  };

  // --- Selected highlight -----------------------------------------
  //
  // When the user clicks the math node, ProseMirror sets a
  // NodeSelection that flips `selected` to true. We use that to
  // give a visual outline so the user knows the node is targeted
  // (delete key removes it, etc.).
  const selectedClass = selected ? ' nc-math-selected' : '';

  if (isBlock) {
    return (
      <NodeViewWrapper
        as="div"
        className={`nc-math-block${selectedClass}`}
        data-math-block={latex}
      >
        <div
          ref={containerRef as React.RefObject<HTMLDivElement>}
          className="nc-math-block-content"
          contentEditable={false}
          onMouseDown={handleOpenEditor}
          role="button"
          tabIndex={0}
          aria-label="Edit math (block)"
          title="Click to edit math"
        >
          <div
            ref={renderTargetRef as React.RefObject<HTMLDivElement>}
            className="nc-math-render"
          />
        </div>
        {popoverAnchor && (
          <MathEditPopover
            x={popoverAnchor.x}
            y={popoverAnchor.y}
            initialLatex={latex}
            isBlock
            onCommit={handleCommit}
            onClose={handleClosePopover}
          />
        )}
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as="span"
      className={`nc-math-inline${selectedClass}`}
      data-math-inline={latex}
    >
      <span
        ref={containerRef as React.RefObject<HTMLSpanElement>}
        className="nc-math-inline-content"
        contentEditable={false}
        onMouseDown={handleOpenEditor}
        role="button"
        tabIndex={0}
        aria-label="Edit math (inline)"
        title="Click to edit math"
      >
        <span
          ref={renderTargetRef as React.RefObject<HTMLSpanElement>}
          className="nc-math-render"
        />
      </span>
      {popoverAnchor && (
        <MathEditPopover
          x={popoverAnchor.x}
          y={popoverAnchor.y}
          initialLatex={latex}
          isBlock={false}
          onCommit={handleCommit}
          onClose={handleClosePopover}
        />
      )}
    </NodeViewWrapper>
  );
}
