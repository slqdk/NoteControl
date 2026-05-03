import { useEffect, useRef, useState } from 'react';

import type { StickyNoteDto } from '../api/types';

/**
 * One sticky note inside a TaskArea (step 42).
 *
 * Layout: a small coloured panel with three rows:
 *   1. Header: checkbox (toggles done) + colour-key dot + ⚙ menu
 *   2. Headline (single-line input, always editable)
 *   3. Content (textarea, always editable, auto-grows up to a cap)
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
 *
 * Each entry has a label (human-readable, used for the swatch
 * tooltip) and a CSS class suffix (the .nc-sticky-note-color-XXX
 * class adds the actual colours).
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
      <div className="nc-sticky-note-header">
        {/*
          Native checkbox — keyboard-accessible by default, no
          custom rendering. The label wraps it so the click
          target is generous.
        */}
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

        <span className="nc-sticky-note-spacer" />

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
                      // Keep the menu open so the user can see the
                      // change and pick another colour if they want.
                      // Closes on outside click / Escape.
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
                  // Confirm because there's no undo. Notes are
                  // small enough that retyping isn't catastrophic
                  // but the dialog still saves the occasional
                  // misclick.
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

      <input
        type="text"
        className="nc-sticky-note-headline"
        value={note.headline}
        placeholder="Headline"
        aria-label="Note headline"
        onChange={(e) => onChange({ headline: e.target.value })}
        onKeyDown={(e) => {
          // Per design: Enter on headline → jump to content. We
          // also block default form submission (no form here, but
          // belt-and-braces).
          if (e.key === 'Enter') {
            e.preventDefault();
            contentRef.current?.focus();
          }
        }}
      />

      <textarea
        ref={contentRef}
        className="nc-sticky-note-content"
        value={note.content}
        placeholder="Add details…"
        aria-label="Note content"
        rows={3}
        onChange={(e) => onChange({ content: e.target.value })}
      />
    </div>
  );
}
