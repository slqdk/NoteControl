import { useCallback, useEffect, useRef, useState } from 'react';

import type { LinkBlockDto, LinkItemDto } from '../api/types';
import { startpageApi } from '../api/client';
import { newId } from '../util/id';

/**
 * One free-floating links block on the startpage (Ship 74).
 *
 * Modelled on TaskArea: same drag/resize plumbing (header drags,
 * bottom-right corner resizes, all gestures via Pointer Events
 * with pointer-capture). Final values commit to the parent on
 * pointerup so the debounced save sees one update per gesture.
 *
 * Differences from TaskArea:
 *   - Children are link entries (title + description + URL), not
 *     sticky notes. Each entry is a two-line stacked row with a
 *     subtle hover background and no per-row border — Notion /
 *     Linear-style.
 *   - Hard cap at 10 entries per block (the user explicitly asked
 *     for this). The "+ Add link" button hides at 10.
 *   - Editing mode: clicking a row puts it in edit mode with three
 *     inputs (title / description / url). Saved on blur or Enter,
 *     cancelled on Escape. Saved entries become click-to-navigate
 *     (open in new tab).
 *   - No drag-to-reorder yet (could add later — not in v1 of this
 *     ship to keep scope tight).
 */

const BOUNDS = {
  WIDTH_MIN: 220,
  WIDTH_MAX: 800,
  HEIGHT_MIN: 180,
  HEIGHT_MAX: 1200,
  X_MIN: 0,
  Y_MIN: 0,
};

/** Hard cap per the user's spec. Enforced client-side only. */
const MAX_ITEMS = 10;

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export interface LinksBlockProps {
  /**
   * Vault id, forwarded to LinkRow for the link-preview API call.
   * The preview endpoint is per-vault (auth gating), so we need
   * the id at the call site. Sourced from useParams in DashboardPage.
   */
  vaultId: string;
  block: LinkBlockDto;
  onChange: (patch: Partial<LinkBlockDto>) => void;
  onDelete: () => void;
}

export function LinksBlock({ vaultId, block, onChange, onDelete }: LinksBlockProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Block-level edit mode (Ship 7). Toggled from the gear menu.
  // When false: rows are read-only, clicking a row opens its URL,
  //   no per-row delete buttons, no "+ Add link" affordance.
  // When true:  rows behave click-to-edit as before, URL blur
  //   auto-fetches a preview, trash icons appear on hover,
  //   "+ Add link" is visible.
  // Not persisted — page reload returns to view mode. Persisting
  // would surprise a user who came back and didn't realise the
  // block was still "open."
  const [editMode, setEditMode] = useState(false);

  // Click-outside / Escape to close the gear menu. Same pattern
  // TaskArea + RssBlock use.
  useEffect(() => {
    if (!menuOpen) return;
    function onDocDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // ----- header drag (move) -----
  const [dragOverride, setDragOverride] =
    useState<{ x: number; y: number } | null>(null);
  const dragOriginRef = useRef<{
    pointerX: number;
    pointerY: number;
    startX: number;
    startY: number;
  } | null>(null);

  const onHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Don't start a drag if the user clicked an interactive bit of
    // the header (the inline title input, the gear button, the
    // popup). data-no-drag opts out, like TaskArea.
    if (target.closest('button, input, textarea, a, [data-no-drag]')) return;
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
      // Ship 90: round to int before sending. The DTO declares int X/Y
      // and System.Text.Json refuses to convert fractional values
      // (which the pointer math produces) to int — server returns 400
      // with "could not be converted to LinkBlockDto. Path: $.links[N].x"
      // The fix is symmetric across LinksBlock / RssBlock / TaskArea
      // and across both drag (x/y) and resize (width/height).
      onChange({ x: Math.round(final.x), y: Math.round(final.y) });
    }
  }, [block.x, block.y, dragOverride, onChange]);

  // ----- corner resize -----
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
    e.stopPropagation();
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
      // Ship 90: round to int (see drag handler above for rationale).
      onChange({ width: Math.round(final.width), height: Math.round(final.height) });
    }
  }, [block.width, block.height, resizeOverride, onChange]);

  // ----- effective position/size -----
  const effX = dragOverride?.x ?? block.x;
  const effY = dragOverride?.y ?? block.y;
  const effW = resizeOverride?.width ?? block.width;
  const effH = resizeOverride?.height ?? block.height;

  // ----- item operations -----

  const updateItem = useCallback(
    (id: string, patch: Partial<LinkItemDto>) => {
      onChange({
        items: block.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
      });
    },
    [block.items, onChange],
  );

  const deleteItem = useCallback(
    (id: string) => {
      onChange({ items: block.items.filter((it) => it.id !== id) });
    },
    [block.items, onChange],
  );

  const addItem = useCallback(() => {
    if (block.items.length >= MAX_ITEMS) return;
    const newItem: LinkItemDto = {
      id: newId(),
      title: '',
      description: '',
      url: '',
      imageUrl: '',
    };
    onChange({ items: [...block.items, newItem] });
    // Tell the new row to start in edit mode. We track this in
    // a separate state so the user lands directly in the title
    // input — no extra click required.
    setEditingId(newItem.id);
  }, [block.items, onChange]);

  // ----- editing mode -----
  // Which item id is currently being edited. null = no row in edit
  // mode. Switching rows by clicking another row is handled by the
  // row's onClick — it calls setEditingId(thisId) and the previous
  // row falls back to display mode.
  const [editingId, setEditingId] = useState<string | null>(null);

  // Close edit mode when clicking outside the block. Without this,
  // clicking on the canvas to deselect a row keeps it editable.
  // We attach this only while something IS editing, to avoid
  // burning cycles for blocks that aren't in use.
  const blockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editingId) return;
    function onDocDown(e: MouseEvent) {
      if (blockRef.current && !blockRef.current.contains(e.target as Node)) {
        setEditingId(null);
      }
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [editingId]);

  return (
    <div
      ref={blockRef}
      className={[
        'nc-links-block',
        editMode ? 'nc-links-block-editing' : '',
      ].filter(Boolean).join(' ')}
      style={{
        left: `${effX}px`,
        top: `${effY}px`,
        width: `${effW}px`,
        height: `${effH}px`,
      }}
    >
      {/* Header: title input on the left, gear menu on the right. */}
      <div
        className="nc-links-block-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        {editMode ? (
          <input
            type="text"
            className="nc-links-block-title-input"
            placeholder="Untitled"
            value={block.title}
            onChange={(e) => onChange({ title: e.target.value })}
            // The header has pointerdown handlers; without
            // data-no-drag, dragging the title text into the field
            // would start a block drag. Same pattern as TaskArea.
            data-no-drag
          />
        ) : (
          /*
            View mode: render the title as plain text instead of an
            input. A read-only input looked confusing (focus ring +
            cursor on a non-editable field), and an editable title
            in "view mode" was the original inconsistency the user
            called out. Empty title falls back to a muted "Untitled"
            placeholder so the block isn't visually broken.

            data-no-drag here too — the header is otherwise a drag
            handle, and clicking on text inside it should select the
            text (browser default) not start a drag. Same reasoning
            as the original input.
          */
          <div
            className={[
              'nc-links-block-title-view',
              !block.title ? 'nc-links-block-title-view-empty' : '',
            ].filter(Boolean).join(' ')}
            data-no-drag
            title={block.title || 'Use the ⚙ menu to rename this block'}
          >
            {block.title || 'Untitled'}
          </div>
        )}
        <div ref={menuRef} className="nc-links-block-menu" data-no-drag>
          <button
            type="button"
            className="nc-rss-block-iconbtn"
            onClick={() => setMenuOpen((v) => !v)}
            title="Block options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            ⚙
          </button>
          {menuOpen && (
            <div className="nc-links-block-menu-popup" role="menu">
              <button
                type="button"
                className="nc-account-item"
                role="menuitem"
                onClick={() => {
                  // Toggle block-level edit mode. On exit, also clear
                  // any in-progress per-row edit so the user doesn't
                  // come back to a half-edited state next time they
                  // open edit mode again.
                  setMenuOpen(false);
                  if (editMode) setEditingId(null);
                  setEditMode((v) => !v);
                }}
              >
                {editMode ? 'Done editing' : 'Edit links'}
              </button>
              <button
                type="button"
                className="nc-account-item"
                role="menuitem"
                onClick={() => {
                  if (window.confirm('Delete this links block?')) {
                    setMenuOpen(false);
                    onDelete();
                  }
                }}
              >
                Delete block
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Body: scrollable list of link entries. */}
      <div className="nc-links-block-body">
        {block.items.length === 0 && (
          <p className="nc-links-block-empty">
            {editMode ? (
              <>No links yet. Click <strong>+ Add link</strong> below.</>
            ) : (
              <>No links yet. Open the <strong>⚙</strong> menu and pick
                <strong> Edit links</strong> to add some.</>
            )}
          </p>
        )}
        {block.items.map((item) => (
          <LinkRow
            key={item.id}
            vaultId={vaultId}
            blockEditMode={editMode}
            item={item}
            editing={editingId === item.id}
            onStartEdit={() => setEditingId(item.id)}
            onCommitEdit={() => setEditingId(null)}
            onChange={(patch) => updateItem(item.id, patch)}
            onDelete={() => deleteItem(item.id)}
          />
        ))}
        {/*
          +Add link only appears in block-level edit mode. Adding a
          link in view mode would be a contract violation — view
          mode is read-only. The empty-state hint above tells the
          user how to reach edit mode so a fresh block isn't stuck.
        */}
        {editMode && block.items.length < MAX_ITEMS && (
          <button
            type="button"
            className="nc-links-block-add"
            onClick={addItem}
            title="Add a link to this block (max 10)"
          >
            + Add link
          </button>
        )}
      </div>

      {/* Resize handle (bottom-right corner). */}
      <div
        className="nc-rss-block-resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        aria-hidden
      />
    </div>
  );
}

/* ============================================================== */
/*                            LinkRow                             */
/* ============================================================== */

interface LinkRowProps {
  /** Vault id needed for the link-preview API call. */
  vaultId: string;
  /**
   * Whether the parent block is in edit mode. When false (view mode):
   *   - Clicking the row opens the URL in a new tab.
   *   - The hover-trash button is hidden.
   *   - The row never enters per-row edit mode regardless of clicks.
   * When true (edit mode):
   *   - Clicking the row enters per-row edit mode (the existing flow).
   *   - The hover-trash button appears on hover/focus.
   *   - URL blur auto-fetches a preview as before.
   */
  blockEditMode: boolean;
  item: LinkItemDto;
  editing: boolean;
  onStartEdit: () => void;
  onCommitEdit: () => void;
  onChange: (patch: Partial<LinkItemDto>) => void;
  onDelete: () => void;
}

/**
 * One row inside a LinksBlock. Two-line stacked layout in display
 * mode (title bold, description muted underneath), with an optional
 * thumbnail on the left when `item.imageUrl` is set.
 *
 * Behaviour depends on the parent block's `blockEditMode`:
 *
 * View mode (blockEditMode = false):
 *   Clicking the row opens its URL in a new tab. No per-row edit,
 *   no trash icon. Rows read as static link entries.
 *
 * Edit mode (blockEditMode = true):
 *   Clicking the row enters per-row edit (title / description / url
 *   inputs + delete button). URL blur auto-fills empty fields from
 *   the /startpage/link-preview endpoint. Hover-trash icon visible.
 *
 * Implementation note: we DON'T use an <a> tag because that would
 * conflict with the parent's drag detection. Plain div + onClick +
 * window.open covers the common cases without the styling fight an
 * <a> would bring.
 *
 * Auto-fill rules (URL field blur in edit mode):
 *   - Only triggers when title is empty AND url looks like a real
 *     URL (starts with http:// or https://). This means a user
 *     editing an existing row to change just the URL doesn't lose
 *     their hand-typed title.
 *   - Silent: a spinner shows next to the URL field while fetching,
 *     but failures fall through to "user types manually" with no
 *     error banner. Network blips and Cloudflare 403s are common
 *     enough that a banner would feel naggy.
 *   - The fetched imageUrl is hotlinked — see the server-side
 *     LinkPreviewFetcher for the trade-off discussion. If the
 *     image later 404s, the <img> onError handler hides it.
 */
function LinkRow({
  vaultId,
  blockEditMode,
  item,
  editing,
  onStartEdit,
  onCommitEdit,
  onChange,
  onDelete,
}: LinkRowProps) {
  // Auto-fill loading state. Scoped per-row because each row's
  // URL blur is independent; multiple rows could theoretically be
  // fetching at once if the user is tab-blurring through them fast.
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Track which URL we've already auto-filled from so a re-blur on
  // the same URL doesn't re-trigger the fetch. The /link-preview
  // endpoint is server-cached for 1h, but skipping the network
  // round-trip entirely is cheaper and avoids the brief spinner
  // flash. Re-fetches happen only if the URL string actually changes.
  const lastFetchedUrlRef = useRef<string | null>(null);

  // Track the imageUrl that failed to load so we can hide a broken
  // thumbnail without losing the stored value (user might want it
  // back if the source recovers, or to hand-edit it). Re-rendering
  // with a fresh imageUrl resets the failure state.
  const [imgFailedFor, setImgFailedFor] = useState<string | null>(null);
  const imgFailed = imgFailedFor !== null && imgFailedFor === item.imageUrl;

  /**
   * Try to auto-fill empty fields from the link-preview endpoint.
   * Triggered on URL blur in edit mode. Strict guard: only fires
   * when title is empty AND we haven't already fetched this URL
   * AND the URL looks plausible. Failures are swallowed silently.
   */
  const tryAutoFill = useCallback(async () => {
    const trimmedUrl = item.url.trim();
    if (!trimmedUrl) return;
    if (item.title.trim().length > 0) return; // user typed a title — don't overwrite
    if (!/^https?:\/\//i.test(trimmedUrl)) return; // not a real URL yet
    if (lastFetchedUrlRef.current === trimmedUrl) return; // already tried

    lastFetchedUrlRef.current = trimmedUrl;
    setLoadingPreview(true);
    try {
      const preview = await startpageApi.fetchLinkPreview(vaultId, trimmedUrl);
      // Patch only the fields the preview filled, and only when
      // they're still empty on the item. A user typing into the
      // description field while the fetch is in flight shouldn't
      // get their text clobbered when the preview arrives.
      const patch: Partial<LinkItemDto> = {};
      if (preview.title && !item.title.trim()) patch.title = preview.title;
      if (preview.description && !item.description.trim()) {
        patch.description = preview.description;
      }
      if (preview.imageUrl && !item.imageUrl) patch.imageUrl = preview.imageUrl;
      if (Object.keys(patch).length > 0) onChange(patch);
    } catch {
      // Silent — preview failures are common (Cloudflare, paywalls,
      // pages without OG tags). Falling through to manual entry is
      // the right UX. Don't even log: most users won't care.
    } finally {
      setLoadingPreview(false);
    }
  }, [item.url, item.title, item.description, item.imageUrl, onChange, vaultId]);

  if (editing) {
    return (
      <div className="nc-links-row nc-links-row-editing" data-no-drag>
        <input
          type="text"
          className="nc-links-row-input nc-links-row-input-title"
          placeholder="Title"
          value={item.title}
          onChange={(e) => onChange({ title: e.target.value })}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommitEdit();
            if (e.key === 'Escape') onCommitEdit();
          }}
        />
        <input
          type="text"
          className="nc-links-row-input nc-links-row-input-desc"
          placeholder="Description (optional)"
          value={item.description}
          onChange={(e) => onChange({ description: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommitEdit();
            if (e.key === 'Escape') onCommitEdit();
          }}
        />
        <div className="nc-links-row-edit-foot">
          <input
            type="url"
            className="nc-links-row-input nc-links-row-input-url"
            placeholder="https://example.com"
            value={item.url}
            onChange={(e) => onChange({ url: e.target.value })}
            onBlur={tryAutoFill}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                // Fire the auto-fill before commit so the Enter
                // user gets the fill too (otherwise blur wouldn't
                // fire before commit closes the input).
                tryAutoFill();
                onCommitEdit();
              }
              if (e.key === 'Escape') onCommitEdit();
            }}
          />
          {loadingPreview && (
            <span
              className="nc-links-row-spinner"
              title="Fetching preview…"
              aria-label="Fetching preview"
            />
          )}
          <button
            type="button"
            className="nc-links-row-delete"
            onClick={onDelete}
            title="Delete this link"
          >
            ×
          </button>
        </div>
        {/*
          Show the fetched thumbnail in edit mode too, so the user
          sees what the preview gave them before clicking out. Small
          and below the URL row to keep the edit form compact.
        */}
        {item.imageUrl && !imgFailed && (
          <div className="nc-links-row-edit-thumb-wrap">
            <img
              className="nc-links-row-edit-thumb"
              src={item.imageUrl}
              alt=""
              onError={() => setImgFailedFor(item.imageUrl ?? '')}
            />
            <button
              type="button"
              className="nc-links-row-thumb-clear"
              onClick={() => onChange({ imageUrl: '' })}
              title="Remove this thumbnail"
              aria-label="Remove thumbnail"
            >
              ×
            </button>
          </div>
        )}
      </div>
    );
  }

  // Display mode. Behaviour forks on blockEditMode:
  //   View (blockEditMode=false): row click opens URL, no trash.
  //   Edit (blockEditMode=true):  row click enters per-row edit,
  //                                hover-trash visible.
  const openUrl = (e: React.MouseEvent) => {
    if (!item.url) return;
    e.stopPropagation();
    window.open(item.url, '_blank', 'noopener,noreferrer');
  };

  /**
   * Row click handler. In view mode, opens the URL. In edit mode,
   * promotes the row to per-row edit. The trash button has its own
   * stopPropagation so it doesn't trigger either path.
   */
  const onRowClick = (e: React.MouseEvent) => {
    if (blockEditMode) {
      onStartEdit();
    } else {
      openUrl(e);
    }
  };

  // Friendly placeholder text when title or url is empty — better
  // than rendering blank rows that look like glitches.
  const displayTitle = item.title || item.url || '(untitled link)';

  // Show the thumbnail only when we have a URL AND it hasn't been
  // marked as failed-to-load this render cycle. The image column
  // collapses entirely (no empty box) when there's nothing to show.
  const showThumb = item.imageUrl && !imgFailed;

  // Accessible label depends on what the click actually does in
  // the current mode — screen readers shouldn't say "Edit link" if
  // the row will open the URL.
  const ariaLabel = blockEditMode
    ? `Edit link: ${displayTitle}`
    : item.url
      ? `Open ${displayTitle}`
      : displayTitle;

  return (
    <div
      className={[
        'nc-links-row',
        showThumb ? 'nc-links-row-with-thumb' : '',
        blockEditMode ? '' : 'nc-links-row-view',
      ].filter(Boolean).join(' ')}
      onClick={onRowClick}
      // Make the whole row not bubble pointerdown to the header
      // drag handler. Even though it's outside the header, our
      // header wrapper currently catches via document-level
      // listeners; data-no-drag on rows keeps drag scoped to the
      // header.
      data-no-drag
      tabIndex={0}
      role="button"
      aria-label={ariaLabel}
      // Keyboard parity with click: Enter / Space invokes the same
      // mode-dependent action. Without this, keyboard users
      // couldn't open links in view mode.
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (blockEditMode) {
            onStartEdit();
          } else if (item.url) {
            window.open(item.url, '_blank', 'noopener,noreferrer');
          }
        }
      }}
    >
      {showThumb && (
        <img
          className="nc-links-row-thumb"
          src={item.imageUrl}
          alt=""
          // The image is decorative; the title carries the link
          // semantics. Empty alt + aria-hidden via the parent's
          // role="button" keeps SR's focused on the title.
          onError={() => setImgFailedFor(item.imageUrl ?? '')}
        />
      )}
      <div className="nc-links-row-text">
        <div
          className="nc-links-row-title"
          title={item.url ? `Open ${item.url}` : 'No URL set'}
        >
          {displayTitle}
        </div>
        {item.description && (
          <div className="nc-links-row-desc">{item.description}</div>
        )}
      </div>
      {/*
        Hover-visible delete — only rendered in block-level edit
        mode. View mode rows are read-only, so a trash icon there
        would be a contract violation.

        stopPropagation on the click is required: the row's outer
        onClick (in edit mode) triggers per-row edit, and we don't
        want the row to flip into edit mode at the same moment the
        user is deleting it. For rows with any content (title or
        url), we confirm first — accidental clicks on a hover-only
        button would otherwise be very easy. Empty rows skip the
        confirm; they're cheap to re-add.
      */}
      {blockEditMode && (
        <button
          type="button"
          className="nc-links-row-display-delete"
          title="Delete this link"
          aria-label="Delete this link"
          onClick={(e) => {
            e.stopPropagation();
            const hasContent =
              item.title.trim().length > 0 || item.url.trim().length > 0;
            if (hasContent) {
              const label = item.title.trim() || item.url.trim();
              // eslint-disable-next-line no-alert
              if (!window.confirm(`Delete link "${label}"?`)) return;
            }
            onDelete();
          }}
        >
          🗑
        </button>
      )}
    </div>
  );
}
