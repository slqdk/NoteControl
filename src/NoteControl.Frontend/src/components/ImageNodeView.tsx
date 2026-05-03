import { useEffect, useRef, useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

/**
 * NodeView for an image with controls:
 *   - Click the image → it's "selected" (shows toolbar + resize handles)
 *   - Click outside → deselected
 *   - Drag a corner handle → resize (preserves aspect ratio)
 *   - Toolbar buttons: border on/off, add paragraph below, delete
 *
 * This replaces the in-place mousedown defang from the parent
 * editor. The node view's own click handling takes over because
 * NodeViewWrapper stops the click event before it bubbles to the
 * editor's outer DOM.
 */
export function ImageNodeView({
  node,
  updateAttributes,
  deleteNode,
  selected,
  editor,
  getPos,
}: NodeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Local "this image is the focused one" — distinct from TipTap's
  // `selected` prop, which only flips when there's a NodeSelection.
  // Using a click-outside listener gives us a more conventional
  // "click to select / click outside to deselect" behaviour.
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!active) return;
    function onDocClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setActive(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [active]);

  /**
   * Keyboard delete: Delete or Backspace while the image is active
   * removes it. Restores the familiar "click image, press Del" UX
   * that earlier fixes broke. We only handle these two keys; any
   * other keystroke falls through and typing inserts text adjacent
   * to the image (the cursor lands wherever the user's last text
   * selection was).
   */
  useEffect(() => {
    if (!active) return;
    function onDocKey(e: KeyboardEvent) {
      // Don't steal the keystroke if focus is in an input/textarea
      // somewhere else on the page (e.g. the Properties panel or
      // the search box).
      const target = e.target as HTMLElement | null;
      const isInTextField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable && !containerRef.current?.contains(target));
      if (isInTextField) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteNode();
        setActive(false);
      } else if (e.key === 'Escape') {
        setActive(false);
      }
    }
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, [active, deleteNode]);

  /**
   * Drag-resize. We only listen on the bottom-right corner handle
   * (most common pattern). On mousedown we snapshot the starting
   * width and pointer X, then while dragging compute new width =
   * start + (currentX - startX). Aspect ratio is preserved by
   * letting `height: auto` (already in the renderHTML style) pick
   * up the height naturally.
   */
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const img = imgRef.current;
    if (!img) return;

    const startX = e.clientX;
    const startWidth = img.getBoundingClientRect().width;

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      // Minimum 40 px so users don't accidentally make an image
      // unreachable. Maximum is the editor width — but we don't
      // enforce that here, the layout will clamp via max-width.
      const next = Math.max(40, Math.round(startWidth + dx));
      updateAttributes({ width: next });
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  /**
   * Insert an empty paragraph immediately after this image so the
   * user can press Enter / type a new line. Triggered by the ↵
   * button in the toolbar AND by the click defang on the image
   * itself when the next sibling isn't an empty paragraph.
   */
  function addParagraphBelow() {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    const after = pos + node.nodeSize;
    editor
      .chain()
      .focus()
      .insertContentAt(after, { type: 'paragraph' })
      .setTextSelection(after + 1)
      .run();
    setActive(false);
  }

  function toggleBorder() {
    updateAttributes({ border: !node.attrs.border });
  }

  function handleDelete() {
    deleteNode();
  }

  /**
   * Click-on-image: just activate. We DON'T create a NodeSelection
   * (which is what was making images vanish on next keystroke).
   * The user gets visual feedback via the active state and can
   * still type elsewhere — they just can't accidentally delete
   * the image with backspace alone.
   */
  function handleImageClick(e: React.MouseEvent) {
    e.stopPropagation();
    setActive(true);
  }

  // Width style applied inline (rather than relying on renderHTML)
  // so resize feels live during the drag.
  const widthStyle = node.attrs.width
    ? { width: `${node.attrs.width}px`, height: 'auto' as const }
    : undefined;

  const showControls = active || selected;

  return (
    <NodeViewWrapper
      className="nc-img-wrap"
      ref={containerRef}
      data-active={showControls ? 'true' : 'false'}
    >
      <img
        ref={imgRef}
        src={node.attrs.src ?? ''}
        alt={node.attrs.alt ?? ''}
        title={node.attrs.title ?? ''}
        className={node.attrs.border ? 'nc-img-bordered' : undefined}
        style={widthStyle}
        onClick={handleImageClick}
        draggable={false}
      />

      {showControls && (
        <>
          {/* Resize handle: bottom-right corner */}
          <span
            className="nc-img-resize-handle nc-img-resize-br"
            onMouseDown={startResize}
            role="separator"
            aria-label="Resize"
          />

          {/* Floating toolbar */}
          <div className="nc-img-toolbar" onMouseDown={(e) => e.preventDefault()}>
            <button
              type="button"
              className={
                node.attrs.border
                  ? 'nc-img-toolbar-btn nc-img-toolbar-btn-active'
                  : 'nc-img-toolbar-btn'
              }
              title="Toggle border"
              onClick={toggleBorder}
            >
              ▢
            </button>
            <button
              type="button"
              className="nc-img-toolbar-btn"
              title="Add paragraph below"
              onClick={addParagraphBelow}
            >
              ↵
            </button>
            <button
              type="button"
              className="nc-img-toolbar-btn nc-img-toolbar-btn-danger"
              title="Delete image"
              onClick={handleDelete}
            >
              ×
            </button>
          </div>
        </>
      )}
    </NodeViewWrapper>
  );
}
