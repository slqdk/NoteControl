import { useEffect, useRef } from 'react';

import type { RssBlockDto } from '../api/types';

/**
 * Per-block settings popup. Shown when the gear icon on a block
 * is clicked. Lives INSIDE the block (positioned absolute over the
 * top-right corner), so multiple blocks can have their popups open
 * at once and dragging one block doesn't move another's popup.
 *
 * Behaviour:
 *   - All inputs are LIVE — every change is propagated up via
 *     onChange immediately. The parent's useDebouncedSave handles
 *     server persistence (500ms after the last change).
 *   - URL field is debounced just like everything else; the
 *     RssBlock component re-fetches the feed automatically when
 *     feedUrl actually changes (its useEffect dependency), and
 *     the server cache (5 min TTL) absorbs any rapid re-edits.
 *   - Click-outside closes the popup. Escape also closes.
 *   - Delete button removes the block entirely; we ask for
 *     confirm() because there's no undo.
 *
 * Layout: a small floating card. We don't try to be a full
 * dialog — no scrim, no centered modal. The popup is contextual
 * to its block.
 */

interface Bounds {
  WIDTH_MIN: number; WIDTH_MAX: number;
  HEIGHT_MIN: number; HEIGHT_MAX: number;
  HEADLINE_MIN: number; HEADLINE_MAX: number;
  PREVIEW_MIN: number; PREVIEW_MAX: number;
  MAX_ITEMS_MIN: number; MAX_ITEMS_MAX: number;
}

export interface RssBlockSettingsPopupProps {
  block: RssBlockDto;
  bounds: Bounds;
  onChange: (patch: Partial<RssBlockDto>) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function RssBlockSettingsPopup({
  block,
  bounds,
  onChange,
  onDelete,
  onClose,
}: RssBlockSettingsPopupProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Click-outside-to-close. We use mousedown rather than click so
  // a quick gesture that releases on a different element (common
  // for users who slide the cursor while clicking) still closes
  // predictably.
  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Helper for clamped numeric inputs. Input type="number" with a
  // string value gives us "" while the user is editing; we only
  // commit when there's a real number, so partial typing doesn't
  // snap weirdly.
  function num(field: keyof Pick<RssBlockDto,
    'width' | 'height' | 'headlineSize' | 'previewWords' | 'maxItems'>,
    value: string,
    min: number,
    max: number,
  ) {
    if (value === '') return; // user is mid-edit, leave it alone
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return;
    const clamped = Math.max(min, Math.min(max, n));
    onChange({ [field]: clamped } as Partial<RssBlockDto>);
  }

  // data-no-drag stops a user from accidentally dragging the
  // block while interacting with the popup; the RssBlock header's
  // onPointerDown checks for this attribute.
  return (
    <div
      ref={ref}
      className="nc-rss-settings-popup"
      data-no-drag="true"
      role="dialog"
      aria-label="RSS block settings"
    >
      <div className="nc-rss-settings-header">
        <span className="nc-rss-settings-title">Block settings</span>
        <button
          type="button"
          className="nc-rss-block-iconbtn"
          onClick={onClose}
          title="Close"
          aria-label="Close settings"
        >
          ×
        </button>
      </div>

      <div className="nc-rss-settings-body">
        <label className="nc-rss-settings-field">
          <span>Title (optional)</span>
          <input
            type="text"
            value={block.title}
            placeholder="Falls back to feed title"
            onChange={(e) => onChange({ title: e.target.value })}
          />
        </label>

        <label className="nc-rss-settings-field">
          <span>Feed URL</span>
          <input
            type="url"
            value={block.feedUrl}
            placeholder="https://example.com/feed.xml"
            onChange={(e) => onChange({ feedUrl: e.target.value })}
          />
        </label>

        <div className="nc-rss-settings-row">
          <label className="nc-rss-settings-field">
            <span>Width (px)</span>
            <input
              type="number"
              min={bounds.WIDTH_MIN}
              max={bounds.WIDTH_MAX}
              defaultValue={block.width}
              onBlur={(e) => num('width', e.target.value, bounds.WIDTH_MIN, bounds.WIDTH_MAX)}
              key={block.width}
            />
          </label>
          <label className="nc-rss-settings-field">
            <span>Height (px)</span>
            <input
              type="number"
              min={bounds.HEIGHT_MIN}
              max={bounds.HEIGHT_MAX}
              defaultValue={block.height}
              onBlur={(e) => num('height', e.target.value, bounds.HEIGHT_MIN, bounds.HEIGHT_MAX)}
              key={block.height}
            />
          </label>
        </div>
        {/*
          width/height use defaultValue+key so the input re-syncs
          to whatever the user dragged the block to via the corner
          handle. Without `key={block.width}` the input would keep
          showing the old value because defaultValue is only
          honoured on mount. With it, React re-mounts the input
          when the underlying value changes.

          We also commit on BLUR rather than onChange because
          number inputs allow typing intermediate states like "2"
          while heading to "240" — onChange would snap to 200
          (the min) on the first keystroke. onBlur waits for the
          user to finish.
        */}

        <label className="nc-rss-settings-field">
          <span>Headline font size: {block.headlineSize}px</span>
          <input
            type="range"
            min={bounds.HEADLINE_MIN}
            max={bounds.HEADLINE_MAX}
            value={block.headlineSize}
            onChange={(e) =>
              num('headlineSize', e.target.value,
                bounds.HEADLINE_MIN, bounds.HEADLINE_MAX)
            }
          />
        </label>

        <label className="nc-rss-settings-field">
          <span>Preview words: {block.previewWords}</span>
          <input
            type="range"
            min={bounds.PREVIEW_MIN}
            max={bounds.PREVIEW_MAX}
            value={block.previewWords}
            onChange={(e) =>
              num('previewWords', e.target.value,
                bounds.PREVIEW_MIN, bounds.PREVIEW_MAX)
            }
          />
        </label>

        <label className="nc-rss-settings-field">
          <span>Max items: {block.maxItems}</span>
          <input
            type="range"
            min={bounds.MAX_ITEMS_MIN}
            max={bounds.MAX_ITEMS_MAX}
            value={block.maxItems}
            onChange={(e) =>
              num('maxItems', e.target.value,
                bounds.MAX_ITEMS_MIN, bounds.MAX_ITEMS_MAX)
            }
          />
        </label>
      </div>

      <div className="nc-rss-settings-footer">
        <button
          type="button"
          className="nc-btn nc-btn-danger"
          onClick={() => {
            // Confirm because there's no undo. Per-block, so even
            // an "oops" can be reverted by re-adding (the old
            // feed URL would have to be retyped though).
            // eslint-disable-next-line no-alert
            if (window.confirm('Delete this block? This cannot be undone.')) {
              onDelete();
            }
          }}
        >
          🗑 Delete block
        </button>
      </div>
    </div>
  );
}
