import { ApiError } from '../../api/client';

/** Human-readable error text for a failed API call. */
export function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message || fallback;
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}

/** "18 Nov 2026 10:41" in the browser's locale, or "—" for null. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Random password for the "Generate" buttons: 20 chars from an
 * unambiguous alphabet (no 0/O, 1/l/I), with at least one digit and
 * one symbol so it clears any reasonable policy. Uses crypto RNG.
 */
export function generatePassword(length = 20): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!#%+-=?@_';
  const all = letters + digits + symbols;
  const pick = (set: string, n: number) => {
    const buf = new Uint32Array(n);
    crypto.getRandomValues(buf);
    return Array.from(buf, (v) => set[v % set.length]);
  };
  const chars = [...pick(all, length - 2), ...pick(digits, 1), ...pick(symbols, 1)];
  // Fisher-Yates so the guaranteed digit/symbol aren't always last.
  const rnd = new Uint32Array(chars.length);
  crypto.getRandomValues(rnd);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rnd[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Short "Chrome on Windows"-style label from a user-agent string. */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /curl\//.test(ua) ? 'curl'
    : 'Browser';
  const os =
    /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return os ? `${browser} on ${os}` : browser;
}
