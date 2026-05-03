import { useCallback, useEffect, useRef, useState } from 'react';

import type { StickyNoteDto, TaskAreaDto } from '../api/types';
import { StickyNote } from './StickyNote';

/**
 * One free-floating task area on the startpage (step 42).
 *
 * Mirrors RssBlock's drag/resize plumbing — header drags, bottom-
 * right corner resizes, all gestures use Pointer Events with
 * pointer-capture so the container tracks the cursor smoothly even
 * if the cursor leaves the element mid-gesture. Final values are
 * committed to the parent on pointerup so the debounced save only
 * sees one update per gesture.
 *
 * What's different from RssBlock:
 *   - No external data fetch. The area is purely local content.
 *   - Body holds a vertical list of <StickyNote /> children with
 *     drag-to-reorder.
 *   - Header has an inline-editable title (single text input).
 *   - "+ Add note" button at the top of the body adds a new
 *     yellow-default sticky.
 *   - Gear icon on the header opens a tiny popup with one action:
 *     delete the whole area (with confirm).
 *
 * Note reordering: HTML5 drag-and-drop with native dataTransfer.
 * Each note has draggable=true; on drop on another note we splice
 * the dragged note out of its old index and insert at the drop
 * target. Pointer events would be more consistent with the area's
 * own drag semantics, but reordering specifically is the one place
 * where HTML5 DnD shines (no manual hit-testing — the browser tells
 * us where the drop landed).
 */

const BOUNDS = {
  WIDTH_MIN: 220,
  WIDTH_MAX: 800,
  HEIGHT_MIN: 180,
  HEIGHT_MAX: 1200,
  X_MIN: 0,
  Y_MIN: 0,
};

export interface TaskAreaProps {
  area: TaskAreaDto;
  onChange: (patch: Partial<TaskAreaDto>) => void;
  onDelete: () => void;
}

export function TaskArea({ area, onChange, onDelete }: TaskAreaProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Click-outside / Escape to close the gear menu.
  useEffect(() => {
    if (!menuOpen) return;
    function onDocDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // ----- header drag (move) -----
  const [dragOverride, setDragOverride] =
    useState<{ x: number; y: number } | null>(null);
  const dragOriginRef = useRef<{
    pointerX: number;
    pointerY: number;
    startX: number;
    startY: number;
  } | null>(null);

  const onHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Don't start a drag if the user clicked an interactive bit
    // of the header (the inline title input, the gear, the
    // popup). data-no-drag opts out, like RssBlock.
    if (target.closest('button, input, textarea, a, [data-no-drag]')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragOriginRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      startX: area.x,
      startY: area.y,
    };
    setDragOverride({ x: area.x, y: area.y });
  }, [area.x, area.y]);

  const onHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    const o = dragOriginRef.current;
    if (!o) return;
    const dx = e.clientX - o.pointerX;
    const dy = e.clientY - o.pointerY;
    setDragOverride({
      x: Math.max(BOUNDS.X_MIN, o.startX + dx),
      y: Math.max(BOUNDS.Y_MIN, o.startY + dy),
    });
  }, []);

  const onHeaderPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragOriginRef.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const final = dragOverride;
    dragOriginRef.current = null;
    setDragOverride(null);
    if (final && (final.x !== area.x || final.y !== area.y)) {
      onChange({ x: final.x, y: final.y });
    }
  }, [area.x, area.y, dragOverride, onChange]);

  // ----- corner resize -----
  const [resizeOverride, setResizeOverride] =
    useState<{ width: number; height: number } | null>(null);
  const resizeOriginRef = useRef<{
    pointerX: number;
    pointerY: number;
    startW: number;
    startH: number;
  } | null>(null);

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeOriginRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      startW: area.width,
      startH: area.height,
    };
    setResizeOverride({ width: area.width, height: area.height });
  }, [area.width, area.height]);

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    const o = resizeOriginRef.current;
    if (!o) return;
    const dw = e.clientX - o.pointerX;
    const dh = e.clientY - o.pointerY;
    setResizeOverride({
      width: clamp(o.startW + dw, BOUNDS.WIDTH_MIN, BOUNDS.WIDTH_MAX),
      height: clamp(o.startH + dh, BOUNDS.HEIGHT_MIN, BOUNDS.HEIGHT_MAX),
    });
  }, []);

  const onResizePointerUp = useCallback((e: React.PointerEvent) => {
    if (!resizeOriginRef.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const final = resizeOverride;
    resizeOriginRef.current = null;
    setResizeOverride(null);
    if (final && (final.width !== area.width || final.height !== area.height)) {
      onChange({ width: final.width, height: final.height });
    }
  }, [area.width, area.height, resizeOverride, onChange]);

  // ----- effective position/size -----
  const effX = dragOverride?.x ?? area.x;
  const effY = dragOverride?.y ?? area.y;
  const effW = resizeOverride?.width ?? area.width;
  const effH = resizeOverride?.height ?? area.height;

  // ----- note operations -----

  const updateNote = useCallback(
    (id: string, patch: Partial<StickyNoteDto>) => {
      onChange({
        notes: area.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
      });
    },
    [area.notes, onChange],
  );

  const deleteNote = useCallback(
    (id: string) => {
      onChange({ notes: area.notes.filter((n) => n.id !== id) });
    },
    [area.notes, onChange],
  );

  const addNote = useCallback(() => {
    const newNote: StickyNoteDto = {
      id: crypto.randomUUID(),
      headline: '',
      content: '',
      color: 'yellow',
      done: false,
    };
    onChange({ notes: [...area.notes, newNote] });
  }, [area.notes, onChange]);

  // ----- note reordering -----
  // HTML5 drag-and-drop. The note's wrapper is draggable; on drop
  // on another note's wrapper we splice the dragged note into the
  // target's index. We track id, not index, so React's keyed
  // diffing doesn't desync from our ref data when the user starts
  // a drag, then quickly toggles a note's done state via keyboard.
  const [draggedNoteId, setDraggedNoteId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const onNoteDragStart = useCallback((id: string) => {
    setDraggedNoteId(id);
  }, []);

  const onNoteDragEnd = useCallback(() => {
    setDraggedNoteId(null);
    setDropTargetId(null);
  }, []);

  const onNoteDragOverNote = useCallback((overId: string) => {
    if (draggedNoteId && overId !== draggedNoteId) {
      setDropTargetId(overId);
    }
  }, [draggedNoteId]);

  const onNoteDropOnNote = useCallback((targetId: string) => {
    if (!draggedNoteId || draggedNoteId === targetId) {
      setDraggedNoteId(null);
      setDropTargetId(null);
      return;
    }
    const fromIdx = area.notes.findIndex((n) => n.id === draggedNoteId);
    const toIdx = area.notes.findIndex((n) => n.id === targetId);
    if (fromIdx === -1 || toIdx === -1) {
      setDraggedNoteId(null);
      setDropTargetId(null);
      return;
    }
    const reordered = [...area.notes];
    const [moved] = reordered.splice(fromIdx, 1);
    // Insert at the target's CURRENT index, adjusted for the
    // splice. If we removed an item BEFORE the target, the
    // target's index shifted down by one; reuse that to compute
    // where the dragged item should land. Net effect: the dragged
    // note takes the visual position where the target used to be.
    const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
    reordered.splice(insertAt, 0, moved);
    onChange({ notes: reordered });
    setDraggedNoteId(null);
    setDropTargetId(null);
  }, [area.notes, draggedNoteId, onChange]);

  // Title placeholder when empty.
  const displayTitlePlaceholder = '(untitled task area)';

  return (
    <div
      className="nc-task-area"
      style={{
        left: effX,
        top: effY,
        width: effW,
        height: effH,
      }}
    >
      <div
        className="nc-task-area-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        {/*
          Title is inline-editable. Drag-to-move is initiated on
          the header BACKGROUND; the input itself opts out of drag
          via the [data-no-drag] check in onHeaderPointerDown so
          the user can select / type without the area following
          their mouse.
        */}
        <input
          type="text"
          className="nc-task-area-title-input"
          value={area.title}
          placeholder={displayTitlePlaceholder}
          onChange={(e) => onChange({ title: e.target.value })}
          data-no-drag="true"
          aria-label="Task area title"
        />
        <span className="nc-task-area-actions" data-no-drag="true">
          <button
            type="button"
            className="nc-rss-block-iconbtn"
            onClick={() => setMenuOpen((v) => !v)}
            title="Task area options"
            aria-label="Task area options"
            aria-expanded={menuOpen}
          >
            ⚙
          </button>
        </span>
        {menuOpen && (
          <div
            ref={menuRef}
            className="nc-task-area-menu"
            data-no-drag="true"
            role="menu"
          >
            <button
              type="button"
              className="nc-btn nc-btn-danger"
              onClick={() => {
                // eslint-disable-next-line no-alert
                if (window.confirm(
                  'Delete this task area and all its notes? This cannot be undone.',
                )) {
                  setMenuOpen(false);
                  onDelete();
                }
              }}
            >
              🗑 Delete area
            </button>
          </div>
        )}
      </div>

      <div className="nc-task-area-body">
        <button
          type="button"
          className="nc-btn nc-task-area-add-note"
          onClick={addNote}
          title="Add a sticky note to this area"
        >
          + Add note
        </button>

        {area.notes.length === 0 ? (
          <p className="nc-empty nc-task-area-empty">
            No notes yet. Click + Add note above.
          </p>
        ) : (
          <ul className="nc-task-area-notes">
            {area.notes.map((note) => (
              <li
                key={note.id}
                className={[
                  'nc-task-area-note-row',
                  draggedNoteId === note.id ? 'nc-task-area-note-row-dragging' : '',
                  dropTargetId === note.id ? 'nc-task-area-note-row-dropover' : '',
                ].filter(Boolean).join(' ')}
                draggable
                onDragStart={(e) => {
                  // Required by Firefox: dataTransfer must have
                  // SOMETHING set or the drag won't initiate.
                  e.dataTransfer.setData('text/plain', note.id);
                  e.dataTransfer.effectAllowed = 'move';
                  onNoteDragStart(note.id);
                }}
                onDragEnd={onNoteDragEnd}
                onDragEnter={() => onNoteDragOverNote(note.id)}
                onDragOver={(e) => {
                  // preventDefault is required to receive the drop.
                  if (draggedNoteId) e.preventDefault();
                  onNoteDragOverNote(note.id);
                }}
                onDragLeave={(e) => {
                  // Only clear if leaving for outside the row.
                  // dragleave fires when crossing internal element
                  // boundaries too; the contains-check filters those.
                  const related = e.relatedTarget as Node | null;
                  const current = e.currentTarget as Node;
                  if (related && current.contains(related)) return;
                  if (dropTargetId === note.id) setDropTargetId(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  onNoteDropOnNote(note.id);
                }}
              >
                <StickyNote
                  note={note}
                  onChange={(patch) => updateNote(note.id, patch)}
                  onDelete={() => deleteNote(note.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div
        className="nc-rss-block-resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        title="Drag to resize"
        aria-label="Resize task area"
      />
    </div>
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
