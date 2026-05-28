import { useCallback } from 'react';

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
 *   as the dashboard does. The only adaptation is positioning.
 *
 * Positioning adaptation:
 *   On the dashboard each block is position:absolute and reads x/y
 *   from its DTO. In a note we want a vertical stack, not a free
 *   canvas. So each widget gets a position:relative host sized to the
 *   widget's own width/height, and we hand the component a DTO whose
 *   x/y are forced to 0 — the absolute child then pins to the host's
 *   top-left and the host participates in normal block flow. The
 *   widget's drag handler still fires (it writes x/y back through
 *   onChange), but we discard x/y on the way back in, so dragging is
 *   effectively inert here without having to fork the components.
 *   Resize still works and is honoured (it writes width/height, which
 *   we DO keep — the host re-sizes to match).
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

/**
 * Pull the width/height a widget's payload carries, so the relative
 * host can size to match. Defaults are conservative — if a kind has no
 * size (shouldn't happen for the current four), the host falls back to
 * auto height and full width.
 */
function payloadSize(w: NoteWidgetDto): { width?: number; height?: number } {
  const p = w.rss ?? w.task ?? w.links ?? w.motion ?? null;
  if (!p) return {};
  return { width: p.width, height: p.height };
}

export function NoteWidgetStack({
  vaultId,
  widgets,
  onChange,
  onDelete,
}: NoteWidgetStackProps) {
  // Map a payload patch coming out of a child component back onto the
  // NoteWidgetDto. We strip x/y so dragging never persists a position
  // (the note stack has no meaningful coordinate space), but keep
  // width/height so resize sticks.
  const patchRss = useCallback(
    (id: string, patch: Partial<RssBlockDto>) => {
      const { x: _x, y: _y, ...rest } = patch;
      void _x;
      void _y;
      onChange(id, { rss: rest as RssBlockDto });
    },
    [onChange],
  );
  const patchTask = useCallback(
    (id: string, patch: Partial<TaskAreaDto>) => {
      const { x: _x, y: _y, ...rest } = patch;
      void _x;
      void _y;
      onChange(id, { task: rest as TaskAreaDto });
    },
    [onChange],
  );
  const patchLinks = useCallback(
    (id: string, patch: Partial<LinkBlockDto>) => {
      const { x: _x, y: _y, ...rest } = patch;
      void _x;
      void _y;
      onChange(id, { links: rest as LinkBlockDto });
    },
    [onChange],
  );
  const patchMotion = useCallback(
    (id: string, patch: Partial<MotionBlockDto>) => {
      const { x: _x, y: _y, ...rest } = patch;
      void _x;
      void _y;
      onChange(id, { motion: rest as MotionBlockDto });
    },
    [onChange],
  );

  if (widgets.length === 0) return null;

  return (
    <div className="nc-note-widgets">
      {widgets.map((w) => {
        const { width, height } = payloadSize(w);
        // The host is position:relative and sized to the widget; the
        // absolute child (x=0,y=0) fills it. Width caps at 100% so a
        // wide dashboard default doesn't overflow a narrow note column.
        const hostStyle: React.CSSProperties = {
          position: 'relative',
          width: width ? Math.min(width, 100000) : '100%',
          maxWidth: '100%',
          height: height ?? undefined,
        };

        let body: React.ReactNode = null;

        if (w.kind === 'rss' && w.rss) {
          // x/y forced to 0 so the absolute child pins to the host.
          const block: RssBlockDto = { ...w.rss, x: 0, y: 0 };
          body = (
            <RssBlock
              vaultId={vaultId}
              block={block}
              onChange={(patch) => patchRss(w.id, patch)}
              onDelete={() => onDelete(w.id)}
            />
          );
        } else if (w.kind === 'task' && w.task) {
          const area: TaskAreaDto = { ...w.task, x: 0, y: 0 };
          body = (
            <TaskArea
              area={area}
              onChange={(patch) => patchTask(w.id, patch)}
              onDelete={() => onDelete(w.id)}
            />
          );
        } else if (w.kind === 'links' && w.links) {
          const block: LinkBlockDto = { ...w.links, x: 0, y: 0 };
          body = (
            <LinksBlock
              vaultId={vaultId}
              block={block}
              onChange={(patch) => patchLinks(w.id, patch)}
              onDelete={() => onDelete(w.id)}
            />
          );
        } else if (w.kind === 'motion' && w.motion) {
          const block: MotionBlockDto = { ...w.motion, x: 0, y: 0 };
          body = (
            <MotionBlock
              block={block}
              onChange={(patch) => patchMotion(w.id, patch)}
              onDelete={() => onDelete(w.id)}
            />
          );
        } else {
          // Unknown kind, or a payload missing for its declared kind.
          // Forward-compat: skip silently rather than crash. A newer
          // build that wrote a kind this build doesn't know simply
          // doesn't render it; the widget data is preserved on disk
          // because we never drop unknown widgets from the map.
          return null;
        }

        return (
          <div key={w.id} className="nc-note-widget-host" style={hostStyle}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
