/**
 * Conflict-safe saving for the whole-file per-vault sidecars
 * (dashboards / startpage.json, assignments.json, note-widgets.json).
 *
 * The server hands out an ETag with every GET and PUT. A save sends
 * it back as If-Match; if another tab or device saved in between, the
 * server answers 412 instead of letting this tab's stale snapshot
 * erase their changes. On 412 we re-read the file, merge OUR change
 * into the fresh copy (three-way, per item), and retry.
 *
 * "Our change" = what differs between `base` (the last version we
 * know the server had) and `local` (what we want to save). Items we
 * didn't touch take the server's current version, so additions,
 * edits and deletions made elsewhere survive.
 */

import { ApiError } from '../api/client';

/** Per-resource sync state. One object per (vault, sidecar) load. */
export interface SidecarSyncState<T> {
  /** ETag of `base`; null when the server didn't send one. */
  etag: string | null;
  /** Last version known to be on the server. */
  base: T | null;
}

export interface SaveSidecarArgs<T> {
  local: T;
  state: SidecarSyncState<T>;
  put: (data: T, etag: string | null) => Promise<string | null>;
  load: () => Promise<{ data: T; etag: string | null }>;
  merge: (base: T, local: T, server: T) => T;
}

/**
 * Save `local`, merging into the server's copy on conflict. Resolves
 * with what was finally saved and whether a merge happened (the host
 * should then show the merged result). Rejects with the last error
 * for anything that isn't a resolvable conflict.
 */
export async function saveSidecar<T>(
  args: SaveSidecarArgs<T>,
): Promise<{ saved: T; merged: boolean }> {
  const { state } = args;
  let data = args.local;
  let merged = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const etag = await args.put(data, state.etag);
      state.etag = etag ?? state.etag;
      state.base = data;
      return { saved: data, merged };
    } catch (e) {
      const conflict = e instanceof ApiError && e.status === 412;
      if (!conflict || attempt >= 2) throw e;
      const fresh = await args.load();
      data = args.merge(state.base ?? fresh.data, data, fresh.data);
      state.etag = fresh.etag;
      state.base = fresh.data;
      merged = true;
    }
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge of an id-keyed, ordered list. An item counts as
 * changed locally when it's new, edited or deleted relative to
 * `base`; those win. Everything else comes from `server`. Order:
 * if this side reordered, keep our order (server-only items appended);
 * otherwise keep the server's order (our new items appended).
 */
export function mergeById<T extends { id: string }>(base: T[], local: T[], server: T[]): T[] {
  const b = new Map(base.map((x) => [x.id, x]));
  const l = new Map(local.map((x) => [x.id, x]));
  const s = new Map(server.map((x) => [x.id, x]));
  const keep = new Map<string, T>();
  for (const id of new Set([...b.keys(), ...l.keys(), ...s.keys()])) {
    const inB = b.has(id);
    const inL = l.has(id);
    const changedHere = inL ? !inB || !same(l.get(id), b.get(id)) : inB;
    if (changedHere) {
      if (inL) keep.set(id, l.get(id)!);
    } else if (s.has(id)) {
      keep.set(id, s.get(id)!);
    }
  }
  const baseOrder = base.map((x) => x.id).filter((id) => l.has(id));
  const localOrder = local.map((x) => x.id).filter((id) => b.has(id));
  const weReordered = !same(baseOrder, localOrder);
  const primary = weReordered ? local : server;
  const secondary = weReordered ? server : local;
  const out: T[] = [];
  const placed = new Set<string>();
  for (const list of [primary, secondary]) {
    for (const x of list) {
      if (placed.has(x.id) || !keep.has(x.id)) continue;
      out.push(keep.get(x.id)!);
      placed.add(x.id);
    }
  }
  return out;
}

/** Three-way merge of a string-keyed record (note path → widgets). */
export function mergeRecord<V>(
  base: Record<string, V>,
  local: Record<string, V>,
  server: Record<string, V>,
): Record<string, V> {
  const out: Record<string, V> = { ...server };
  for (const k of new Set([...Object.keys(base), ...Object.keys(local)])) {
    if (same(base[k], local[k])) continue; // untouched here → server wins
    if (k in local) out[k] = local[k];
    else delete out[k];
  }
  return out;
}
