import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Link } from 'react-router-dom';

import { ApiError, searchApi } from '../api/client';
import type { SearchResultDto, VaultDto } from '../api/types';
import { VaultAvatar } from './VaultAvatar';

const SEARCH_DEBOUNCE_MS = 250;
const PER_VAULT_LIMIT = 20;

/**
 * localStorage key for the set of vault IDs the user has UN-ticked in
 * the search toggle row. Storing the negative set (rather than the
 * positive set) means new vaults appear ticked by default — the user
 * has to actively opt OUT, not opt IN.
 *
 * Per-browser (not per-account, not per-vault). That's deliberate:
 * search scope is a UI ergonomic preference, not a permission, and
 * keeping it on the browser matches every other localStorage key in
 * this app.
 */
const STORAGE_KEY = 'nc:search-vaults-excluded';

interface SearchBoxProps {
  /**
   * The currently-active vault. Search results from this vault sort
   * first when present (subtle ergonomic — your current context is
   * usually what you wanted).
   */
  vaultId: string;
  /**
   * Full list of vaults the caller can see. The search fans out
   * across every vault in this list that the user has ticked. If the
   * list is undefined or empty, falls back to single-vault search
   * (the previous behaviour).
   */
  vaults?: VaultDto[];
  folderPath?: string;
  placeholder?: string;
}

/**
 * One row in the merged result list. Wraps the server's
 * SearchResultDto with the vault it came from so we can render the
 * vault chip and link correctly when results span multiple vaults.
 */
interface MergedResult extends SearchResultDto {
  vault: VaultDto;
}

/**
 * One per-vault outcome from the fan-out. Used to render the result
 * list and any per-vault error chips. We deliberately keep failures
 * visible (rather than silently dropping them) so the user can tell
 * when a vault is excluded from results due to a server problem
 * rather than because their query genuinely missed.
 */
interface VaultSearchOutcome {
  vault: VaultDto;
  results: SearchResultDto[];
  error: string | null;
}

export function SearchBox({
  vaultId,
  vaults,
  folderPath = '',
  placeholder = 'Search…',
}: SearchBoxProps) {
  const [query, setQuery] = useState('');
  const [outcomes, setOutcomes] = useState<VaultSearchOutcome[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  // Set of vault IDs the user has un-ticked. Persisted in localStorage
  // as a JSON array. Lazily initialised from storage on first render
  // and kept in sync via a useEffect below.
  const [excluded, setExcluded] = useState<Set<string>>(() => readExcluded());

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Inline-style overrides for the dropdown so it can grow beyond
  // its containing column. Anchored to the input's bounding rect via
  // position:fixed; recomputed in a layout effect below on every open
  // and on window resize. The dropdown is rendered with these values
  // splatted onto its `style` prop — when null, the dropdown is
  // hidden anyway, so the initial paint never sees a missing value.
  const [dropdownStyle, setDropdownStyle] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  // List of vaults the box knows about, defaulting to a synthetic
  // single-entry list (the active vault) when the topbar hasn't
  // supplied the full list yet. Falls back gracefully — search keeps
  // working on the current vault even before the vault list resolves.
  const knownVaults: VaultDto[] = useMemo(() => {
    if (vaults && vaults.length > 0) return vaults;
    // Synthetic placeholder so the renderer below doesn't have to
    // special-case "no vaults known yet". The placeholder uses the
    // active vault id but with a generic label — the topbar usually
    // overwrites this within milliseconds of mount.
    return [
      {
        id: vaultId,
        path: '',
        name: 'This vault',
        scope: 'personal',
        ownerId: '',
        createdAt: '',
        role: 'viewer',
      },
    ];
  }, [vaults, vaultId]);

  // The selected vaults are the known list minus anything in the
  // excluded set. New vaults the user hasn't interacted with are
  // automatically included.
  const selectedVaults = useMemo(
    () => knownVaults.filter((v) => !excluded.has(v.id)),
    [knownVaults, excluded],
  );

  // Persist excluded set whenever it changes. Wrapped in try/catch
  // because localStorage can throw in private-mode Safari etc.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...excluded]));
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [excluded]);

  // Cross-tab sync: if another tab toggled the exclusion set, mirror
  // the change here. Same pattern the appearance/notes-defaults keys
  // already use elsewhere in the app.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      setExcluded(readExcluded());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Compute the dropdown's screen-space position whenever it might
  // need to be visible. The dropdown uses position:fixed so it can
  // escape its parent flex column and span the full app-frame width
  // (not just the topbar centre column).
  //
  // Anchoring rules:
  //   - top:      directly below the input (input.bottom + small gap)
  //   - left:     the app-frame's left edge plus a padding gutter
  //   - width:    app-frame width minus 2× the padding gutter
  //   - maxH:     viewport bottom minus the input's bottom minus a
  //               small bottom gutter, so the dropdown always fits
  //               on screen and uses everything below the input
  //
  // Recomputes on: open state change, window resize/scroll, app-frame
  // width changes (the user dragged the appearance slider). The scroll
  // listener is "true" passive — we just snap to the new position;
  // the dropdown doesn't track scroll smoothly because the topbar
  // itself doesn't scroll (the topbar is `position: sticky` at the
  // top of the layout).
  useLayoutEffect(() => {
    if (!open) {
      setDropdownStyle(null);
      return;
    }
    function recompute() {
      const input = inputRef.current;
      if (!input) return;
      const inputRect = input.getBoundingClientRect();
      // Look up the app-frame element. There's only one in the DOM —
      // it's the centred band the whole app renders inside. If we
      // can't find it (e.g. test environment, future refactor),
      // fall back to the viewport itself.
      const frame = document.querySelector('.nc-app-frame');
      const frameRect = frame?.getBoundingClientRect();
      const padding = 16; // gutter on each side of the dropdown
      const frameLeft = frameRect ? frameRect.left : 0;
      const frameRight = frameRect ? frameRect.right : window.innerWidth;
      const left = frameLeft + padding;
      const width = Math.max(280, frameRight - frameLeft - 2 * padding);
      const top = inputRect.bottom + 4;
      // Leave a small gutter at the bottom of the viewport so the
      // dropdown doesn't kiss the edge.
      const bottomGutter = 12;
      const maxHeight = Math.max(160, window.innerHeight - top - bottomGutter);
      setDropdownStyle({ top, left, width, maxHeight });
    }
    recompute();
    window.addEventListener('resize', recompute);
    // Capture-phase scroll so we catch scrolls in ancestor containers
    // (the app shell, the page main, etc.), not just window scrolls.
    window.addEventListener('scroll', recompute, true);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
    };
  }, [open]);

  // The actual query. Debounced; cancels the in-flight result set on
  // every keystroke + vault-selection change so stale results don't
  // overwrite fresh ones if the user types fast.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setOutcomes(null);
      setLoading(false);
      return;
    }
    if (selectedVaults.length === 0) {
      // The user has un-ticked every vault. Show an empty-state
      // dropdown rather than firing zero requests and showing
      // "No matches" — different problem, different message.
      setOutcomes([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const timer = setTimeout(async () => {
      // Fan out in parallel. allSettled rather than all so one
      // vault's 500 doesn't kill the others' results. Per-vault
      // limit is capped lower than the default (20 not 50) so a
      // big fan-out doesn't return 500+ rows.
      const responses = await Promise.allSettled(
        selectedVaults.map((v) =>
          // folderPath is only meaningful for the active vault; for
          // cross-vault search it's left blank so each vault is
          // searched in full. Folder-scoped search is a per-vault
          // concept; preserving it across vaults would be confusing.
          searchApi.query(
            v.id,
            trimmed,
            v.id === vaultId ? folderPath : '',
            PER_VAULT_LIMIT,
          ),
        ),
      );

      if (cancelled) return;

      const next: VaultSearchOutcome[] = selectedVaults.map((vault, i) => {
        const r = responses[i];
        if (r.status === 'fulfilled') {
          return { vault, results: r.value.results, error: null };
        }
        const reason = r.reason;
        const message =
          reason instanceof ApiError ? reason.message : 'Search failed';
        return { vault, results: [], error: message };
      });
      setOutcomes(next);
      setLoading(false);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, vaultId, folderPath, selectedVaults]);

  // Outside-click dismissal. Pointerdown so iOS taps that become
  // scrolls reliably close the dropdown — mousedown sometimes doesn't
  // fire under those circumstances on Safari iOS. Same change applied
  // to AccountMenu, ContextMenu, TopBar (Widgets+), and the settings
  // popover.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  // Merge per-vault outcomes into a single ordered list for rendering.
  // Active-vault hits come first (current-context priority), then the
  // others in the order their vault appears in `knownVaults`.
  const merged: MergedResult[] = useMemo(() => {
    if (!outcomes) return [];
    const order = (v: VaultDto) =>
      v.id === vaultId ? -1 : knownVaults.findIndex((kv) => kv.id === v.id);
    const sorted = [...outcomes].sort((a, b) => order(a.vault) - order(b.vault));
    const flat: MergedResult[] = [];
    for (const o of sorted) {
      for (const r of o.results) flat.push({ ...r, vault: o.vault });
    }
    return flat;
  }, [outcomes, knownVaults, vaultId]);

  // Vaults that returned an error (after a query ran). Surfaced as a
  // tiny chip below the toggles so failures don't masquerade as zero
  // results.
  const failedVaults = useMemo(
    () => (outcomes ?? []).filter((o) => o.error !== null),
    [outcomes],
  );

  function toggleVault(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Render decision: show the dropdown when the user has focused the
  // box AND there's something to show. "Something to show" means
  // either a typed query (results area) or a multi-vault scope row
  // (the toggles need to be discoverable). On the FolderPage's
  // in-page search box — which doesn't pass a vault list — neither
  // is true on bare focus, so the dropdown stays closed until the
  // user types, matching the pre-existing behaviour for that mount
  // site.
  const hasMultiVaultScope = knownVaults.length > 1;
  const showDropdown = open && (query.trim().length > 0 || hasMultiVaultScope);
  const showResultArea = open && query.trim().length > 0;
  const showZeroState =
    showResultArea && !loading && outcomes !== null && merged.length === 0;

  return (
    <div ref={containerRef} className="nc-search">
      <input
        ref={inputRef}
        type="search"
        className="nc-search-input"
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        aria-label="Search notes"
      />
      {showDropdown && dropdownStyle && (
        <div
          className="nc-search-dropdown"
          role="listbox"
          style={{
            top: dropdownStyle.top,
            left: dropdownStyle.left,
            width: dropdownStyle.width,
            maxHeight: dropdownStyle.maxHeight,
          }}
        >
          {/*
            Per-vault toggle row at the top of the dropdown. Always
            visible while the dropdown is open so the user knows what
            scope they're searching. Horizontally scrollable when many
            vaults exist (the CSS sets overflow-x: auto on the
            container).
          */}
          {knownVaults.length > 1 && (
            <div
              className="nc-search-scope"
              role="group"
              aria-label="Search scope"
            >
              {knownVaults.map((v) => {
                const checked = !excluded.has(v.id);
                return (
                  <button
                    key={v.id}
                    type="button"
                    className={
                      'nc-search-scope-pill' +
                      (checked ? ' nc-search-scope-pill-on' : '')
                    }
                    onClick={(e) => {
                      // Clicking a toggle should never close the
                      // dropdown or steal focus from the input. The
                      // pointerdown dismiss handler above does an
                      // inside-contains check so it's already safe;
                      // we just need to keep the input focused so the
                      // user can keep typing.
                      e.preventDefault();
                      toggleVault(v.id);
                    }}
                    title={checked ? 'Click to exclude' : 'Click to include'}
                    aria-pressed={checked}
                  >
                    <VaultAvatar vault={v} size={18} />
                    <span className="nc-search-scope-pill-label">
                      {v.name}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/*
            Per-vault error chips. Quiet — small italic line per
            failing vault. We do NOT collapse the result area when
            other vaults succeeded; partial results are better than
            no results.
          */}
          {showResultArea && failedVaults.length > 0 && (
            <div className="nc-search-errors">
              {failedVaults.map((o) => (
                <div key={o.vault.id} className="nc-search-error">
                  {o.vault.name}: {o.error}
                </div>
              ))}
            </div>
          )}

          {showResultArea && selectedVaults.length === 0 && (
            <div className="nc-search-empty">
              No vaults selected. Tick a vault above to search.
            </div>
          )}

          {showResultArea && loading && outcomes === null && (
            <div className="nc-search-empty">Searching…</div>
          )}

          {showZeroState && (
            <div className="nc-search-empty">No matches.</div>
          )}

          {showResultArea &&
            merged.map((r) => (
              <Link
                key={`${r.vault.id}:${r.path}`}
                className="nc-search-result"
                to={`/vaults/${r.vault.id}/note?path=${encodeURIComponent(r.path)}`}
                onClick={() => {
                  setOpen(false);
                  setQuery('');
                }}
                role="option"
              >
                <div className="nc-search-result-header">
                  <div className="nc-search-result-title">{r.title}</div>
                  {/*
                    Vault chip — only shown when more than one vault
                    is known to the box. In single-vault contexts
                    (e.g. the FolderPage's in-page search, which
                    doesn't pass a vault list) the chip is redundant
                    noise; suppress it. When multiple vaults are
                    known, the chip stays on every row so results
                    are visually distinguishable at a glance, even
                    on rows from the active vault.
                  */}
                  {knownVaults.length > 1 && (
                    <span
                      className="nc-search-result-vault"
                      title={`From ${r.vault.name}`}
                    >
                      <VaultAvatar vault={r.vault} size={16} />
                      <span className="nc-search-result-vault-name">
                        {r.vault.name}
                      </span>
                    </span>
                  )}
                </div>
                <div
                  className="nc-search-result-snippet"
                  dangerouslySetInnerHTML={{
                    __html: snippetToSafeHtml(r.snippet),
                  }}
                />
                <div className="nc-search-result-path">{r.path}</div>
              </Link>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * Read the excluded-vault-id set from localStorage. Returns an empty
 * set on any failure — defaults to "all vaults included" so a fresh
 * browser, a cleared storage, or a malformed value all behave the
 * same: nothing un-ticked.
 */
function readExcluded(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x) => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function snippetToSafeHtml(raw: string): string {
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  let inside = false;
  const html = escaped.replace(/\*\*/g, () => {
    inside = !inside;
    return inside ? '<strong>' : '</strong>';
  });

  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ['strong'], ALLOWED_ATTR: [] });
}
