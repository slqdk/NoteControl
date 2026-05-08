/**
 * Display formatting for paths inside the "Daily Notes" folder.
 *
 * The on-disk layout is:
 *   Daily Notes/
 *     2026/                     ← year
 *       04-April/                ← month number + name
 *         2026-04-28.md          ← date file
 *
 * For tree display we want English human-readable labels:
 *   Daily Notes/
 *     2026/                     ← year unchanged
 *       May/                     ← drop the "05-" prefix and
 *                                   relabel the month in English
 *         Monday d. 28           ← English weekday + " d. " + day
 *                                   number, no extension
 *
 * IMPORTANT: this is DISPLAY-ONLY. The on-disk filenames are
 * unchanged. The path canonicalisation, search index, links to
 * specific notes — all keep using the canonical paths. Only the
 * tree row's visible label is re-formatted.
 *
 * Returns null when the input path doesn't match the daily notes
 * shape, signalling the caller to fall back to default name
 * formatting (filename minus .md, etc.).
 */

const DAILY_ROOT = 'Daily Notes';

/** English weekday names indexed 0=Sunday..6=Saturday (JS Date.getDay()). */
const ENGLISH_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** English month names indexed 1..12. Index 0 is unused/empty. */
const ENGLISH_MONTHS = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Reformat a Daily-Notes path component for display.
 *
 * @param fullPath — canonical path of the folder or note (forward
 *                   slashes, vault-relative, no leading slash)
 * @returns the display label, OR null if the path isn't under
 *          Daily Notes / doesn't match the expected shape
 */
export function formatDailyNoteLabel(fullPath: string): string | null {
  if (!fullPath.startsWith(`${DAILY_ROOT}/`) && fullPath !== DAILY_ROOT) {
    return null;
  }

  // Split off the "Daily Notes" prefix; we work with the rest.
  const rest = fullPath === DAILY_ROOT
    ? ''
    : fullPath.slice(DAILY_ROOT.length + 1);

  if (rest === '') {
    // The Daily Notes folder itself — leave its label as-is
    // (the caller will show "Daily Notes").
    return null;
  }

  const parts = rest.split('/');

  // 1. Year folder: "Daily Notes/2026" → "2026" (no rename needed,
  //    return null so the caller uses the default filename).
  if (parts.length === 1) {
    return null;
  }

  // 2. Month folder: "Daily Notes/2026/04-April" → "April" (English).
  if (parts.length === 2) {
    const monthFolder = parts[1];
    // Format "MM-MonthName" — try to parse the month number.
    const m = monthFolder.match(/^(\d{1,2})-/);
    if (!m) return null;
    const monthNum = parseInt(m[1], 10);
    if (monthNum < 1 || monthNum > 12) return null;
    return ENGLISH_MONTHS[monthNum];
  }

  // 3. Date file: "Daily Notes/2026/04-April/2026-04-28.md"
  //    → "Monday d. 28".
  //    Filename should match YYYY-MM-DD.md.
  if (parts.length === 3) {
    const fileName = parts[2];
    const m = fileName.match(/^(\d{4})-(\d{2})-(\d{2})\.md$/);
    if (!m) return null;

    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);

    // Construct a Date in local time. Year/month/day from the
    // filename are local-calendar values; using new Date(y, mo-1, d)
    // gives us the right weekday in local time without timezone
    // drift.
    const date = new Date(year, month - 1, day);
    if (Number.isNaN(date.getTime())) return null;

    const weekday = ENGLISH_WEEKDAYS[date.getDay()];
    // "d." is the Danish "den" (the) abbreviation kept as a
    // visual separator the user prefers — small concession to
    // local convention even though weekday/month names are English.
    return `${weekday} d. ${day}`;
  }

  // Anything deeper is unexpected; let the default formatter handle it.
  return null;
}

/**
 * True iff the given folder path is exactly the "Daily Notes" root
 * folder (NOT a subfolder under it). Step 39 uses this to decide
 * whether to swap the standard 📁 icon for a 📅 calendar icon on
 * that one row, matching the topbar's daily-note button.
 *
 * We deliberately match only the root row, not its year/month
 * children, because:
 *   - the year folders display as plain numbers and a calendar
 *     icon there would clutter the visual rhythm of the list
 *   - the date files already get reformatted labels via
 *     formatDailyNoteLabel; the icon stays as the normal note
 *     icon (📄) which is fine
 */
export function isDailyNotesRoot(folderPath: string): boolean {
  return folderPath === DAILY_ROOT;
}

/**
 * Given the display name shown by the default formatter for a folder,
 * AND the folder's full path, return the daily-notes label if
 * applicable, else the original name.
 *
 * Convenience wrapper that callers can use without writing the
 * fallback themselves.
 */
export function maybeDailyNotesLabel(fullPath: string, defaultLabel: string): string {
  return formatDailyNoteLabel(fullPath) ?? defaultLabel;
}
