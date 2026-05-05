import { useEffect, useRef, useState } from 'react';
import { ApiError, vaultsApi } from '../api/client';
import type { VaultDto } from '../api/types';
import {
  VAULT_COLOR_PALETTE,
  VAULT_ICON_PALETTE,
  resolveVaultColor,
  resolveVaultIcon,
  type VaultColorKey,
} from '../util/vaultAppearance';
import { VaultAvatar } from './VaultAvatar';

/**
 * Ship 91 — Vault appearance editor.
 *
 * Floating popover with three sections:
 *   1. Live preview (the current avatar at 36px)
 *   2. Icon picker — 12-emoji palette + a "(auto)" button to clear
 *   3. Colour picker — 8 swatches + a "(auto)" button to clear
 *
 * Saves PUT /api/vaults/{id}/appearance on every change so the user
 * sees the result immediately on the picker (no Save button to
 * forget). Optimistic update: applies locally before the server
 * round-trip; rolls back on failure with a small error string.
 *
 * Closes on outside click (pointerdown for iOS-Safari-style touch
 * compatibility, matching Ship 85's audit) and on Escape. The
 * caller controls open/close via the open prop and onClose callback.
 *
 * Position: absolute, anchored at (x, y) the caller passes — usually
 * the right-click coordinates from the triggering pill. The popover
 * clamps itself to the viewport so it can't render off-screen on
 * narrow desktops.
 */
export interface VaultAppearancePopoverProps {
  vault: VaultDto;
  /** Triggering coordinates (e.g. from a right-click) for absolute positioning. */
  x: number;
  y: number;
  onClose: () => void;
  /** Caller supplies this so the parent can splice the updated DTO into its in-memory list. */
  onUpdated: (updated: VaultDto) => void;
}

export function VaultAppearancePopover({
  vault, x, y, onClose, onUpdated,
}: VaultAppearancePopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Local optimistic state — what we last asked the server to store.
  // The avatar inside this popover reads from here (not from the
  // vault prop) so swatch clicks feel instant. On API success this
  // is what we forward via onUpdated; on failure we revert.
  const [localIconKey, setLocalIconKey] = useState<string | null>(vault.iconKey ?? null);
  const [localColorKey, setLocalColorKey] = useState<string | null>(vault.colorKey ?? null);

  // Outside-click + Escape close. Mirrors Ship 85's pointerdown
  // pattern — fires on touch-then-scroll which mousedown can miss.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clamp the popover into the viewport. Measured AFTER mount so we
  // know the actual rendered size; falls back to estimates before
  // the first measurement (matches ContextMenu's approach).
  const POPOVER_WIDTH_ESTIMATE = 280;
  const POPOVER_HEIGHT_ESTIMATE = 220;
  const [pos, setPos] = useState<{ left: number; top: number }>(() => ({
    left: Math.min(x, window.innerWidth - POPOVER_WIDTH_ESTIMATE - 8),
    top: Math.min(y, window.innerHeight - POPOVER_HEIGHT_ESTIMATE - 8),
  }));
  useEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    setPos({ left, top });
  }, [x, y]);

  // Save with optimistic update. Both icon and colour changes go
  // through here; we always send the FULL pair so the server's
  // record stays in sync (PUT semantics — a partial body would
  // require server-side merge logic we'd rather not maintain).
  async function commit(nextIcon: string | null, nextColor: string | null) {
    setError(null);
    setLocalIconKey(nextIcon);
    setLocalColorKey(nextColor);
    try {
      const updated = await vaultsApi.updateAppearance(vault.id, {
        iconKey: nextIcon,
        colorKey: nextColor,
      });
      onUpdated(updated);
    } catch (e) {
      // Roll back the optimistic state.
      setLocalIconKey(vault.iconKey ?? null);
      setLocalColorKey(vault.colorKey ?? null);
      const msg = e instanceof ApiError
        ? `Save failed: ${e.message || `HTTP ${e.status}`}`
        : 'Save failed (network or unknown error).';
      setError(msg);
    }
  }

  // Build a synthetic vault for the live preview that uses the
  // optimistic state. The real vault prop only updates after the
  // server round-trip + onUpdated round-back; the preview should
  // reflect what the user just clicked, immediately.
  const previewVault = {
    name: vault.name,
    iconKey: localIconKey,
    colorKey: localColorKey,
  };

  return (
    <div
      ref={popoverRef}
      className="nc-vault-appearance-popover"
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
      aria-label={`Customize ${vault.name}`}
    >
      <div className="nc-vault-appearance-header">
        <VaultAvatar vault={previewVault} size={36} />
        <div className="nc-vault-appearance-title">{vault.name}</div>
        <button
          type="button"
          className="nc-vault-appearance-close"
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          ×
        </button>
      </div>

      <div className="nc-vault-appearance-section">
        <div className="nc-vault-appearance-label">Icon</div>
        <div className="nc-vault-appearance-grid">
          {/* Auto fallback first — clicking it clears IconKey, falling
              back to the deterministic first-letter avatar. */}
          <button
            type="button"
            className={
              'nc-vault-appearance-swatch nc-vault-appearance-swatch-auto'
              + (localIconKey === null ? ' nc-vault-appearance-swatch-active' : '')
            }
            onClick={() => commit(null, localColorKey)}
            title="Auto (first letter)"
          >
            {/* The "auto" swatch shows the AUTO-derived letter using
                the resolveVaultIcon helper with no iconKey. */}
            {resolveVaultIcon({ name: vault.name, iconKey: null })}
          </button>
          {VAULT_ICON_PALETTE.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={
                'nc-vault-appearance-swatch'
                + (localIconKey === emoji ? ' nc-vault-appearance-swatch-active' : '')
              }
              onClick={() => commit(emoji, localColorKey)}
              title={emoji}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>

      <div className="nc-vault-appearance-section">
        <div className="nc-vault-appearance-label">Colour</div>
        <div className="nc-vault-appearance-grid">
          <button
            type="button"
            className={
              'nc-vault-appearance-swatch nc-vault-appearance-swatch-auto'
              + (localColorKey === null ? ' nc-vault-appearance-swatch-active' : '')
            }
            onClick={() => commit(localIconKey, null)}
            title="Auto (from name)"
          >
            {/* Show the auto-resolved colour as a tiny filled circle. */}
            <span
              className={`nc-vault-appearance-color-preview nc-vault-avatar-${resolveVaultColor({ name: vault.name, colorKey: null })}`}
            />
          </button>
          {VAULT_COLOR_PALETTE.map((c: VaultColorKey) => (
            <button
              key={c}
              type="button"
              className={
                'nc-vault-appearance-swatch'
                + (localColorKey === c ? ' nc-vault-appearance-swatch-active' : '')
              }
              onClick={() => commit(localIconKey, c)}
              title={c}
            >
              <span
                className={`nc-vault-appearance-color-preview nc-vault-avatar-${c}`}
              />
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="nc-vault-appearance-error" role="alert">{error}</div>
      )}
    </div>
  );
}
