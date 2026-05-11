/**
 * Mobile navigation — deterministic folder colour helper.
 *
 * The mobile redesign's round-button row gives each folder a coloured
 * circle backdrop. To keep the colours stable across mounts (and
 * recognisable run-to-run), we hash the folder's display name into
 * one of the 8 vault palette colours.
 *
 * Why reuse the vault palette: the colours are already tuned for
 * solid-fill-with-white-text legibility (see .nc-vault-avatar-* in
 * styles.css), they survive light/dark themes unchanged, and the
 * palette is already validated by the server. No new design tokens.
 *
 * Why a separate file (not inside vaultAppearance.ts): the vault
 * helpers are about VAULTS as data objects with explicit colorKeys.
 * Folders don't have any persisted appearance — we're deterministic-
 * hashing them on the client only. Keeping the two concerns in
 * different files makes "where does this colour come from?" obvious
 * when reading either side.
 *
 * Hash matches the one used in vaultAppearance.ts (djb2) so a folder
 * named "Projects" lands on the same palette index as a vault named
 * "Projects" would, if someone happened to compare them. Not a
 * contract; just nice when it happens.
 */

import type { VaultColorKey } from './vaultAppearance';
import { VAULT_COLOR_PALETTE } from './vaultAppearance';

/** djb2 variant. See vaultAppearance.ts for rationale. */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

/**
 * Deterministic palette colour for any name (folder name, "Daily
 * notes" label, etc). The same input always returns the same colour.
 */
export function colorForName(name: string): VaultColorKey {
  if (!name) return VAULT_COLOR_PALETTE[0];
  const idx = hashString(name) % VAULT_COLOR_PALETTE.length;
  return VAULT_COLOR_PALETTE[idx];
}
