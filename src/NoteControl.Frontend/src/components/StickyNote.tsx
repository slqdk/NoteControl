import { useEffect, useRef, useState } from 'react';

import type { StickyNoteDto } from '../api/types';

/**
 * One sticky note inside a TaskArea.
 *
 * Ship 76 layout — compacted:
 *   Row 1: checkbox + headline input (inline, takes the rest of
 *          the row) + ⚙ menu button
 *   Row 2: content textarea, defaults to ONE line tall, expands
 *          via field-sizing:content (Chrome 123+, Firefox 122+)
 *          with a manual-resize-grip fallback so older browsers
 *          still render usably.
 *
 * Pre-Ship-76 had three rows (header / headline / 3-line content)
 * which wasted vertical space — most notes stay one line and the
 * empty whitespace below them looked like a glitch. The new
 * layout makes a brand-new sticky take ~2 lines of vertical
 * space instead of ~5.
 *
 * Editing is inline — you type, the parent's debounced save
 * handles persistence. Enter on the headline jumps focus to the
 * content textarea (per design lock).
 *
 * Done state: visual only (strikethrough + opacity reduction via
 * a class on the root). The note stays in place; "delete" is a
 * separate explicit action via the gear popup.
 *
 * The note doesn't manage its own drag-to-reorder — the parent
 * <TaskArea> wraps each note in a draggable <li> so the wrapper
 * can hook the HTML5 DnD events without polluting this component.
 */

/**
 * Fixed colour palette. Stored as keys (not hex) so the visual
 * palette can be retuned later without rewriting saved notes.
 * If a note has an unknown colour key (e.g. hand-edited file),
 * we fall back to "yellow" so the note still renders.
 */
export const STICKY_COLORS: Array<{ key: string; label: string }> = [
  { key: 'yellow', label: 'Yellow' },
  { key: 'pink',   label: 'Pink' },
  { key: 'green',  label: 'Green' },
  { key: 'blue',   label: 'Blue' },
  { key: 'orange', label: 'Orange' },
  { key: 'purple', label: 'Purple' },
  { key: 'gray',   label: 'Gray' },
];
const COLOR_KEYS = STICKY_COLORS.map((c) => c.key);
const DEFAULT_COLOR = 'yellow';

function normaliseColor(c: string): string {
  return COLOR_KEYS.includes(c) ? c : DEFAULT_COLOR;
}

export interface StickyNoteProps {
  note: StickyNoteDto;
  onChange: (patch: Partial<StickyNoteDto>) => void;
  onDelete: () => void;
}

export function StickyNote({ note, onChange, onDelete }: StickyNoteProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  // Click-outside / Escape closes the colour menu.
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

  const color = normaliseColor(note.color);

  return (
    <div
      className={[
        'nc-sticky-note',
        `nc-sticky-note-color-${color}`,
        note.done ? 'nc-sticky-note-done' : '',
      ].filter(Boolean).join(' ')}
    >
      {/*
        Ship 76: header is now ONE row that holds checkbox +
        headline + cog. Pre-Ship-76 had a header row plus a
        separate headline row underneath; the headline row sat
        empty whitespace at default and looked like a glitch.
      */}
      <div className="nc-sticky-note-header">
        <label
          className="nc-sticky-note-check"
          title={note.done ? 'Mark as not done' : 'Mark as done'}
        >
          <input
            type="checkbox"
            checked={note.done}
            onChange={(e) => onChange({ done: e.target.checked })}
            aria-label={note.done ? 'Mark as not done' : 'Mark as done'}
          />
        </label>

        {/*
          Headline now lives inline. flex:1 1 auto so it takes
          all remaining space between the checkbox and the cog.
          Same input shape as before; the CSS just snaps it into
          a row instead of giving it its own block.
        */}
        <input
          type="text"
          className="nc-sticky-note-headline"
          value={note.headline}
          placeholder="Headline"
          aria-label="Note headline"
          onChange={(e) => onChange({ headline: e.target.value })}
          onKeyDown={(e) => {
            // Enter on headline → jump to content.
            if (e.key === 'Enter') {
              e.preventDefault();
              contentRef.current?.focus();
            }
          }}
        />

        <button
          type="button"
          className="nc-rss-block-iconbtn"
          onClick={() => setMenuOpen((v) => !v)}
          title="Note options"
          aria-label="Note options"
          aria-expanded={menuOpen}
        >
          ⚙
        </button>

        {menuOpen && (
          <div
            ref={menuRef}
            className="nc-sticky-note-menu"
            role="menu"
          >
            <div className="nc-sticky-note-menu-section">
              <span className="nc-sticky-note-menu-label">Colour</span>
              <div className="nc-sticky-note-color-grid">
                {STICKY_COLORS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={[
                      'nc-sticky-note-color-swatch',
                      `nc-sticky-note-color-${c.key}`,
                      c.key === color ? 'nc-sticky-note-color-swatch-active' : '',
                    ].filter(Boolean).join(' ')}
                    title={c.label}
                    aria-label={`Colour: ${c.label}`}
                    aria-pressed={c.key === color}
                    onClick={() => {
                      onChange({ color: c.key });
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="nc-sticky-note-menu-section">
              <button
                type="button"
                className="nc-btn nc-btn-danger nc-sticky-note-menu-delete"
                onClick={() => {
                  // eslint-disable-next-line no-alert
                  if (window.confirm('Delete this note? This cannot be undone.')) {
                    setMenuOpen(false);
                    onDelete();
                  }
                }}
              >
                🗑 Delete note
              </button>
            </div>
          </div>
        )}
      </div>

      {/*
        Ship 76: content textarea now defaults to ONE row visible
        (rows=1). On modern Chromium / Firefox, field-sizing:content
        (set in CSS) makes it auto-grow as the user types; on
        older browsers it stays one line and the user can drag the
        native resize handle if they need more. Either way, the
        empty default no longer wastes vertical space.

        Note kept the textarea (not <input>) so multi-line content
        round-trips when read from disk.
      */}
      <textarea
        ref={contentRef}
        className="nc-sticky-note-content"
        value={note.content}
        placeholder="Add details…"
        aria-label="Note content"
        rows={1}
        onChange={(e) => onChange({ content: e.target.value })}
      />
    </div>
  );
}
