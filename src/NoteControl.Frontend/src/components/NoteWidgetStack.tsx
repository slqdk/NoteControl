import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import type {
  LinkBlockDto,
  MotionBlockDto,
  NoteWidgetDto,
  RssBlockDto,
  TaskAreaDto,
} from '../api/types';
import { RssBlock } from './RssBlock';
import { TaskArea } from './TaskArea';
import { LinksBlock } from './LinksBlock';
import { MotionBlock } from './MotionBlock';

/**
 * Renders the ordered list of widgets attached to a single note, in
 * the band above the editor (above the note's top rule). This is the
 * note-context counterpart to the dashboard canvas — same widget
 * components, different host.
 *
 * Why the components are reused verbatim:
 *   The four dashboard widgets (RSS, Task, Links, Motion) all take
 *   { block|area, onChange(patch), onDelete }. We mount them exactly
 *   as the dashboard does. The only adaptations are layout-related.
 *
 * Layout adaptation (width):
 *   Each block sets its width/height via INLINE style from its DTO, so
 *   CSS can't size it. To make a widget fill the note column instead of
 *   its dashboard width, each host measures its own content width (a
 *   ResizeObserver) and hands that pixel width down to the block as the
 *   block's width. No overflow, no fixed dashboard width leaking in.
 *
 * Layout adaptation (position):
 *   On the dashboard each block is position:absolute. The CSS switches
 *   the hosted block to position:relative so it FLOWS and the host
 *   auto-fits its height. x/y are forced to 0 and discarded on the way
 *   back, so dragging is inert here.
 *
 * Height (auto-fit + manual override):
 *   The block needs a concrete height for its internal layout (the
 *   Motion chart canvas sizes off it), so the payload `height` is the
 *   block's height and the host wraps it exactly. "Auto-fit by default"
 *   is the seeded per-kind default height. The host renders its OWN
 *   full-width bottom resize handle: dragging rewrites the payload
 *   `height`; double-clicking resets to the kind's default. The block's
 *   own corner handle is hidden in-note (CSS) to avoid a double grip.
 *
 * Persistence is the caller's concern: onChange/onDelete bubble up to
 * the EditorPage-level note-widgets map, which debounce-saves to the
 * server (same plumbing the dashboard uses via useDebouncedSave).
 */

export interface NoteWidgetStackProps {
  vaultId: string;
  widgets: NoteWidgetDto[];
  /** Replace one widget's payload, identified by widget id. */
  onChange: (widgetId: string, patch: Partial<NoteWidgetDto>) => void;
  /** Remove one widget by id. */
  onDelete: (widgetId: string) => void;
}

/** Per-kind default height, used as the auto-fit baseline and the
 *  double-click reset target. Mirrors the insert-time defaults in
 *  util/noteWidgets.ts so a reset returns the widget to how it looked
 *  when added. */
const DEFAULT_HEIGHT: Record<string, number> = {
  rss: 320,
  task: 380,
  links: 320,
  motion: 460,
};

/** Clamp host height to sane bounds so a drag can't collapse a widget
 *  to nothing or balloon it off-screen. */
const HEIGHT_MIN = 120;
const HEIGHT_MAX = 1600;

/** Fallback width used for the very first render, before the host has
 *  been measured. Replaced by the measured width on the next frame. */
const FALLBACK_WIDTH = 640;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** The currently-stored payload for a widget, regardless of kind. */
function payloadOf(w: NoteWidgetDto): { height?: number } | null {
  return w.rss ?? w.task ?? w.links ?? w.motion ?? null;
}

/** The default/reset height for a widget, accounting for Motion-D. */
function defaultHeightFor(w: NoteWidgetDto): number {
  if (w.kind === 'motion' && w.motion?.mode === 'D') return 640;
  return DEFAULT_HEIGHT[w.kind] ?? 320;
}

export function NoteWidgetStack({
  vaultId,
  widgets,
  onChange,
  onDelete,
}: NoteWidgetStackProps) {
  if (widgets.length === 0) return null;

  return (
    <div className="nc-note-widgets">
      {widgets.map((w) => (
        <NoteWidgetItem
          key={w.id}
          vaultId={vaultId}
          widget={w}
          onChange={onChange}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

/**
 * One widget in the stack. Owns the host element, measures its width,
 * builds the kind-appropriate block (with measured width + current
 * height, x/y zeroed), and renders the host resize handle.
 */
function NoteWidgetItem({
  vaultId,
  widget: w,
  onChange,
  onDelete,
}: {
  vaultId: string;
  widget: NoteWidgetDto;
  onChange: (widgetId: string, patch: Partial<NoteWidgetDto>) => void;
  onDelete: (widgetId: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number>(FALLBACK_WIDTH);

  // Measure the host width and keep it in sync as the layout changes
  // (window resize, rail toggles, note-width slider). The block is
  // handed this width as its inline width so it fills the note column.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const apply = () => {
      const wpx = el.clientWidth;
      if (wpx > 0) setMeasuredWidth(wpx);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const payload = payloadOf(w);
  const height = payload?.height ?? defaultHeightFor(w);
  // Block width = measured host width. The host has no padding so the
  // block fills it edge to edge.
  const width = Math.max(1, Math.round(measuredWidth));

  // Patch handlers: strip x/y (no coordinate space in a note) and route
  // the rest onto the widget's payload field.
  const onChangeRss = useCallback(
    (patch: Partial<RssBlockDto>) => {
      const { x: _x, y: _y, ...rest } = patch;
      void _x; void _y;
      onChange(w.id, { rss: rest as RssBlockDto });
    },
    [onChange, w.id],
  );
  const onChangeTask = useCallback(
    (patch: Partial<TaskAreaDto>) => {
      const { x: _x, y: _y, ...rest } = patch;
      void _x; void _y;
      onChange(w.id, { task: rest as TaskAreaDto });
    },
    [onChange, w.id],
  );
  const onChangeLinks = useCallback(
    (patch: Partial<LinkBlockDto>) => {
      const { x: _x, y: _y, ...rest } = patch;
      void _x; void _y;
      onChange(w.id, { links: rest as LinkBlockDto });
    },
    [onChange, w.id],
  );
  const onChangeMotion = useCallback(
    (patch: Partial<MotionBlockDto>) => {
      const { x: _x, y: _y, ...rest } = patch;
      void _x; void _y;
      onChange(w.id, { motion: rest as MotionBlockDto });
    },
    [onChange, w.id],
  );

  // Host resize handle → set the payload height (clamped + rounded).
  const setHeight = useCallback(
    (h: number) => {
      const next = Math.round(clamp(h, HEIGHT_MIN, HEIGHT_MAX));
      if (w.rss) onChange(w.id, { rss: { ...w.rss, height: next } });
      else if (w.task) onChange(w.id, { task: { ...w.task, height: next } });
      else if (w.links) onChange(w.id, { links: { ...w.links, height: next } });
      else if (w.motion) onChange(w.id, { motion: { ...w.motion, height: next } });
    },
    [onChange, w],
  );

  let body: React.ReactNode = null;
  if (w.kind === 'rss' && w.rss) {
    body = (
      <RssBlock
        vaultId={vaultId}
        block={{ ...w.rss, x: 0, y: 0, width, height }}
        onChange={onChangeRss}
        onDelete={() => onDelete(w.id)}
      />
    );
  } else if (w.kind === 'task' && w.task) {
    body = (
      <TaskArea
        area={{ ...w.task, x: 0, y: 0, width, height }}
        onChange={onChangeTask}
        onDelete={() => onDelete(w.id)}
      />
    );
  } else if (w.kind === 'links' && w.links) {
    body = (
      <LinksBlock
        vaultId={vaultId}
        block={{ ...w.links, x: 0, y: 0, width, height }}
        onChange={onChangeLinks}
        onDelete={() => onDelete(w.id)}
      />
    );
  } else if (w.kind === 'motion' && w.motion) {
    body = (
      <MotionBlock
        block={{ ...w.motion, x: 0, y: 0, width, height }}
        onChange={onChangeMotion}
        onDelete={() => onDelete(w.id)}
      />
    );
  } else {
    // Unknown kind / missing payload. Forward-compat: skip silently.
    // Data is preserved on disk (server never drops unknown widgets).
    return null;
  }

  return (
    <div className="nc-note-widget-host" ref={hostRef}>
      {body}
      <ResizeHandle
        heightHint={height}
        onResize={setHeight}
        onReset={() => setHeight(defaultHeightFor(w))}
      />
    </div>
  );
}

/**
 * Full-width bottom resize strip. Captures the pointer, translates
 * vertical drag into a new height against the height at drag-start, and
 * reports it via onResize. Double-click resets to the default.
 */
function ResizeHandle({
  heightHint,
  onResize,
  onReset,
}: {
  heightHint: number;
  onResize: (height: number) => void;
  onReset: () => void;
}) {
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { startY: e.clientY, startH: heightHint };
    },
    [heightHint],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      onResize(d.startH + (e.clientY - d.startY));
    },
    [onResize],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // releasePointerCapture throws if nothing was captured. Ignore.
    }
  }, []);

  return (
    <div
      className="nc-note-widget-resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onReset}
      title="Drag to resize · double-click to reset height"
      aria-label="Resize widget"
    />
  );
}
