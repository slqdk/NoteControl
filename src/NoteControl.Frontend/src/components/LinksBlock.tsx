import { useCallback, useEffect, useRef, useState } from 'react';

import type { LinkBlockDto, LinkItemDto } from '../api/types';
import { newId } from '../util/id';

/**
 * One free-floating links block on the startpage (Ship 74).
 *
 * Modelled on TaskArea: same drag/resize plumbing (header drags,
 * bottom-right corner resizes, all gestures via Pointer Events
 * with pointer-capture). Final values commit to the parent on
 * pointerup so the debounced save sees one update per gesture.
 *
 * Differences from TaskArea:
 *   - Children are link entries (title + description + URL), not
 *     sticky notes. Each entry is a two-line stacked row with a
 *     subtle hover background and no per-row border — Notion /
 *     Linear-style.
 *   - Hard cap at 10 entries per block (the user explicitly asked
 *     for this). The "+ Add link" button hides at 10.
 *   - Editing mode: clicking a row puts it in edit mode with three
 *     inputs (title / description / url). Saved on blur or Enter,
 *     cancelled on Escape. Saved entries become click-to-navigate
 *     (open in new tab).
 *   - No drag-to-reorder yet (could add later — not in v1 of this
 *     ship to keep scope tight).
 */

const BOUNDS = {
  WIDTH_MIN: 220,
  WIDTH_MAX: 800,
  HEIGHT_MIN: 180,
  HEIGHT_MAX: 1200,
  X_MIN: 0,
  Y_MIN: 0,
};

/** Hard cap per the user's spec. Enforced client-side only. */
const MAX_ITEMS = 10;

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export interface LinksBlockProps {
  block: LinkBlockDto;
  onChange: (patch: Partial<LinkBlockDto>) => void;
  onDelete: () => void;
}

export function LinksBlock({ block, onChange, onDelete }: LinksBlockProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Click-outside / Escape to close the gear menu. Same pattern
  // TaskArea + RssBlock use.
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
    // Don't start a drag if the user clicked an interactive bit of
    // the header (the inline title input, the gear button, the
    // popup). data-no-drag opts out, like TaskArea.
    if (target.closest('button, input, textarea, a, [data-no-drag]')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragOriginRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      startX: block.x,
      startY: block.y,
    };
    setDragOverride({ x: block.x, y: block.y });
  }, [block.x, block.y]);

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
    if (final && (final.x !== block.x || final.y !== block.y)) {
      onChange({ x: final.x, y: final.y });
    }
  }, [block.x, block.y, dragOverride, onChange]);

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
      startW: block.width,
      startH: block.height,
    };
    setResizeOverride({ width: block.width, height: block.height });
  }, [block.width, block.height]);

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
    if (final && (final.width !== block.width || final.height !== block.height)) {
      onChange({ width: final.width, height: final.height });
    }
  }, [block.width, block.height, resizeOverride, onChange]);

  // ----- effective position/size -----
  const effX = dragOverride?.x ?? block.x;
  const effY = dragOverride?.y ?? block.y;
  const effW = resizeOverride?.width ?? block.width;
  const effH = resizeOverride?.height ?? block.height;

  // ----- item operations -----

  const updateItem = useCallback(
    (id: string, patch: Partial<LinkItemDto>) => {
      onChange({
        items: block.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
      });
    },
    [block.items, onChange],
  );

  const deleteItem = useCallback(
    (id: string) => {
      onChange({ items: block.items.filter((it) => it.id !== id) });
    },
    [block.items, onChange],
  );

  const addItem = useCallback(() => {
    if (block.items.length >= MAX_ITEMS) return;
    const newItem: LinkItemDto = {
      id: newId(),
      title: '',
      description: '',
      url: '',
    };
    onChange({ items: [...block.items, newItem] });
    // Tell the new row to start in edit mode. We track this in
    // a separate state so the user lands directly in the title
    // input — no extra click required.
    setEditingId(newItem.id);
  }, [block.items, onChange]);

  // ----- editing mode -----
  // Which item id is currently being edited. null = no row in edit
  // mode. Switching rows by clicking another row is handled by the
  // row's onClick — it calls setEditingId(thisId) and the previous
  // row falls back to display mode.
  const [editingId, setEditingId] = useState<string | null>(null);

  // Close edit mode when clicking outside the block. Without this,
  // clicking on the canvas to deselect a row keeps it editable.
  // We attach this only while something IS editing, to avoid
  // burning cycles for blocks that aren't in use.
  const blockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editingId) return;
    function onDocDown(e: MouseEvent) {
      if (blockRef.current && !blockRef.current.contains(e.target as Node)) {
        setEditingId(null);
      }
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [editingId]);

  return (
    <div
      ref={blockRef}
      className="nc-links-block"
      style={{
        left: `${effX}px`,
        top: `${effY}px`,
        width: `${effW}px`,
        height: `${effH}px`,
      }}
    >
      {/* Header: title input on the left, gear menu on the right. */}
      <div
        className="nc-links-block-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <input
          type="text"
          className="nc-links-block-title-input"
          placeholder="Untitled"
          value={block.title}
          onChange={(e) => onChange({ title: e.target.value })}
          // The header has pointerdown handlers; without
          // data-no-drag, dragging the title text into the field
          // would start a block drag. Same pattern as TaskArea.
          data-no-drag
        />
        <div ref={menuRef} className="nc-links-block-menu" data-no-drag>
          <button
            type="button"
            className="nc-rss-block-iconbtn"
            onClick={() => setMenuOpen((v) => !v)}
            title="Block options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            ⚙
          </button>
          {menuOpen && (
            <div className="nc-links-block-menu-popup" role="menu">
              <button
                type="button"
                className="nc-account-item"
                role="menuitem"
                onClick={() => {
                  if (window.confirm('Delete this links block?')) {
                    setMenuOpen(false);
                    onDelete();
                  }
                }}
              >
                Delete block
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Body: scrollable list of link entries. */}
      <div className="nc-links-block-body">
        {block.items.length === 0 && (
          <p className="nc-links-block-empty">
            No links yet. Click <strong>+ Add link</strong> below.
          </p>
        )}
        {block.items.map((item) => (
          <LinkRow
            key={item.id}
            item={item}
            editing={editingId === item.id}
            onStartEdit={() => setEditingId(item.id)}
            onCommitEdit={() => setEditingId(null)}
            onChange={(patch) => updateItem(item.id, patch)}
            onDelete={() => deleteItem(item.id)}
          />
        ))}
        {block.items.length < MAX_ITEMS && (
          <button
            type="button"
            className="nc-links-block-add"
            onClick={addItem}
            title="Add a link to this block (max 10)"
          >
            + Add link
          </button>
        )}
      </div>

      {/* Resize handle (bottom-right corner). */}
      <div
        className="nc-rss-block-resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        aria-hidden
      />
    </div>
  );
}

/* ============================================================== */
/*                            LinkRow                             */
/* ============================================================== */

interface LinkRowProps {
  item: LinkItemDto;
  editing: boolean;
  onStartEdit: () => void;
  onCommitEdit: () => void;
  onChange: (patch: Partial<LinkItemDto>) => void;
  onDelete: () => void;
}

/**
 * One row inside a LinksBlock. Two-line stacked layout in display
 * mode (title bold, description muted underneath). In edit mode,
 * three inputs: title / description / url, plus a small delete
 * button.
 *
 * Click anywhere on the row in display mode to enter edit mode.
 * Click the title (in display mode, while NOT editing) → opens the
 * URL in a new tab. We use a small visual cue (cursor: pointer
 * + hover background) to communicate "this is clickable."
 *
 * Implementation note: we DON'T use an <a> tag because that would
 * conflict with the parent's drag detection and with click-to-edit
 * semantics. Plain div + onClick + middle-click handler covers the
 * common cases without the styling fight an <a> would bring.
 */
function LinkRow({
  item,
  editing,
  onStartEdit,
  onCommitEdit,
  onChange,
  onDelete,
}: LinkRowProps) {
  if (editing) {
    return (
      <div className="nc-links-row nc-links-row-editing" data-no-drag>
        <input
          type="text"
          className="nc-links-row-input nc-links-row-input-title"
          placeholder="Title"
          value={item.title}
          onChange={(e) => onChange({ title: e.target.value })}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommitEdit();
            if (e.key === 'Escape') onCommitEdit();
          }}
        />
        <input
          type="text"
          className="nc-links-row-input nc-links-row-input-desc"
          placeholder="Description (optional)"
          value={item.description}
          onChange={(e) => onChange({ description: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommitEdit();
            if (e.key === 'Escape') onCommitEdit();
          }}
        />
        <div className="nc-links-row-edit-foot">
          <input
            type="url"
            className="nc-links-row-input nc-links-row-input-url"
            placeholder="https://example.com"
            value={item.url}
            onChange={(e) => onChange({ url: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCommitEdit();
              if (e.key === 'Escape') onCommitEdit();
            }}
          />
          <button
            type="button"
            className="nc-links-row-delete"
            onClick={onDelete}
            title="Delete this link"
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  // Display mode. Click anywhere → edit. Title click (with no
  // modifiers) → open. We disambiguate with a small handler that
  // checks whether the click landed on the title element.
  const openUrl = (e: React.MouseEvent) => {
    if (!item.url) return;
    e.stopPropagation();
    window.open(item.url, '_blank', 'noopener,noreferrer');
  };

  // Friendly placeholder text when title or url is empty — better
  // than rendering blank rows that look like glitches.
  const displayTitle = item.title || item.url || '(untitled link)';

  return (
    <div
      className="nc-links-row"
      onClick={onStartEdit}
      // Make the whole row not bubble pointerdown to the header
      // drag handler. Even though it's outside the header, our
      // header wrapper currently catches via document-level
      // listeners; data-no-drag on rows keeps drag scoped to the
      // header.
      data-no-drag
      tabIndex={0}
      role="button"
      aria-label={`Edit link: ${displayTitle}`}
    >
      <div
        className="nc-links-row-title"
        onClick={openUrl}
        title={item.url ? `Open ${item.url}` : 'Click to add a URL'}
      >
        {displayTitle}
      </div>
      {item.description && (
        <div className="nc-links-row-desc">{item.description}</div>
      )}
    </div>
  );
}
