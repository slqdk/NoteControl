/**
 * Format a server-side ISO timestamp the way the spec describes folder
 * views: relative ("2 hours ago", "yesterday", "3 days ago") for less
 * than 7 days, absolute for older ("April 15" or "April 15, 2025"
 * if the year differs from current).
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export function formatNoteTimestamp(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  const diff = now.getTime() - then.getTime();

  if (diff < MS_PER_MINUTE) {
    return 'just now';
  }

  if (diff < MS_PER_HOUR) {
    const m = Math.floor(diff / MS_PER_MINUTE);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }

  if (diff < MS_PER_DAY) {
    const h = Math.floor(diff / MS_PER_HOUR);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }

  const days = Math.floor(diff / MS_PER_DAY);
  if (days < 7) {
    if (days === 1) return 'yesterday';
    return `${days} days ago`;
  }

  // Absolute date for older items.
  const sameYear = then.getFullYear() === now.getFullYear();
  const month = then.toLocaleString(undefined, { month: 'long' });
  const day = then.getDate();
  return sameYear ? `${month} ${day}` : `${month} ${day}, ${then.getFullYear()}`;
}

/**
 * Render just the absolute date — "May 20" if the year matches the
 * current year, "May 20, 2025" otherwise. Always emitted, regardless
 * of how recent the timestamp is. Used in the FolderPage list where
 * each row shows BOTH the relative timestamp (handled by
 * formatNoteTimestamp above) and the absolute date side-by-side so a
 * user can scan for "the one I edited on the 13th" without doing
 * mental arithmetic.
 *
 * Month is short-form ("May", not "May 2026" — that's the year's
 * job) to keep row width predictable when the list is long.
 */
export function formatAbsoluteDateShort(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const sameYear = then.getFullYear() === now.getFullYear();
  // 'short' month gives "May", "Jan", "Sep" — three or four chars,
  // localised. Day stays a plain integer (no leading zero) for the
  // same compactness reason.
  const month = then.toLocaleString(undefined, { month: 'short' });
  const day = then.getDate();
  return sameYear ? `${month} ${day}` : `${month} ${day}, ${then.getFullYear()}`;
}
