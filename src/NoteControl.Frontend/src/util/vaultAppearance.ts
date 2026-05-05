/**
 * Ship 91 — Vault appearance helpers.
 *
 * Two responsibilities:
 *   1. Hold the fixed icon + colour palettes shared between the
 *      VaultPicker (renders chosen appearance) and the Settings UI
 *      (lets the owner pick from the same set).
 *   2. Provide auto-derived fallback avatars when a vault hasn't been
 *      explicitly themed — so EVERY vault looks intentional out of
 *      the box, including ones created before Ship 91 landed.
 *
 * The server has matching palette validation in VaultService.cs; if
 * you change the lists below, sync that too. Mismatches will surface
 * as 400 from the appearance endpoint, not as silently-broken UI.
 */

import type { VaultDto } from '../api/types';

/**
 * The 12-emoji icon palette. Picked to span common vault use-cases:
 *   📁 generic folder            📓 journal/notebook
 *   🛠 tools / projects          🔧 hardware / wrench
 *   💼 work                      ✏️  drafts / writing
 *   📊 data / reports            🏠 personal
 *   🎓 study / learning          🎨 creative
 *   🔬 research / lab notes      📐 engineering / drafting
 *
 * Order matters for the picker UI (we render in this order).
 */
export const VAULT_ICON_PALETTE: readonly string[] = [
  '📁', '📓', '🛠', '🔧', '💼', '✏️', '📊', '🏠', '🎓', '🎨', '🔬', '📐',
] as const;

/**
 * Named colour swatches. Each maps to a {bg, fg, border} triple of CSS
 * variables — the actual hex values live in styles.css under
 * `:root` and the dark-theme override, so the swatches re-tune for
 * dark mode automatically.
 */
export type VaultColorKey =
  | 'blue' | 'green' | 'orange' | 'purple'
  | 'red'  | 'teal'  | 'amber'  | 'pink';

export const VAULT_COLOR_PALETTE: readonly VaultColorKey[] = [
  'blue', 'green', 'orange', 'purple',
  'red',  'teal',  'amber',  'pink',
] as const;

/**
 * Stable string hash → unsigned 32-bit int. Used to map a vault name
 * to a deterministic colour from the palette when no explicit
 * colorKey is set. The same vault name always lands on the same
 * colour — until the user explicitly picks one.
 *
 * djb2 variant: tiny, fast, decent distribution for short strings.
 * Not cryptographic; we don't need that for "pick a colour out of 8".
 */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    // (h * 33) ^ char
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  // Force unsigned for a clean modulo at the call site.
  return h >>> 0;
}

/**
 * Resolve the EFFECTIVE icon for a vault — explicit IconKey if set,
 * otherwise the first letter of the vault's name (uppercased). The
 * result is always a single visual glyph the picker can render in a
 * 32x32 circle.
 *
 * For a vault with name "" (which shouldn't happen — server enforces
 * non-empty — but defensively handle it), returns "?". Matches the
 * "(unknown)" fallback the server uses elsewhere.
 */
export function resolveVaultIcon(vault: Pick<VaultDto, 'name' | 'iconKey'>): string {
  if (vault.iconKey && vault.iconKey.length > 0) return vault.iconKey;
  const trimmed = vault.name.trim();
  if (trimmed.length === 0) return '?';
  // Use codePointAt, not charAt, so a multi-byte first char (e.g. an
  // emoji that someone typed into a vault name) survives intact. We
  // uppercase the result; uppercasing a non-letter codepoint is a
  // no-op in modern JS engines.
  const cp = trimmed.codePointAt(0);
  return cp !== undefined ? String.fromCodePoint(cp).toUpperCase() : '?';
}

/**
 * Resolve the EFFECTIVE colour for a vault — explicit ColorKey if
 * set (and valid), otherwise hash(name) mod palette.length.
 *
 * Returning the colour KEY (not a hex value) keeps the consumer free
 * to map through the CSS variables that styles.css owns. Re-tuning
 * the visual palette later means changing CSS, not regenerating any
 * stored data.
 */
export function resolveVaultColor(vault: Pick<VaultDto, 'name' | 'colorKey'>): VaultColorKey {
  if (vault.colorKey && (VAULT_COLOR_PALETTE as readonly string[]).includes(vault.colorKey)) {
    return vault.colorKey as VaultColorKey;
  }
  const idx = hashString(vault.name) % VAULT_COLOR_PALETTE.length;
  return VAULT_COLOR_PALETTE[idx];
}
