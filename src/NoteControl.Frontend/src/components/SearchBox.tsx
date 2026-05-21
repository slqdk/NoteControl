import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import DOMPurify from 'dompurify';
import { Link } from 'react-router-dom';

import { ApiError, searchApi } from '../api/client';
import type { SearchResultDto, VaultDto } from '../api/types';
import { useNoteDefaults, isFullNoteWidth } from '../settings/noteDefaults';
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
 *
 * looseMatch carries the server flag indicating whether THIS vault's
 * results came from the OR fallback (true) or the strict AND pass
 * (false). Not currently consumed by the merge step (which applies
 * a strict coverage filter to all rows regardless) but kept on the
 * outcome so a future UX hook — e.g. "no exact match, showing
 * partial results" — can flag the case without a server round-trip.
 */
interface VaultSearchOutcome {
  vault: VaultDto;
  results: SearchResultDto[];
  looseMatch: boolean;
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

  // The user's global default note width. Live-updates when the user
  // drags the note-width slider in the appearance settings (the
  // noteDefaults hook subscribes to its own storage listener and
  // emits new defaults). The dropdown sizes itself to match: when
  // a note is open at 1000px wide, search results appear in the
  // same 1000px column. When the global default is the FULL
  // sentinel ("fill editor area"), we treat that as the numeric max
  // (2400) and let the app-frame clamp do the final cap.
  const noteDefaults = useNoteDefaults();
  const noteWidthPx = isFullNoteWidth(noteDefaults.defaults.width)
    ? 2400
    : noteDefaults.defaults.width;

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
  // escape its parent flex column.
  //
  // Anchoring rules:
  //   - top:      directly below the input (input.bottom + small gap)
  //   - width:    the user's global default note width, so search
  //               results appear in the same column width as the
  //               notes themselves. Capped to the app-frame width
  //               minus a small gutter, and floored at 280 so it
  //               never collapses to a sliver.
  //   - left:     centred inside the app-frame (so the dropdown sits
  //               in the same horizontal position the notes occupy).
  //   - maxH:     viewport bottom minus the input's bottom minus a
  //               small bottom gutter — always fits, uses everything
  //               available below the input.
  //
  // Recomputes on: open state change, window resize/scroll, and the
  // user's note-width setting changing while the dropdown is open
  // (so it tracks the slider live). The scroll listener is capture-
  // phase so ancestor-container scrolls also re-anchor the dropdown.
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
      const padding = 16; // gutter on each side, only used for the cap
      const frameLeft = frameRect ? frameRect.left : 0;
      const frameRight = frameRect ? frameRect.right : window.innerWidth;
      const maxAllowedWidth = frameRight - frameLeft - 2 * padding;
      // Clamp the note-width to what the app frame can hold, and
      // floor it so the dropdown never goes below a usable minimum.
      const width = Math.max(280, Math.min(noteWidthPx, maxAllowedWidth));
      // Centre horizontally inside the app frame. This matches how
      // .nc-editor sits inside its container — notes are centred,
      // so search results being centred makes them feel like they
      // belong to the same column.
      const left = frameLeft + Math.max(padding, (frameRight - frameLeft - width) / 2);
      const top = inputRect.bottom + 4;
      const bottomGutter = 12;
      const maxHeight = Math.max(160, window.innerHeight - top - bottomGutter);
      setDropdownStyle({ top, left, width, maxHeight });
    }
    recompute();
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
    };
  }, [open, noteWidthPx]);

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
          return {
            vault,
            results: r.value.results,
            // Default to false when an older server omits the field
            // — the optional `?` in SearchResponseDto means decoded
            // values can legitimately be undefined.
            looseMatch: r.value.looseMatch === true,
            error: null,
          };
        }
        const reason = r.reason;
        const message =
          reason instanceof ApiError ? reason.message : 'Search failed';
        return { vault, results: [], looseMatch: false, error: message };
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

  // Merge per-vault outcomes into a single globally-ranked list,
  // then post-filter to drop rows that don't actually contain every
  // query term across path + title + snippet.
  //
  // Two underlying server quirks we compensate for here:
  //
  //  1. The FTS5 schema marks `path` as UNINDEXED. A search for
  //     "ax5000 firmware" can miss a note titled "Firmware Changelog"
  //     living under MOTION/HARDWARE/AX5000/ because the AX5000 token
  //     never matches (it's in the path). We re-score below so notes
  //     matching in the path / title get boosted.
  //
  //  2. The FTS5 index uses `tokenize='porter unicode61'` — the
  //     Porter stemmer. A search for "windows" matches notes that
  //     contain only "window", because both stem to the same root.
  //     The user typed "windows" — they don't want notes that only
  //     have "window" cluttering the list.
  //
  // Re-scoring (always applied):
  //
  //     +30 per query term found (case-insensitive) in the path
  //     +20 per query term found in the title
  //     +5  per query term found in the snippet's plain text
  //     +50 bonus when every query term appears somewhere across
  //         path + title + snippet (the "complete coverage" bonus)
  //     +5  if the result is from the currently-active vault
  //
  // Coverage filter (always applied, with safety valve):
  //
  //   A row is kept only when every query term literally appears
  //   (case-insensitive substring) somewhere in its path, title, or
  //   snippet text. This drops both:
  //     - OR-fallback noise (term completely missing)
  //     - stem-expanded matches (note has the stem but not the
  //       surface form the user typed)
  //
  // Trade-off: the snippet is only a 32-token window. For a multi-
  // term query where one term genuinely matches deeper in the body
  // than the snippet shows, the row is dropped. In practice FTS5's
  // snippet picker prefers windows that contain co-occurring matches,
  // so this is rare — but it can happen. If you find a result you
  // expected to see disappearing, broaden the search.
  //
  // Safety valve: if filtering empties the list entirely, fall back
  // to the unfiltered scored set. Better to show partial matches
  // than nothing — preserves the "loose match" intent for queries
  // where literally nothing covers every term.
  //
  // Server's BM25 rank is preserved as the final tiebreaker via the
  // result's position within its per-vault outcome (lower index = the
  // server ranked it higher).
  const merged: MergedResult[] = useMemo(() => {
    if (!outcomes) return [];
    const terms = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    interface Scored {
      row: MergedResult;
      score: number;
      vaultRank: number;
      allCovered: boolean;
    }
    const scored: Scored[] = [];

    for (const o of outcomes) {
      o.results.forEach((r, idxWithinVault) => {
        const path = r.path.toLowerCase();
        const title = r.title.toLowerCase();
        // Strip the control-char highlight markers before scoring so
        // the markers themselves don't accidentally affect substring
        // matches. (They won't, since the terms can't contain
        // control chars, but defensive.)
        const snippetText = r.snippet.replace(/[\u0001\u0002]/g, '').toLowerCase();

        let pathHits = 0;
        let titleHits = 0;
        let snippetHits = 0;
        let allCovered = terms.length > 0;
        for (const term of terms) {
          const inPath = path.includes(term);
          const inTitle = title.includes(term);
          const inSnippet = snippetText.includes(term);
          if (inPath) pathHits++;
          if (inTitle) titleHits++;
          if (inSnippet) snippetHits++;
          if (!inPath && !inTitle && !inSnippet) allCovered = false;
        }

        let score = pathHits * 30 + titleHits * 20 + snippetHits * 5;
        if (allCovered) score += 50;
        if (o.vault.id === vaultId) score += 5;

        scored.push({
          row: { ...r, vault: o.vault },
          score,
          vaultRank: idxWithinVault,
          allCovered,
        });
      });
    }

    // Sort by score DESC; on ties, by the server's per-vault rank
    // ASC so the highest-BM25-ranked hit wins the tiebreaker.
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.vaultRank - b.vaultRank;
    });

    // Strict coverage filter applied to ALL rows (see header comment
    // for the trade-off discussion).
    const filtered = scored.filter((s) => s.allCovered);

    // Safety valve: if filtering emptied the list, fall back to the
    // unfiltered scored set. Better to show partial matches than
    // nothing.
    const final = filtered.length > 0 ? filtered : scored;

    return final.map((s) => s.row);
  }, [outcomes, query, vaultId]);

  // Vaults that returned an error (after a query ran). Surfaced as a
  // tiny chip below the toggles so failures don't masquerade as zero
  // results.
  const failedVaults = useMemo(
    () => (outcomes ?? []).filter((o) => o.error !== null),
    [outcomes],
  );

  // Lowercased query terms, reused by the render to highlight matches
  // in title and path. Same split rule as the merge memo so what we
  // score by is what we highlight by.
  const queryTerms = useMemo(
    () =>
      query
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0),
    [query],
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
      {/*
        Dim backdrop while a search query is active. Anchored to the
        dropdown's top so the topbar (containing the input itself and
        the topbar's vault picker) stays fully visible above the dim
        — only the page content below the search input is dimmed.
        Sits between the page content (no z-index) and the dropdown
        (z-index 100).
        The backdrop is a DOM child of .nc-search (the same container
        the outside-click handler treats as "inside"), so clicks on
        it don't trigger the global handler. We give it its own
        pointerdown that closes the dropdown explicitly.
        Only shown when there's a query (not while the dropdown is
        open just for the scope-picker row before typing) — dimming
        when nothing is being searched would feel heavyweight.
      */}
      {showResultArea && dropdownStyle && (
        <div
          className="nc-search-backdrop"
          style={{ top: dropdownStyle.top }}
          aria-hidden="true"
          onPointerDown={() => setOpen(false)}
        />
      )}
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
                    <VaultAvatar vault={v} size={12} />
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
                  <div className="nc-search-result-title">
                    {highlightTerms(r.title, queryTerms)}
                  </div>
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
                {/*
                  Path sits directly under the title in bold so the
                  user can immediately distinguish similarly-titled
                  notes (e.g. AX5000/Firmware Changelog vs
                  AX8000/Firmware Changelog). Matching query terms
                  inside the path are highlighted with <strong>,
                  same visual treatment as the title and snippet.
                */}
                <div className="nc-search-result-path">
                  {highlightTerms(r.path, queryTerms)}
                </div>
                <div
                  className="nc-search-result-snippet"
                  dangerouslySetInnerHTML={{
                    __html: snippetToSafeHtml(r.snippet, queryTerms),
                  }}
                />
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

function snippetToSafeHtml(raw: string, terms: string[]): string {
  // The server wraps each matched token with U+0001 (start) and
  // U+0002 (end). We translate those to <strong> tags. These
  // characters cannot appear in legitimate note bodies, so there is
  // no risk of false-positive bolding from literal markdown source
  // (which is what happened with the old "**" markers — they
  // collided with markdown bold syntax in the snippet text).
  //
  // However the SERVER's notion of "this matched the query" is
  // looser than the user expects. The FTS5 index uses the Porter
  // stemmer, so "windows" and "window" share a stem — a search for
  // "windows" highlights "window" in the snippet, which looks
  // misleading ("I didn't search for that").
  //
  // We narrow the server's highlights to those whose wrapped surface
  // form actually contains one of the user's query terms (case-
  // insensitive substring). The asymmetry is deliberate:
  //   - typed "windows", marked "window"  → drop (term not in marked)
  //   - typed "window",  marked "windows" → keep (term IS in marked,
  //                                              user sees the word
  //                                              they typed inside the
  //                                              highlight, which feels
  //                                              right)
  //   - typed "fire",    marked "firmware" → keep (substring match)
  //
  // The underlying search behaviour is unchanged — the server still
  // returns notes via stem-expansion, so a "windows" query still
  // finds notes that only contain "window". We only suppress the
  // visual emphasis on tokens that don't literally include what the
  // user typed.
  //
  // Pipeline:
  //   1. Walk the raw text and rewrite every \u0001…\u0002 pair into
  //      either <strong>…</strong> (kept) or just the inner text
  //      (dropped), HTML-escaping all literal text as we go.
  //   2. Run DOMPurify on the result as defence in depth.
  let html = '';
  let i = 0;
  while (i < raw.length) {
    const start = raw.indexOf('\u0001', i);
    if (start === -1) {
      html += escapeHtml(raw.slice(i).replace(/\u0002/g, ''));
      break;
    }
    html += escapeHtml(raw.slice(i, start).replace(/\u0002/g, ''));
    const end = raw.indexOf('\u0002', start + 1);
    if (end === -1) {
      // Malformed: start with no end. Treat the remainder as plain
      // text after stripping any stray start markers.
      html += escapeHtml(raw.slice(start + 1).replace(/[\u0001\u0002]/g, ''));
      break;
    }
    const inner = raw.slice(start + 1, end);
    const innerLower = inner.toLowerCase();
    const keep =
      terms.length === 0 ||
      terms.some((t) => t.length > 0 && innerLower.includes(t));
    if (keep) {
      html += '<strong>' + escapeHtml(inner) + '</strong>';
    } else {
      html += escapeHtml(inner);
    }
    i = end + 1;
  }

  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ['strong'], ALLOWED_ATTR: [] });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Split a string into a sequence of React nodes, wrapping any
 * substring that case-insensitively matches one of the query terms
 * in a <strong> tag. Used for the title and path fields where the
 * server doesn't provide pre-marked snippet HTML — we have to
 * compute the highlights client-side.
 *
 * Match strategy:
 *   1. For each term, collect every (start, end) interval where it
 *      appears in the text (case-insensitive).
 *   2. Sort intervals by start, then merge any that overlap or
 *      touch. Without merging, overlapping terms would produce
 *      nested <strong> tags and double-bolded text.
 *   3. Walk the text emitting alternating plain segments and
 *      highlighted segments.
 *
 * Returns React nodes (not an HTML string) so the caller can render
 * directly without DOMPurify.
 */
function highlightTerms(text: string, terms: string[]): ReactNode[] {
  if (!text) return [];
  if (terms.length === 0) return [text];

  const lower = text.toLowerCase();
  const intervals: Array<[number, number]> = [];
  for (const term of terms) {
    if (!term) continue;
    let i = lower.indexOf(term, 0);
    while (i !== -1) {
      intervals.push([i, i + term.length]);
      i = lower.indexOf(term, i + term.length);
    }
  }
  if (intervals.length === 0) return [text];

  intervals.sort((a, b) => a[0] - b[0]);
  // Merge overlapping / adjacent intervals so the rendered tags
  // don't nest. Adjacent (b[0] === a[1]) intervals from different
  // terms also collapse, which produces one <strong> instead of
  // two side-by-side ones — cleaner DOM, same visual.
  const merged: Array<[number, number]> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) {
      if (iv[1] > last[1]) last[1] = iv[1];
    } else {
      merged.push([iv[0], iv[1]]);
    }
  }

  const out: ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([start, end], idx) => {
    if (cursor < start) out.push(text.slice(cursor, start));
    out.push(<strong key={idx}>{text.slice(start, end)}</strong>);
    cursor = end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
