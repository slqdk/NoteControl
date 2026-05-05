import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, startpageApi } from '../api/client';
import type { FeedDto, RssBlockDto } from '../api/types';
import { RssBlockSettingsPopup } from './RssBlockSettingsPopup';

/**
 * One free-floating RSS reader block on the startpage.
 *
 * Responsibilities:
 *   - Render its own header (drag handle), body (feed items), and
 *     bottom-right resize handle.
 *   - Track drag/resize gestures with pointer events; emit final
 *     positions/sizes to the parent via onChange. We update local
 *     "in-flight" state during the drag for smooth visual movement,
 *     then commit on pointerup so the parent only sees the final
 *     value (avoids hammering useDebouncedSave during drag).
 *   - Fetch its feed when feedUrl changes; cache the result locally
 *     so resizing/moving doesn't refetch.
 *   - Show its own settings popup when the gear is clicked.
 *
 * What happens on the wire:
 *   - drag/resize → final values flow up to StartpagePage via
 *     onChange, which updates the config; useDebouncedSave PUTs
 *     500ms later.
 *   - settings popup → live edits flow up the same way; URL
 *     changes also re-trigger the feed fetch via the useEffect
 *     below.
 */

// Bounds. Enforced here, NOT on the server — the server stores
// whatever we send. Keeping the clamps client-side means we can
// loosen them later without a server change.
const BOUNDS = {
  WIDTH_MIN: 200,
  WIDTH_MAX: 1200,
  HEIGHT_MIN: 150,
  HEIGHT_MAX: 1200,
  X_MIN: 0,
  Y_MIN: 0,
  HEADLINE_MIN: 10,
  HEADLINE_MAX: 24,
  PREVIEW_MIN: 0,
  PREVIEW_MAX: 200,
  MAX_ITEMS_MIN: 1,
  MAX_ITEMS_MAX: 100,
};

export interface RssBlockProps {
  vaultId: string;
  block: RssBlockDto;
  onChange: (patch: Partial<RssBlockDto>) => void;
  onDelete: () => void;
}

interface FeedState {
  loading: boolean;
  feed: FeedDto | null;
  error: string | null;
}

export function RssBlock({ vaultId, block, onChange, onDelete }: RssBlockProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ----- feed fetch -----
  // Refetch only when feedUrl actually changes. The dependency on
  // vaultId is theoretical (a single block belongs to one vault for
  // its whole life) but defensive-correct.
  const [feedState, setFeedState] = useState<FeedState>({
    loading: false,
    feed: null,
    error: null,
  });

  const refetchFeed = useCallback(() => {
    if (!block.feedUrl.trim()) {
      setFeedState({ loading: false, feed: null, error: null });
      return;
    }
    let cancelled = false;
    setFeedState({ loading: true, feed: null, error: null });
    void (async () => {
      try {
        const feed = await startpageApi.fetchFeed(vaultId, block.feedUrl);
        if (!cancelled) {
          setFeedState({ loading: false, feed, error: null });
        }
      } catch (e) {
        if (!cancelled) {
          setFeedState({
            loading: false,
            feed: null,
            error: e instanceof ApiError ? e.message : 'Could not load feed.',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId, block.feedUrl]);

  useEffect(() => {
    const cleanup = refetchFeed();
    return cleanup;
  }, [refetchFeed]);

  // ----- drag (move) -----
  //
  // Pointer Events give us a unified mouse/touch/pen gesture model
  // and pointer capture (so the gesture stays "stuck" to our element
  // even if the cursor flies off the block during a fast drag).
  //
  // During the drag we maintain a local override so the block visibly
  // tracks the cursor smoothly. We commit to the parent on pointerup
  // — that way useDebouncedSave only sees the final position, not a
  // hundred intermediate values, and only one PUT goes out per drag.
  const [dragOverride, setDragOverride] =
    useState<{ x: number; y: number } | null>(null);
  const dragOriginRef = useRef<{
    pointerX: number;
    pointerY: number;
    startX: number;
    startY: number;
  } | null>(null);

  const onHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    // Only left-button / primary drags. Avoids interfering with
    // right-click, middle-click etc.
    if (e.button !== 0) return;
    // Don't start a drag from inside a button/input — those have
    // their own click semantics.
    const target = e.target as HTMLElement;
    if (target.closest('button, input, a, [data-no-drag]')) return;

    e.currentTarget.setPointerCapture(e.pointerId);
    dragOriginRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      startX: block.x,
      startY: block.y,
    };
    setDragOverride({ x: block.x, y: block.y });
  }, [block.x, block.y]);

  const onHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    const o = dragOriginRef.current;
    if (!o) return;
    const dx = e.clientX - o.pointerX;
    const dy = e.clientY - o.pointerY;
    setDragOverride({
      x: Math.max(BOUNDS.X_MIN, o.startX + dx),
      y: Math.max(BOUNDS.Y_MIN, o.startY + dy),
    });
  }, []);

  const onHeaderPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragOriginRef.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const final = dragOverride;
    dragOriginRef.current = null;
    setDragOverride(null);
    if (final && (final.x !== block.x || final.y !== block.y)) {
      // Ship 90: round to int — DTO is `int X/Y`, fractional values
      // fail server-side deserialisation. See LinksBlock for the
      // shared rationale.
      onChange({ x: Math.round(final.x), y: Math.round(final.y) });
    }
  }, [block.x, block.y, dragOverride, onChange]);

  // ----- resize (bottom-right corner) -----
  //
  // Same pattern as drag: local override during the gesture, commit
  // on release. We clamp width/height to the configured bounds so a
  // user can't accidentally make a 10px-square block they can't see.
  const [resizeOverride, setResizeOverride] =
    useState<{ width: number; height: number } | null>(null);
  const resizeOriginRef = useRef<{
    pointerX: number;
    pointerY: number;
    startW: number;
    startH: number;
  } | null>(null);

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // don't bubble to header drag
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeOriginRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      startW: block.width,
      startH: block.height,
    };
    setResizeOverride({ width: block.width, height: block.height });
  }, [block.width, block.height]);

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    const o = resizeOriginRef.current;
    if (!o) return;
    const dw = e.clientX - o.pointerX;
    const dh = e.clientY - o.pointerY;
    setResizeOverride({
      width: clamp(o.startW + dw, BOUNDS.WIDTH_MIN, BOUNDS.WIDTH_MAX),
      height: clamp(o.startH + dh, BOUNDS.HEIGHT_MIN, BOUNDS.HEIGHT_MAX),
    });
  }, []);

  const onResizePointerUp = useCallback((e: React.PointerEvent) => {
    if (!resizeOriginRef.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const final = resizeOverride;
    resizeOriginRef.current = null;
    setResizeOverride(null);
    if (final && (final.width !== block.width || final.height !== block.height)) {
      // Ship 90: round to int (DTO requirement).
      onChange({ width: Math.round(final.width), height: Math.round(final.height) });
    }
  }, [block.width, block.height, resizeOverride, onChange]);

  // ----- effective position/size -----
  //
  // Local overrides win during an active gesture so the block
  // tracks the cursor smoothly without a roundtrip to the parent.
  const effX = dragOverride?.x ?? block.x;
  const effY = dragOverride?.y ?? block.y;
  const effW = resizeOverride?.width ?? block.width;
  const effH = resizeOverride?.height ?? block.height;

  // ----- visible items -----
  //
  // Truncate to maxItems first; the block's internal scroll handles
  // the rest. The "show first N that fit" requirement is satisfied
  // visually by the scrollable .nc-rss-block-body — items are listed
  // top to bottom and the user scrolls if there's more than fits.
  const visibleItems = useMemo(
    () => feedState.feed?.items.slice(0, block.maxItems) ?? [],
    [feedState.feed, block.maxItems],
  );

  // Display title: user-set wins, else feed title, else placeholder.
  const headerTitle =
    block.title.trim()
    || feedState.feed?.title
    || (block.feedUrl ? '(loading)' : '(new block — open settings to add a feed URL)');

  return (
    <div
      className="nc-rss-block"
      style={{
        left: effX,
        top: effY,
        width: effW,
        height: effH,
      }}
    >
      <div
        className="nc-rss-block-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <span className="nc-rss-block-title" title={headerTitle}>
          {headerTitle}
        </span>
        <span className="nc-rss-block-actions" data-no-drag="true">
          <button
            type="button"
            className="nc-rss-block-iconbtn"
            onClick={refetchFeed}
            title="Reload feed"
            aria-label="Reload feed"
          >
            ↻
          </button>
          <button
            type="button"
            className="nc-rss-block-iconbtn"
            onClick={() => setSettingsOpen(true)}
            title="Block settings"
            aria-label="Block settings"
          >
            ⚙
          </button>
        </span>
      </div>

      <div className="nc-rss-block-body">
        {!block.feedUrl.trim() && (
          <p className="nc-empty">
            No feed URL set. Click ⚙ to add one.
          </p>
        )}
        {feedState.loading && <p className="nc-empty">Loading feed…</p>}
        {feedState.error && (
          <div className="nc-form-error nc-rss-block-error">
            {feedState.error}
          </div>
        )}
        {!feedState.loading && !feedState.error && visibleItems.length === 0 && block.feedUrl.trim() && (
          <p className="nc-empty">No items in feed.</p>
        )}
        {visibleItems.length > 0 && (
          <ul className="nc-rss-item-list">
            {visibleItems.map((item, idx) => (
              <li key={`${item.link ?? 'no-link'}-${idx}`} className="nc-rss-item">
                {item.link ? (
                  <a
                    href={item.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="nc-rss-item-title"
                    style={{ fontSize: block.headlineSize }}
                  >
                    {item.title}
                  </a>
                ) : (
                  <span
                    className="nc-rss-item-title"
                    style={{ fontSize: block.headlineSize }}
                  >
                    {item.title}
                  </span>
                )}
                {item.publishedAt && (
                  <span className="nc-rss-item-date">
                    {formatRelative(item.publishedAt)}
                  </span>
                )}
                {block.previewWords > 0 && item.summary && (
                  <p className="nc-rss-item-summary">
                    {truncateWords(item.summary, block.previewWords)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div
        className="nc-rss-block-resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        title="Drag to resize"
        aria-label="Resize block"
      />

      {settingsOpen && (
        <RssBlockSettingsPopup
          block={block}
          bounds={BOUNDS}
          onChange={onChange}
          onDelete={() => {
            setSettingsOpen(false);
            onDelete();
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------- helpers

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Take the first `count` words. We split on whitespace runs so
 * "hello   world" counts as 2 words. Adds an ellipsis when the
 * source had more.
 */
function truncateWords(text: string, count: number): string {
  if (!text || count <= 0) return '';
  const words = text.trim().split(/\s+/);
  if (words.length <= count) return words.join(' ');
  return words.slice(0, count).join(' ') + '…';
}

/**
 * Render a relative date like "2 hours ago" / "yesterday" / "Apr 14".
 * Falls back to the raw string if Date can't parse it (server should
 * have sent ISO 8601, but feeds are unpredictable).
 */
function formatRelative(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const now = Date.now();
  const diffMs = now - parsed;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day} days ago`;
  // Older: locale date.
  return new Date(parsed).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: now - parsed > 365 * 86400_000 ? 'numeric' : undefined,
  });
}
