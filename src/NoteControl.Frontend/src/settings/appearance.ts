/**
 * Global appearance settings.
 *
 * Two preferences:
 *   - appWidth: the maximum width of the centered app frame, in px.
 *               1000–2400, step 50, default 1600. The TOP of the
 *               range (APP_WIDTH_MAX = 2400) is a sentinel meaning
 *               "Full width" — the frame fills the browser viewport
 *               instead of being capped at a pixel value. See
 *               isFullWidth() and applyAppearanceCss() below.
 *   - gradientId: which preset gradient fills the body BEHIND the
 *               centered app frame (visible as left+right gutters
 *               on monitors wider than appWidth).
 *
 * Both are GLOBAL (per-browser, not per-vault) and persist in
 * localStorage under one key. Cross-tab sync via the 'storage' event;
 * same-tab sync via a tiny pubsub.
 *
 * The note page (the white "paper" inside the editor) is fixed at
 * 700px and is NOT controlled here. The gradient is the desk surface
 * the whole app sits on; the page sits on top of the normal app
 * background inside the editor.
 *
 * Why a homemade pubsub instead of useSyncExternalStore + a context:
 * one writer (the cog popover) and a couple of readers — a 30-line
 * subscriber list is plenty without dragging React internals into
 * storage logic.
 */

import { useEffect, useState } from 'react';

// ---------------------------------------------------- types

export type AppWidth = number;

export const APP_WIDTH_MIN = 1000;
export const APP_WIDTH_MAX = 2400;
export const APP_WIDTH_STEP = 50;
export const APP_WIDTH_DEFAULT = 1600;

/**
 * Slider value that means "full width / fill the viewport". We piggy-
 * back on APP_WIDTH_MAX rather than introducing a separate boolean
 * field — keeps the stored shape unchanged (no migration), and the
 * slider stays a single linear control. Anyone who previously had
 * 2400 saved as their cap now gets full-width behaviour, which is
 * the practical intent of "drag it as far right as it goes" anyway.
 *
 * Trade-off: a user who specifically wanted the literal 2400 px cap
 * can no longer get it — they'd have to settle for 2350 (one step
 * down) or full-width. On any monitor narrower than 2400 the visual
 * result is identical; only on 4K-and-up displays does full-width
 * actually paint wider than 2400 would have.
 */
export const APP_WIDTH_FULL: AppWidth = APP_WIDTH_MAX;

export function isFullWidth(w: AppWidth): boolean {
  return w >= APP_WIDTH_FULL;
}

export interface GradientPreset {
  /** Stable id stored in settings. Don't rename without a migration. */
  id: string;
  /** Human label shown under the swatch. */
  label: string;
  /** CSS background value used in light mode. */
  light: string;
  /** CSS background value used in dark mode. */
  dark: string;
  /**
   * Subtle theme-tinted colour for striping list rows in light mode.
   * Used as the background of every-other row in the Links block
   * (and potentially other striped lists in the future). Tuned to be
   * a tonal cousin of `light` — recognisably the same family — but
   * far less saturated so a row of stripes doesn't look loud against
   * the elevated background. Roughly: half-way between the gradient's
   * second stop and a neutral elevated surface.
   */
  lightStripe: string;
  /**
   * Dark-mode counterpart of <see cref="lightStripe"/>. Lifted a few
   * shades from the dark gradient stops so the stripe is just visible
   * against the elevated dark surface — bottom-stop colours are too
   * close to the row's base background to show separation.
   */
  darkStripe: string;
}

/**
 * Six tasteful presets. Each has a separate dark variant so we never
 * paint a high-saturation pastel on a dark UI. Default is 'slate' —
 * a near-neutral gradient that reads as a soft grey on white and a
 * subtle tonal shift on dark.
 *
 * Adding a preset: append here, no other code changes needed.
 * Removing one: also fine — loadAppearance falls back to default if
 * the saved id no longer exists.
 */
export const GRADIENT_PRESETS: readonly GradientPreset[] = [
  {
    id: 'slate',
    label: 'Slate',
    light: 'linear-gradient(180deg, #f1f5f9 0%, #e2e8f0 100%)',
    dark: 'linear-gradient(180deg, #1e293b 0%, #0f172a 100%)',
    lightStripe: '#eef2f7',
    darkStripe: '#1a2638',
  },
  {
    id: 'sky',
    label: 'Sky',
    light: 'linear-gradient(180deg, #e0f2fe 0%, #cce8fb 100%)',
    dark: 'linear-gradient(180deg, #0c2440 0%, #061629 100%)',
    lightStripe: '#e7f2fb',
    darkStripe: '#172d49',
  },
  {
    id: 'mint',
    label: 'Mint',
    light: 'linear-gradient(180deg, #ecfdf5 0%, #d1fae5 100%)',
    dark: 'linear-gradient(180deg, #0a2a22 0%, #051915 100%)',
    lightStripe: '#e8f7ee',
    darkStripe: '#143028',
  },
  {
    id: 'peach',
    label: 'Peach',
    light: 'linear-gradient(180deg, #fff1e6 0%, #ffd9be 100%)',
    dark: 'linear-gradient(180deg, #2a1a10 0%, #170c06 100%)',
    lightStripe: '#fbeadc',
    darkStripe: '#2f1f15',
  },
  {
    id: 'lavender',
    label: 'Lavender',
    light: 'linear-gradient(180deg, #f3e8ff 0%, #e9d5ff 100%)',
    dark: 'linear-gradient(180deg, #251a3a 0%, #130a22 100%)',
    lightStripe: '#ede1f7',
    darkStripe: '#2a1f3f',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    light: 'linear-gradient(180deg, #ffe4e6 0%, #fecaca 100%)',
    dark: 'linear-gradient(180deg, #2a1218 0%, #15080c 100%)',
    lightStripe: '#fbdfe2',
    darkStripe: '#2f181d',
  },
] as const;

const DEFAULT_GRADIENT_ID = 'slate';

export interface AppearanceSettings {
  appWidth: AppWidth;
  gradientId: string;
  /**
   * Ship 80: explicit theme override. 'auto' respects the OS
   * preference via prefers-color-scheme (the original behaviour);
   * 'light' / 'dark' force a fixed scheme regardless of OS.
   *
   * Implementation: the runtime sets a data-theme attribute on
   * <html>, and styles.css has [data-theme="dark"] / [data-theme="light"]
   * rule blocks that mirror the prefers-color-scheme tokens.
   */
  theme: 'auto' | 'light' | 'dark';
}

const DEFAULTS: AppearanceSettings = {
  appWidth: APP_WIDTH_DEFAULT,
  gradientId: DEFAULT_GRADIENT_ID,
  theme: 'auto',
};

// ---------------------------------------------------- persistence

const STORAGE_KEY = 'nc.appearance';

function clampWidth(n: number): AppWidth {
  if (!Number.isFinite(n)) return APP_WIDTH_DEFAULT;
  // Snap to step. Rounding (not flooring) avoids 1599 → 1550 surprise.
  const snapped =
    Math.round((n - APP_WIDTH_MIN) / APP_WIDTH_STEP) * APP_WIDTH_STEP +
    APP_WIDTH_MIN;
  return Math.min(APP_WIDTH_MAX, Math.max(APP_WIDTH_MIN, snapped));
}

function isKnownGradient(id: string): boolean {
  return GRADIENT_PRESETS.some((p) => p.id === id);
}

export function loadAppearance(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AppearanceSettings>;
    return {
      appWidth:
        typeof parsed.appWidth === 'number'
          ? clampWidth(parsed.appWidth)
          : APP_WIDTH_DEFAULT,
      gradientId:
        typeof parsed.gradientId === 'string' && isKnownGradient(parsed.gradientId)
          ? parsed.gradientId
          : DEFAULT_GRADIENT_ID,
      // Ship 80: theme override. Anything that isn't a recognised
      // value (including missing in pre-Ship-80 stored configs)
      // falls back to 'auto' = honour the OS preference.
      theme:
        parsed.theme === 'light' || parsed.theme === 'dark'
          ? parsed.theme
          : 'auto',
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveAppearance(next: AppearanceSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — silent, settings still apply for this tab */
  }
  notify();
}

// ---------------------------------------------------- pubsub

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((l) => l());
}

// Cross-tab sync: the 'storage' event fires when ANOTHER tab writes
// to localStorage. Same-tab writes use our own pubsub via notify().
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) notify();
  });
}

// ---------------------------------------------------- React hook

/**
 * Returns the current settings + setters. Re-renders when settings
 * change, whether the change came from this component, another
 * component, or another tab.
 */
export function useAppearance(): {
  settings: AppearanceSettings;
  setAppWidth: (w: AppWidth) => void;
  setGradientId: (id: string) => void;
  setTheme: (theme: AppearanceSettings['theme']) => void;
} {
  const [settings, setSettings] = useState<AppearanceSettings>(() => loadAppearance());

  useEffect(() => {
    // On mount, re-read so we pick up any writes that happened between
    // the initial useState evaluation and effect run. Cheap.
    setSettings(loadAppearance());
    const listener = () => setSettings(loadAppearance());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return {
    settings,
    setAppWidth: (w) => saveAppearance({ ...loadAppearance(), appWidth: clampWidth(w) }),
    setGradientId: (id) =>
      saveAppearance({
        ...loadAppearance(),
        gradientId: isKnownGradient(id) ? id : DEFAULT_GRADIENT_ID,
      }),
    // Ship 80: theme setter. Same persistence pattern as the others
    // — saveAppearance writes localStorage and notifies subscribers
    // (cross-tab + same-tab via the pubsub).
    setTheme: (theme) =>
      saveAppearance({
        ...loadAppearance(),
        theme:
          theme === 'light' || theme === 'dark' ? theme : 'auto',
      }),
  };
}

// ---------------------------------------------------- CSS application

/**
 * Write the current settings to CSS custom properties on the root
 * element. The styles in styles.css consume these via var().
 *
 * --nc-app-width drives the .nc-app-frame max-width. When the user
 * picks the sentinel "full width" value (APP_WIDTH_FULL) we write
 * the keyword `100%` instead of a px value so the frame fills the
 * viewport at any monitor size.
 *
 * --nc-page-bg-light / --nc-page-bg-dark drive the body background;
 *   CSS picks the right one via prefers-color-scheme.
 *
 * --nc-stripe-bg-light / --nc-stripe-bg-dark drive the alternating
 *   row background in striped lists (e.g. the Links block). Same
 *   light/dark switching pattern as the page background; values
 *   come from each preset's lightStripe / darkStripe fields.
 */
export function applyAppearanceCss(settings: AppearanceSettings): void {
  if (typeof document === 'undefined') return;
  const preset =
    GRADIENT_PRESETS.find((p) => p.id === settings.gradientId) ??
    GRADIENT_PRESETS[0];
  const root = document.documentElement.style;

  // Full-width sentinel: emit `100%` so .nc-app-frame.max-width
  // tracks the viewport. Below the sentinel, emit a px cap as
  // before. CSS happily accepts either as a max-width value.
  const widthValue = isFullWidth(settings.appWidth)
    ? '100%'
    : `${settings.appWidth}px`;
  root.setProperty('--nc-app-width', widthValue);

  root.setProperty('--nc-page-bg-light', preset.light);
  root.setProperty('--nc-page-bg-dark', preset.dark);
  // Theme-tinted stripe colour for striped lists (Links block etc.).
  // Light/dark pair mirrors the page-bg pattern; CSS picks the right
  // one via the same @media + [data-theme] triple-rule.
  root.setProperty('--nc-stripe-bg-light', preset.lightStripe);
  root.setProperty('--nc-stripe-bg-dark', preset.darkStripe);

  // Ship 80: theme override. data-theme="auto" means "let
  // prefers-color-scheme decide" — represented here as no
  // attribute at all (so the @media block in styles.css runs).
  // Explicit 'light' / 'dark' set the attribute, and
  // [data-theme="..."] rule blocks override the @media tokens.
  const html = document.documentElement;
  if (settings.theme === 'light' || settings.theme === 'dark') {
    html.setAttribute('data-theme', settings.theme);
  } else {
    html.removeAttribute('data-theme');
  }
}

/**
 * Convenience hook: subscribes to settings AND applies them to the
 * DOM whenever they change. Mount once at the app root.
 */
export function useAppliedAppearance(): void {
  const { settings } = useAppearance();
  useEffect(() => {
    applyAppearanceCss(settings);
  }, [settings]);
}

/**
 * Ship 80: clear ALL local-settings storage keys and reload.
 *
 * Used by the "Reset all settings to defaults" button in the
 * settings cog. Wipes:
 *   - nc.appearance       (this file: app width, gradient, theme)
 *   - nc.treeBehaviour    (settings/treeBehaviour.ts)
 *   - nc.noteDefaults     (settings/noteDefaults.ts)
 *   - nc.treeVariant      (tree/treeStyles.ts — no-op now that the
 *                          variant picker is hidden but cleaned up
 *                          for completeness)
 *   - nc.treeFontStack    (tree/treeAppearance.ts)
 *   - nc.treeFontSize     (tree/treeAppearance.ts)
 *
 * Reload after the wipe so every consumer (each useState that
 * initialised from localStorage) re-reads a fresh DEFAULTS without
 * needing a coordinated rerender. The user already confirmed
 * (caller pops a window.confirm before this), so the reload isn't
 * disruptive.
 *
 * Why a hard reload instead of broadcasting a "reset" event:
 * cleaner, simpler, no chance of a half-reset state from a
 * subscriber that doesn't handle the event. The user just sees
 * everything snap to factory defaults.
 */
const ALL_SETTING_KEYS: readonly string[] = [
  'nc.appearance',
  'nc.treeBehaviour',
  'nc.noteDefaults',
  'nc.treeVariant',
  'nc.treeFontStack',
  'nc.treeFontSize',
];

export function resetAllSettingsAndReload(): void {
  try {
    for (const key of ALL_SETTING_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    /* private mode / quota — silent. */
  }
  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}
