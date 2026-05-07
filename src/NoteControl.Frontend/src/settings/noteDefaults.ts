import { useEffect, useState } from 'react';

/**
 * Global "Note defaults" — the values applied to a note's editor
 * when its frontmatter doesn't specify them. Persisted in
 * localStorage; cross-tab sync via the 'storage' event matches
 * the pattern in settings/appearance.ts.
 *
 * Resolution order in the editor:
 *
 *   per-note frontmatter value → global default here → CSS baseline
 *
 * That means existing notes with explicit Width/Font/FontSize keep
 * rendering exactly as they do today. Notes without those frontmatter
 * fields pick up whatever the user set globally; if they set
 * "Default" / cleared the field globally too, the original CSS
 * baseline (700px / system-ui / 15px) takes over.
 *
 * Why a separate module from settings/appearance.ts? appearance.ts
 * controls the APP shell (frame width, gradient). This module
 * controls the NOTE itself (its width, font, size). They're
 * conceptually different settings, persisted under different keys.
 */

// Width range: 700 (current CSS default = .nc-editor's hard-coded
// width) up to 2400 (matches APP_WIDTH_MAX in appearance.ts so the
// note can be as wide as the app frame allows). Step matches the
// app-width slider so both controls feel consistent.
export const NOTE_WIDTH_MIN = 700;
export const NOTE_WIDTH_MAX = 2400;
export const NOTE_WIDTH_STEP = 50;
export const NOTE_WIDTH_DEFAULT = 1000;

/**
 * Slider value that means "fill the available editor area". Same
 * sentinel pattern as APP_WIDTH_FULL in settings/appearance.ts:
 * piggybacks on the max so the stored shape stays a plain integer
 * (no migration), the slider is a single linear control, and the
 * default-loader's existing clamp keeps any old saved 2400 working
 * unchanged.
 *
 * This sentinel only applies to the GLOBAL default. Per-note widths
 * in YAML frontmatter remain plain integers — keeps the on-disk
 * format clean and self-explanatory. A user who wants a specific
 * note to fill the editor area can either clear the per-note Width
 * (so the note inherits the global) or set a per-note Width as
 * large as they like.
 *
 * resolveNoteAppearance below translates the sentinel to the CSS
 * keyword `100%` when there's no per-note override; numeric global
 * defaults keep emitting `${px}px` as before.
 */
export const NOTE_WIDTH_FULL: number = NOTE_WIDTH_MAX;

export function isFullNoteWidth(w: number): boolean {
  return w >= NOTE_WIDTH_FULL;
}

// Font-size range mirrors per-note FontSize and tree font size.
export const NOTE_FONT_SIZE_MIN = 10;
export const NOTE_FONT_SIZE_MAX = 32;
export const NOTE_FONT_SIZE_DEFAULT = 15;

export interface NoteDefaults {
  width: number;
  /** Empty string means "use the CSS default" (system-ui from styles.css). */
  fontStack: string;
  fontSize: number;
}

const DEFAULTS: NoteDefaults = {
  width: NOTE_WIDTH_DEFAULT,
  fontStack: '',
  fontSize: NOTE_FONT_SIZE_DEFAULT,
};

const STORAGE_KEY = 'nc.noteDefaults';

function clampWidth(n: number): number {
  if (!Number.isFinite(n)) return NOTE_WIDTH_DEFAULT;
  return Math.min(NOTE_WIDTH_MAX, Math.max(NOTE_WIDTH_MIN, Math.round(n)));
}

function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return NOTE_FONT_SIZE_DEFAULT;
  return Math.min(NOTE_FONT_SIZE_MAX, Math.max(NOTE_FONT_SIZE_MIN, Math.round(n)));
}

export function loadNoteDefaults(): NoteDefaults {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<NoteDefaults>;
    return {
      width:
        typeof parsed.width === 'number' ? clampWidth(parsed.width) : NOTE_WIDTH_DEFAULT,
      fontStack: typeof parsed.fontStack === 'string' ? parsed.fontStack : '',
      fontSize:
        typeof parsed.fontSize === 'number'
          ? clampFontSize(parsed.fontSize)
          : NOTE_FONT_SIZE_DEFAULT,
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveNoteDefaults(next: NoteDefaults): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore: private mode / quota — settings still apply this tab */
  }
  notify();
}

// ---------------------------------------------------- pubsub
//
// Same shape as settings/appearance.ts so consumers can subscribe
// to changes from the popover and re-render. The NoteEditor needs
// this so changing a global default in the popover causes the
// currently-open note to re-apply its style without a page reload.

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((l) => l());
}

// Cross-tab sync.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) notify();
  });
}

// ---------------------------------------------------- React hook

/**
 * Returns the current note defaults + setters. Re-renders when the
 * stored value changes, whether the change came from this component,
 * another component, or another tab.
 */
export function useNoteDefaults(): {
  defaults: NoteDefaults;
  setWidth: (w: number) => void;
  setFontStack: (stack: string) => void;
  setFontSize: (size: number) => void;
} {
  const [defaults, setDefaults] = useState<NoteDefaults>(() => loadNoteDefaults());

  useEffect(() => {
    // Re-read on mount in case localStorage changed between the
    // useState evaluation and effect run. Cheap.
    setDefaults(loadNoteDefaults());
    const listener = () => setDefaults(loadNoteDefaults());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return {
    defaults,
    setWidth: (w) =>
      saveNoteDefaults({ ...loadNoteDefaults(), width: clampWidth(w) }),
    setFontStack: (stack) =>
      saveNoteDefaults({ ...loadNoteDefaults(), fontStack: stack }),
    setFontSize: (size) =>
      saveNoteDefaults({ ...loadNoteDefaults(), fontSize: clampFontSize(size) }),
  };
}

/**
 * Resolve effective values, given the per-note frontmatter values
 * (any of which may be null). The editor calls this on every
 * render where appearance might have changed and feeds the result
 * back into the inline style on the .nc-editor DOM node.
 *
 * Per-note value wins; falls through to the global default; falls
 * through to empty string / null for the CSS baseline. Width=null
 * AND default also null returns null — so the inline style.width
 * stays empty and the .nc-editor's CSS rule (`width: 700px`) is
 * the floor.
 *
 * Width specifically: when per-note is null AND the global default
 * is at the NOTE_WIDTH_FULL sentinel, the resolved width is the
 * CSS keyword `100%` rather than a px value, so the editor card
 * tracks the available editor area instead of a fixed pixel cap.
 * Anything else stays a px value as before.
 *
 * In practice the global defaults are always present (loaded from
 * localStorage with sensible fallbacks), so the only way to fall
 * through to the CSS baseline is if the user explicitly clears
 * BOTH the per-note value AND the global one — which is
 * intentional. "Reset to factory" without forcing them through a
 * settings menu.
 */
export function resolveNoteAppearance(
  perNote: { font: string | null; fontSize: number | null; width: number | null },
  global: NoteDefaults,
): { font: string; fontSize: string; width: string } {
  // For each axis: prefer per-note, then global, then empty (CSS).
  const font = perNote.font ?? global.fontStack ?? '';
  const fontSize =
    perNote.fontSize !== null
      ? `${perNote.fontSize}px`
      : global.fontSize > 0
        ? `${global.fontSize}px`
        : '';
  const width =
    perNote.width !== null
      ? `${perNote.width}px`
      : isFullNoteWidth(global.width)
        ? '100%'
        : global.width > 0
          ? `${global.width}px`
          : '';
  return { font, fontSize, width };
}
