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
