/**
 * Generate a v4-style UUID string. Three-tier fallback:
 *
 *   1. crypto.randomUUID()       — preferred. Works on HTTPS or
 *                                   localhost (any "secure context").
 *   2. crypto.getRandomValues()  — works EVERYWHERE including plain
 *                                   HTTP on a LAN. Just not as ergonomic
 *                                   as randomUUID() so we hand-format.
 *   3. Math.random()             — last-ditch. Not cryptographically
 *                                   strong, but on a frontend that's
 *                                   already running over plain HTTP on
 *                                   the LAN, the security model isn't
 *                                   "ids must be unguessable" — they
 *                                   just need to be unique within the
 *                                   user's set of blocks/notes/areas.
 *                                   Collision risk at our scale is
 *                                   astronomically low.
 *
 * The first one is what previous code assumed exclusively. That broke
 * the Startpage on plain-HTTP LAN access (e.g. http://gv38.slq.dk:2424)
 * because crypto.randomUUID is gated on secure contexts.
 *
 * Returns a 36-char string in canonical UUID format
 * (8-4-4-4-12 hex with dashes).
 */
export function newId(): string {
  // Tier 1: native randomUUID (HTTPS / localhost / file://).
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }

  // Tier 2: hand-build a v4 UUID from getRandomValues. This API is
  // available in every modern browser on every protocol — it's not
  // gated on secure contexts the way randomUUID is.
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint8Array(16);
    c.getRandomValues(buf);
    // RFC 4122 v4 layout:
    //   buf[6] high nibble = 4   (version)
    //   buf[8] high two bits = 10 (variant)
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    return formatUuid(buf);
  }

  // Tier 3: pure JS fallback. Only reached on environments without
  // any crypto API at all — practically nothing modern.
  const buf = new Uint8Array(16);
  for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  return formatUuid(buf);
}

/**
 * Convert a 16-byte buffer into the canonical 8-4-4-4-12 UUID form.
 * Inlined here rather than depending on a tiny lib.
 */
function formatUuid(buf: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    hex.push(buf[i].toString(16).padStart(2, '0'));
  }
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}
