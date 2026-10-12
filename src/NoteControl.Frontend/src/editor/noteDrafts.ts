/**
 * Local safety copies of note edits that couldn't be saved.
 *
 * Why this exists: a failed save (network down, server restarting,
 * session expired, 412 conflict) used to live only in the editor's
 * memory. Anything that unmounted the editor — a navigation that
 * bypassed the save-failed dialog, the 401 bounce to /login, a tab
 * close — threw the text away. Gating every navigation path doesn't
 * scale (new links keep appearing), so instead the editor writes the
 * unsaved markdown here whenever a save fails or it unmounts while
 * unsaved, and offers it back the next time the same note opens.
 *
 * Storage: localStorage, one key per vault + note path. Values carry
 * the etag the text was based on, so the restore can tell "server
 * unchanged since — safe to put back" from "someone changed the note
 * since — ask first". Every access is wrapped in try/catch: storage
 * can be full, disabled, or throw in private windows, and a failure
 * here must never break saving itself.
 */

export interface NoteDraft {
  /** Markdown the user had in the editor. */
  markdown: string;
  /** Server etag the editor was working against when it was stored. */
  baseEtag: string;
  /** ISO timestamp, for the restore prompt and expiry. */
  savedAt: string;
}

/** Drafts older than this are dropped instead of offered. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function key(vaultId: string, notePath: string): string {
  return `nc.draft.${vaultId}.${notePath}`;
}

export function storeDraft(
  vaultId: string,
  notePath: string,
  markdown: string,
  baseEtag: string,
): void {
  try {
    const value: NoteDraft = { markdown, baseEtag, savedAt: new Date().toISOString() };
    localStorage.setItem(key(vaultId, notePath), JSON.stringify(value));
  } catch {
    // Quota / disabled storage: nothing more we can do here; the
    // save-failed badge and toast are still showing.
  }
}

export function loadDraft(vaultId: string, notePath: string): NoteDraft | null {
  try {
    const raw = localStorage.getItem(key(vaultId, notePath));
    if (!raw) return null;
    const d = JSON.parse(raw) as NoteDraft;
    if (typeof d?.markdown !== 'string' || typeof d.baseEtag !== 'string') return null;
    const age = Date.now() - Date.parse(d.savedAt);
    if (!Number.isFinite(age) || age > MAX_AGE_MS) {
      clearDraft(vaultId, notePath);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

export function clearDraft(vaultId: string, notePath: string): void {
  try {
    localStorage.removeItem(key(vaultId, notePath));
  } catch {
    // ignore
  }
}
