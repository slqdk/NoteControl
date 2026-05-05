import type { VaultDto } from '../api/types';
import {
  resolveVaultColor,
  resolveVaultIcon,
} from '../util/vaultAppearance';

/**
 * Ship 91 — Vault avatar.
 *
 * 28×28 (default) coloured circle showing the vault's icon. Falls back
 * to the auto-derived first-letter avatar when the vault has no
 * explicit appearance set. Style classes hook into styles.css's
 * .nc-vault-avatar-{colorKey} rules for the actual hex values.
 *
 * Pure presentation — no click handlers, no popover. Place inside a
 * <button> or <Link> at the call site if you want it to do something.
 */
export interface VaultAvatarProps {
  vault: Pick<VaultDto, 'name' | 'iconKey' | 'colorKey'>;
  /** 28 by default. 18 for compact contexts (e.g. nested in a small dropdown row). */
  size?: number;
}

export function VaultAvatar({ vault, size = 28 }: VaultAvatarProps) {
  const icon = resolveVaultIcon(vault);
  const color = resolveVaultColor(vault);
  // We render the glyph at ~58% of the avatar diameter — emoji and
  // letters both look balanced at that ratio. Going bigger crowds
  // the circle; smaller looks lost.
  const fontSize = Math.round(size * 0.58);
  return (
    <span
      className={`nc-vault-avatar nc-vault-avatar-${color}`}
      style={{ width: size, height: size, fontSize }}
      aria-hidden="true"
    >
      {icon}
    </span>
  );
}
