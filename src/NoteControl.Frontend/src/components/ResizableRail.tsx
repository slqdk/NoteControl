import { useCallback, useEffect, useRef, type ReactNode } from 'react';

/**
 * A fixed-width container with a draggable resize handle.
 *
 * - For a left rail (tree), put the handle on the right edge.
 * - For a right rail (properties), put the handle on the left edge.
 *
 * The rail itself doesn't own its width state — it lifts to the parent
 * via onWidthChange so the layout can persist + apply min/max
 * constraints centrally. The drag handler computes a new desired width
 * and the parent decides whether to accept it.
 *
 * Drag mechanics:
 *   1. On mousedown of the handle, start dragging.
 *   2. On mousemove, compute new width from clientX delta vs the rail's
 *      starting bounds. Throttled by requestAnimationFrame so we don't
 *      thrash React state on every pixel.
 *   3. On mouseup, stop dragging.
 *
 * We deliberately use `pointer-events: none` on the document body
 * during drag (via a CSS class) so iframes / interactive children
 * don't swallow the mousemove. Same trick VS Code uses.
 */
export interface ResizableRailProps {
  side: 'left' | 'right';
  width: number;
  onWidthChange: (px: number) => void;
  children: ReactNode;
  /** Optional CSS class on the rail container. */
  className?: string;
}

export function ResizableRail({
  side,
  width,
  onWidthChange,
  children,
  className,
}: ResizableRailProps) {
  const dragStateRef = useRef<{
    startX: number;
    startWidth: number;
    rafId: number | null;
    pending: number | null;
  } | null>(null);

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const ds = dragStateRef.current;
      if (!ds) return;

      // For a left rail, dragging the handle to the right (positive
      // delta) makes the rail wider. For a right rail, dragging the
      // handle to the left (negative delta) makes it wider.
      const rawDelta = e.clientX - ds.startX;
      const delta = side === 'left' ? rawDelta : -rawDelta;
      const desired = ds.startWidth + delta;

      // Throttle to one update per animation frame — mouse events fire
      // way faster than React can usefully render at, so coalesce.
      ds.pending = desired;
      if (ds.rafId === null) {
        ds.rafId = requestAnimationFrame(() => {
          if (dragStateRef.current && dragStateRef.current.pending !== null) {
            onWidthChange(dragStateRef.current.pending);
          }
          if (dragStateRef.current) {
            dragStateRef.current.rafId = null;
            dragStateRef.current.pending = null;
          }
        });
      }
    },
    [onWidthChange, side],
  );

  const stopDrag = useCallback(() => {
    const ds = dragStateRef.current;
    if (ds?.rafId !== null && ds?.rafId !== undefined) {
      cancelAnimationFrame(ds.rafId);
    }
    dragStateRef.current = null;
    document.body.classList.remove('nc-dragging');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', stopDrag);
  }, [onMouseMove]);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragStateRef.current = {
        startX: e.clientX,
        startWidth: width,
        rafId: null,
        pending: null,
      };
      document.body.classList.add('nc-dragging');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', stopDrag);
    },
    [width, onMouseMove, stopDrag],
  );

  // Defensive cleanup if we unmount mid-drag.
  useEffect(() => {
    return () => {
      if (dragStateRef.current) {
        stopDrag();
      }
    };
  }, [stopDrag]);

  return (
    <div
      className={`nc-rail nc-rail-${side} ${className ?? ''}`.trim()}
      style={{ width }}
    >
      {side === 'right' && (
        <div
          className="nc-rail-handle nc-rail-handle-left"
          onMouseDown={startDrag}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
        />
      )}
      <div className="nc-rail-content">{children}</div>
      {side === 'left' && (
        <div
          className="nc-rail-handle nc-rail-handle-right"
          onMouseDown={startDrag}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
        />
      )}
    </div>
  );
}
