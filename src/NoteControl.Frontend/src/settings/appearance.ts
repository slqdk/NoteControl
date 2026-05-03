/**
 * Global appearance settings.
 *
 * Two preferences:
 *   - appWidth: the maximum width of the centered app frame, in px.
 *               1000–2400, step 50, default 1600.
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

export interface GradientPreset {
  /** Stable id stored in settings. Don't rename without a migration. */
  id: string;
  /** Human label shown under the swatch. */
  label: string;
  /** CSS background value used in light mode. */
  light: string;
  /** CSS background value used in dark mode. */
  dark: string;
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
  },
  {
    id: 'sky',
    label: 'Sky',
    light: 'linear-gradient(180deg, #e0f2fe 0%, #cce8fb 100%)',
    dark: 'linear-gradient(180deg, #0c2440 0%, #061629 100%)',
  },
  {
    id: 'mint',
    label: 'Mint',
    light: 'linear-gradient(180deg, #ecfdf5 0%, #d1fae5 100%)',
    dark: 'linear-gradient(180deg, #0a2a22 0%, #051915 100%)',
  },
  {
    id: 'peach',
    label: 'Peach',
    light: 'linear-gradient(180deg, #fff1e6 0%, #ffd9be 100%)',
    dark: 'linear-gradient(180deg, #2a1a10 0%, #170c06 100%)',
  },
  {
    id: 'lavender',
    label: 'Lavender',
    light: 'linear-gradient(180deg, #f3e8ff 0%, #e9d5ff 100%)',
    dark: 'linear-gradient(180deg, #251a3a 0%, #130a22 100%)',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    light: 'linear-gradient(180deg, #ffe4e6 0%, #fecaca 100%)',
    dark: 'linear-gradient(180deg, #2a1218 0%, #15080c 100%)',
  },
] as const;

const DEFAULT_GRADIENT_ID = 'slate';

export interface AppearanceSettings {
  appWidth: AppWidth;
  gradientId: string;
}

const DEFAULTS: AppearanceSettings = {
  appWidth: APP_WIDTH_DEFAULT,
  gradientId: DEFAULT_GRADIENT_ID,
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
  };
}

// ---------------------------------------------------- CSS application

/**
 * Write the current settings to CSS custom properties on the root
 * element. The styles in styles.css consume these via var().
 *
 * --nc-app-width drives the .nc-app-frame max-width.
 * --nc-page-bg-light / --nc-page-bg-dark drive the body background;
 *   CSS picks the right one via prefers-color-scheme.
 */
export function applyAppearanceCss(settings: AppearanceSettings): void {
  if (typeof document === 'undefined') return;
  const preset =
    GRADIENT_PRESETS.find((p) => p.id === settings.gradientId) ??
    GRADIENT_PRESETS[0];
  const root = document.documentElement.style;
  root.setProperty('--nc-app-width', `${settings.appWidth}px`);
  root.setProperty('--nc-page-bg-light', preset.light);
  root.setProperty('--nc-page-bg-dark', preset.dark);
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
