import { useEffect, useRef, useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import type React from 'react';

/**
 * NodeView for video blocks.
 *
 * Same activate-on-click + click-outside-to-deactivate pattern as
 * ImageNodeView, with these differences:
 *
 *   - Resize handle is in the TOP-RIGHT corner, not bottom-right.
 *     The browser's native <video controls> chrome lives at the
 *     bottom of the video; a resize handle there would overlap
 *     with the play/scrub bar.
 *
 *   - No border-toggle button. Videos are always self-contained
 *     rectangles; a border around them looks like window-chrome
 *     noise rather than emphasis.
 *
 *   - Click on the video does NOT activate. We use a separate
 *     small "click frame" overlay around the video; clicking on
 *     the video itself goes to the browser's playback controls.
 *     Clicking on the surrounding frame activates our resize/
 *     delete UI.
 *
 * The src attribute on the rendered <video> is whatever the
 * markdown serializer wrote — typically a vault-relative path like
 * "Plan.assets/clip.mp4". The MutationObserver in NoteEditor
 * (already used for images) rewrites both `<img src>` and
 * `<video src>` so the player loads from the asset endpoint.
 */
export function VideoNodeView({
  node,
  updateAttributes,
  deleteNode,
  selected,
  editor,
  getPos,
}: NodeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [active, setActive] = useState(false);

  // Click-outside deactivates. We listen on mousedown so the close
  // happens before any clicks on the editor body trigger their own
  // selection changes.
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

  // Delete / Backspace removes an active video. Same UX as images.
  useEffect(() => {
    if (!active) return;
    function onDocKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const inField =
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable);
      if (inField) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteNode();
      } else if (e.key === 'Escape') {
        setActive(false);
      }
    }
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, [active, deleteNode]);

  /**
   * Drag-resize from the top-right corner. Same math as the image
   * resize: capture starting width and pointer X, update on
   * mousemove. Aspect ratio preserved via height: auto.
   *
   * We use the top-right (rather than bottom-right like images)
   * because the browser's video control bar lives at the bottom
   * of the video and a handle down there would conflict with the
   * play/scrub buttons.
   */
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const v = videoRef.current;
    if (!v) return;

    const startX = e.clientX;
    const startWidth = v.getBoundingClientRect().width;

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const next = Math.max(80, Math.round(startWidth + dx));
      updateAttributes({ width: next });
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

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

  function handleDelete() {
    deleteNode();
  }

  /**
   * Activate when the user clicks the FRAME (the wrapper area
   * outside the video element itself). Clicks inside the video
   * fall through to the browser's playback controls.
   */
  function handleFrameClick(e: React.MouseEvent) {
    // Only activate if the click was actually on the frame, not on
    // the video element. We compare via the event's target.
    if (e.target === containerRef.current) {
      setActive(true);
    }
  }

  const widthStyle = node.attrs.width
    ? ({ width: `${node.attrs.width}px`, height: 'auto' } as const)
    : undefined;

  const showControls = active || selected;

  return (
    <NodeViewWrapper
      className="nc-video-wrap"
      ref={containerRef}
      data-active={showControls ? 'true' : 'false'}
      onClick={handleFrameClick}
    >
      <video
        ref={videoRef}
        src={node.attrs.src ?? ''}
        controls
        preload="metadata"
        style={widthStyle}
        // Stop the activate-on-frame-click from triggering when
        // the click lands on the video itself (so play/pause works).
        onClick={(e) => e.stopPropagation()}
        // Allow the video to be a drag handle for moving the node
        // around the document via TipTap's draggable behaviour.
        // The wrapper handles the actual drag.
      />

      {showControls && (
        <>
          {/* Resize handle: top-right corner (avoids browser's
              bottom control bar). */}
          <span
            className="nc-video-resize-handle"
            onMouseDown={startResize}
            role="separator"
            aria-label="Resize"
          />

          {/* Floating toolbar above the video. */}
          <div className="nc-video-toolbar" onMouseDown={(e) => e.preventDefault()}>
            <button
              type="button"
              className="nc-video-toolbar-btn"
              title="Add paragraph below"
              onClick={addParagraphBelow}
            >
              ↵
            </button>
            <button
              type="button"
              className="nc-video-toolbar-btn nc-video-toolbar-btn-danger"
              title="Delete video"
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
