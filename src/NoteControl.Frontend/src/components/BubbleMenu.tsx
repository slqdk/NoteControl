import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';

import { ApiError, templatesApi } from '../api/client';
import { refreshTemplates } from '../editor/templateCache';
import { showToast } from '../utils/toast';

/**
 * Floating formatting toolbar that appears above any text selection.
 *
 * Visibility rules:
 *   - Selection must be non-empty
 *   - Selection must span at least 2 characters (avoids the menu
 *     popping up on a stray click that landed in a tiny range)
 *   - Selection must NOT be inside a code block — inline marks
 *     (bold, italic, code, link) don't apply inside fenced code,
 *     so the menu would offer no-ops
 *   - Editor must be focused / editable
 *
 * Position model:
 *   Computed from the selection's bounding rect via
 *   `editor.view.coordsAtPos`. Toolbar floats just above the
 *   selection's top edge, horizontally centered on its midpoint.
 *   We use `position: fixed` (viewport-relative) so the toolbar
 *   stays visible when the user scrolls within a long note.
 *
 * Why not @tiptap/extension-bubble-menu? It depends on tippy.js,
 * which would be a new dependency, and the positioning logic is
 * really maybe 30 lines. The codebase's TableToolbar follows the
 * same hand-rolled pattern (subscribe to selectionUpdate +
 * transaction, compute position from a DOM rect) and the
 * consistency is worth more than tippy's polish for a four-button
 * toolbar.
 *
 * Buttons offered: Bold, Italic, inline Code, Link, and (Ship 98b,
 * note-editor only) "Save as template". Headings and strikethrough
 * are deliberately excluded:
 *   - Headings are block-level — turning a paragraph into H2
 *     affects the whole paragraph, which is confusing UI for a
 *     selection-driven menu.
 *   - Strikethrough mark isn't part of StarterKit and would need
 *     its own extension.
 *
 * The "Save as template" button only renders when the BubbleMenu is
 * given both `vaultId` and `getNotePath` props (i.e. it's mounted
 * inside the NoteEditor, not the TemplateEditor — saving a template
 * selection as a new template would be confusing recursion).
 */
export interface BubbleMenuProps {
  editor: Editor | null;
  /**
   * Ship 98b: when both of these are present, the bubble menu shows
   * a "Save as template" button. Both are required because the
   * server endpoint needs the source note path to resolve image
   * references, and the API call needs the vault id. The
   * TemplateEditor mounts BubbleMenu without these props so the
   * extra button doesn't appear there.
   */
  vaultId?: string;
  getNotePath?: () => string;
}

/**
 * Position + placement of the toolbar.
 *
 * Ship 83: added `placement`. Originally we always rendered above
 * the selection (transform: translateY(-100%)). On mobile, when the
 * selection sits in the upper part of the viewport, "above" lands
 * the toolbar behind the topbar or off-screen entirely. We now flip
 * to render BELOW the selection when there isn't enough room above.
 *
 * Desktop usually has plenty of room above the selection, but the
 * same logic applies — picking "below" anywhere it'd otherwise
 * be hidden is a strict improvement.
 */
interface BubblePosition {
  top: number;
  left: number;
  placement: 'above' | 'below';
}

const MIN_SELECTION_CHARS = 2;
// Distance in pixels between the selection's top/bottom edge and
// the toolbar's adjacent edge. Keep small so the visual link to
// the selection is obvious; not 0 because some viewers run text
// underline through the selection's top.
const VERTICAL_GAP = 8;

// Estimated rendered toolbar height. Used to decide whether
// "above" placement would clip behind the topbar; not used for
// rendering (CSS handles that). Bubble menu height is stable
// (one row of buttons) so a constant is fine. If the menu ever
// grows multi-row, switch to a measurement-via-ref pattern.
const TOOLBAR_HEIGHT_ESTIMATE = 36;

// Fallback minimum-top clamp for when no .nc-topbar exists in the
// DOM (e.g. tests, future embeddings). Slightly inset from the
// viewport top so the toolbar isn't kissing the screen edge.
const FALLBACK_TOP_INSET = 8;

// Estimated rendered toolbar width. Used only for clamping the
// horizontal anchor so the toolbar doesn't slide off-screen on
// narrow viewports. Bubble menu has 4 buttons + dividers; 200px
// is a safe upper bound.
const TOOLBAR_WIDTH_ESTIMATE = 200;

export function BubbleMenu({ editor, vaultId, getNotePath }: BubbleMenuProps) {
  const [active, setActive] = useState(false);
  const [position, setPosition] = useState<BubblePosition | null>(null);

  // Ship 98b: busy state for "save selection as template". Hoisted
  // up here (alongside the other useState calls) and BEFORE any
  // conditional early returns so the hook is always called in the
  // same order on every render — React's rules of hooks. An earlier
  // version of this file declared this useState lower down, after
  // the `if (!editor || !active || !position) return null;` guard,
  // which meant the hook was conditionally invoked depending on
  // selection state. Result: as soon as the user selected text the
  // hook count jumped from N to N+1, React threw "rendered more
  // hooks than during the previous render", and the editor went
  // blank until F5.
  const [savingAsTemplate, setSavingAsTemplate] = useState(false);

  // Recompute visibility + position from the editor's current state
  // and the selection's bounding rect. Called on every selection
  // change AND on window scroll/resize so the toolbar stays
  // anchored as the user moves the page underneath it.
  useEffect(() => {
    if (!editor) return;

    function update() {
      if (!editor) return;

      // Bail out fast if the editor isn't focused — selection state
      // may be stale and we don't want the toolbar appearing for a
      // selection in an inactive editor (e.g. user clicked away to
      // focus the breadcrumb input).
      if (!editor.view.hasFocus()) {
        setActive(false);
        return;
      }

      const { state } = editor;
      const { selection } = state;
      const { from, to, empty } = selection;

      if (empty || (to - from) < MIN_SELECTION_CHARS) {
        setActive(false);
        return;
      }

      // Skip when the selection is inside a code block. The inline
      // marks we offer (bold, italic, code, link) are not applicable
      // there — code blocks render verbatim. isActive handles both
      // cursor-inside and selection-inside-block cases.
      if (editor.isActive('codeBlock')) {
        setActive(false);
        return;
      }

      // Bounding rect of the selection. coordsAtPos returns
      // viewport coordinates (left/top/right/bottom), one call per
      // endpoint. We span from min-top (highest point of the start
      // line) to max-anything for horizontal centering.
      let startCoords: { top: number; left: number; bottom: number };
      let endCoords: { top: number; left: number; right: number; bottom: number };
      try {
        startCoords = editor.view.coordsAtPos(from);
        endCoords = editor.view.coordsAtPos(to);
      } catch {
        // coordsAtPos can throw mid-transaction if the position is
        // briefly out of bounds. Hide rather than crash; the next
        // event will likely succeed.
        setActive(false);
        return;
      }

      // For a multi-line selection, pin the toolbar to the first
      // line's top so it doesn't jump around as the user extends
      // the selection downward. Horizontally center on the start-
      // to-end midpoint of the FIRST line — using endCoords.left
      // when the selection wraps would put the toolbar somewhere
      // strange (left edge of the next line).
      const isSingleLine = Math.abs(startCoords.top - endCoords.top) < 4;
      const horizontalAnchor = isSingleLine
        ? (startCoords.left + endCoords.right) / 2
        : startCoords.left + 80;  // arbitrary offset for multi-line

      // Ship 83: clamp the horizontal anchor so the toolbar can't
      // slide off-screen on a narrow viewport. The render uses
      // translateX(-50%) on the anchor, so the toolbar's left edge
      // ends up at (anchor - width/2). To keep both edges visible
      // we constrain the anchor to [width/2, viewport - width/2].
      // On viewports narrower than the toolbar itself this clamp
      // can make the toolbar slightly extend past one side; that's
      // accepted (better than being half off-screen).
      const halfWidth = TOOLBAR_WIDTH_ESTIMATE / 2;
      const minLeft = halfWidth + 4;
      const maxLeft = window.innerWidth - halfWidth - 4;
      const clampedLeft = Math.min(Math.max(horizontalAnchor, minLeft), maxLeft);

      // Ship 83: pick "above" or "below" placement based on whether
      // the toolbar would clip behind the topbar (or the viewport
      // top if the topbar isn't in the DOM for some reason).
      // .nc-topbar is sticky in normal app rendering so this read
      // is constant-time. If we're in a context without a topbar,
      // fall back to a small inset.
      const topbarEl = document.querySelector('.nc-topbar') as HTMLElement | null;
      const minVisibleTop = topbarEl
        ? topbarEl.getBoundingClientRect().bottom + 4
        : FALLBACK_TOP_INSET;
      const wouldClipAbove =
        startCoords.top - VERTICAL_GAP - TOOLBAR_HEIGHT_ESTIMATE < minVisibleTop;
      const placement: 'above' | 'below' = wouldClipAbove ? 'below' : 'above';

      // Anchor depends on placement:
      //   above: top edge of selection - gap (toolbar bottom-aligns
      //          here via translateY(-100%) in render)
      //   below: bottom edge of the FIRST line of selection + gap
      //          (toolbar top-aligns here, no translateY needed).
      //          We deliberately use startCoords.bottom not
      //          endCoords.bottom: for a multi-line selection,
      //          anchoring to the LAST line's bottom would put the
      //          toolbar far from the user's interaction point.
      //          First-line-bottom keeps the toolbar visually
      //          attached to where the selection began.
      let top =
        placement === 'above'
          ? startCoords.top - VERTICAL_GAP
          : startCoords.bottom + VERTICAL_GAP;

      // Ship 85: clamp the toolbar's bottom edge to the visualViewport
      // bottom so the soft keyboard can't hide it.
      //
      // The visualViewport on iOS Safari and most Android browsers
      // shrinks when the keyboard appears; the layout viewport
      // (where position:fixed anchors) does NOT. Without this
      // clamp, the toolbar can render in the area covered by the
      // keyboard and become invisible.
      //
      // For 'above' placement, top = toolbar's BOTTOM edge (because
      // the render uses translateY(-100%)). Clamp directly to the
      // visible bottom minus a small inset.
      //
      // For 'below' placement, top = toolbar's TOP edge. Clamp so
      // top + estimatedHeight ≤ visible bottom.
      const vv = window.visualViewport;
      const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      const topMax =
        placement === 'above'
          ? visibleBottom - 4
          : visibleBottom - TOOLBAR_HEIGHT_ESTIMATE - 4;
      if (top > topMax) {
        top = topMax;
      }

      setPosition({ top, left: clampedLeft, placement });
      setActive(true);
    }

    // Subscribe to the events that affect selection or document
    // structure. selectionUpdate covers caret movement and
    // selection extension; transaction covers content edits that
    // might shift positions; focus/blur cover the editor losing
    // focus to e.g. the breadcrumb.
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    editor.on('focus', update);
    editor.on('blur', update);

    // Window scroll/resize: viewport coordinates change, so the
    // toolbar needs to re-anchor. Passive scroll listener — we
    // never call preventDefault.
    window.addEventListener('scroll', update, { passive: true, capture: true });
    window.addEventListener('resize', update);

    // Ship 85: visualViewport changes (soft keyboard show/hide,
    // mobile URL bar collapse, iOS Safari toolbar transitions)
    // don't fire window.resize on iOS — only visualViewport.resize.
    // Also subscribe to visualViewport.scroll which fires when the
    // user pinch-zooms or the viewport shifts. Both feed into the
    // same update() so the keyboard-aware clamp recomputes.
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    }

    update();

    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
      editor.off('focus', update);
      editor.off('blur', update);
      window.removeEventListener('scroll', update, { capture: true });
      window.removeEventListener('resize', update);
      if (vv) {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      }
    };
  }, [editor]);

  if (!editor || !active || !position) return null;

  // ---- Action handlers ---------------------------------------------------
  // All four use chain().focus().X().run() so the editor regains
  // focus after the click (the button itself stole it). focus()
  // before the toggle ensures the selection is preserved when the
  // mark is applied.

  const toggleBold = () => {
    editor.chain().focus().toggleBold().run();
  };
  const toggleItalic = () => {
    editor.chain().focus().toggleItalic().run();
  };
  const toggleInlineCode = () => {
    editor.chain().focus().toggleCode().run();
  };

  /**
   * Link button. If the selection is already linked, unset the
   * link. Otherwise prompt for a URL and set it. We use
   * window.prompt — same simple-but-effective pattern the slash
   * menu's link command uses elsewhere in this app. A real dialog
   * with a paste-aware URL field is a future polish.
   */
  const handleLink = () => {
    if (editor.isActive('link')) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    // eslint-disable-next-line no-alert
    const href = window.prompt('Link URL:');
    if (href === null) return;        // user cancelled
    const trimmed = href.trim();
    if (trimmed === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().setLink({ href: trimmed }).run();
  };

  /*
   * Ship 98b: "Save selection as template".
   *
   * Slice out the current selection's markdown using the same
   * serializer the auto-save flow uses (tiptap-markdown's
   * MarkdownSerializer.serialize), then POST it to the server.
   *
   * The serializer accepts any ProseMirror Node — we pass a sub-doc
   * created via `state.doc.cut(from, to)` which preserves block
   * structure (lists, callouts, code blocks, tables) within the
   * selected range. A flat plain-text join would lose all that.
   *
   * State: a busy flag prevents double-submit if the user
   * impatiently double-clicks. The toast acknowledges success;
   * errors get their own (longer) toast.
   *
   * Note: the `savingAsTemplate` useState is declared at the top
   * of the component, NOT here — it must be called unconditionally
   * on every render (React rules of hooks). `showSaveAsTemplate` is
   * a derived value, safe to compute here since it's not a hook.
   */
  const showSaveAsTemplate = !!vaultId && !!getNotePath;

  const handleSaveAsTemplate = async () => {
    if (!showSaveAsTemplate) return;     // shouldn't happen — button is hidden
    if (savingAsTemplate) return;        // double-click guard

    const { from, to, empty } = editor.state.selection;
    if (empty || from === to) return;    // nothing selected

    // tiptap-markdown exposes its serializer on editor.storage.markdown.
    // editor.state.doc.cut returns a NEW doc node containing the
    // sliced content; the serializer can stringify any Node.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const markdownStorage = (editor.storage as any).markdown;
    if (!markdownStorage?.serializer) {
      // Should be impossible — both NoteEditor and TemplateEditor
      // register the markdown extension. Bail loudly via toast so
      // the user isn't left wondering why nothing happened.
      showToast('Could not serialise selection.');
      return;
    }
    let markdown: string;
    try {
      const slice = editor.state.doc.cut(from, to);
      markdown = markdownStorage.serializer.serialize(slice) as string;
    } catch {
      showToast('Could not serialise selection.');
      return;
    }
    if (!markdown.trim()) {
      // Selection was structurally empty (e.g. just whitespace).
      showToast('Selection is empty.');
      return;
    }

    setSavingAsTemplate(true);
    try {
      const sourceNotePath = getNotePath!();
      if (!sourceNotePath) {
        showToast('Cannot save template: note path missing.');
        return;
      }
      const dto = await templatesApi.createFromSelection(
        vaultId!,
        sourceNotePath,
        markdown,
      );
      // Immediately refresh the slash-menu cache so the new
      // template is usable in this and other open editors.
      void refreshTemplates(vaultId!);
      showToast(`Template saved: ${dto.name}`);
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : 'Could not save template.';
      showToast(msg, 5000);
    } finally {
      setSavingAsTemplate(false);
    }
  };

  // Pre-compute active states so each button can show its
  // pressed/depressed style. Read once per render — cheap.
  const isBold = editor.isActive('bold');
  const isItalic = editor.isActive('italic');
  const isCode = editor.isActive('code');
  const isLink = editor.isActive('link');

  return (
    <div
      className="nc-bubble-menu"
      style={{
        // translateX(-50%) horizontally centers the menu on the
        // anchor point. For 'above' placement, translateY(-100%)
        // flips it ABOVE the anchor so the menu's BOTTOM edge sits
        // at the gap-offset top of the selection. For 'below'
        // placement, translateY(0) leaves the menu's TOP edge at
        // the gap-offset bottom of the selection.
        position: 'fixed',
        top: `${position.top}px`,
        left: `${position.left}px`,
        transform:
          position.placement === 'above'
            ? 'translate(-50%, -100%)'
            : 'translate(-50%, 0)',
        zIndex: 1000,
      }}
      // Prevent the menu from stealing focus from the editor when
      // the user mouses down on it. Without this, mousedown clears
      // the selection before the click handler runs, so the
      // toggle*() commands act on an empty range.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className={isBold ? 'nc-bubble-button nc-bubble-button-active' : 'nc-bubble-button'}
        onClick={toggleBold}
        title="Bold (Ctrl+B)"
      >
        <strong>B</strong>
      </button>
      <button
        type="button"
        className={isItalic ? 'nc-bubble-button nc-bubble-button-active' : 'nc-bubble-button'}
        onClick={toggleItalic}
        title="Italic (Ctrl+I)"
      >
        <em>I</em>
      </button>
      <button
        type="button"
        className={isCode ? 'nc-bubble-button nc-bubble-button-active' : 'nc-bubble-button'}
        onClick={toggleInlineCode}
        title="Inline code (Ctrl+E)"
      >
        <code>{'<>'}</code>
      </button>
      <button
        type="button"
        className={isLink ? 'nc-bubble-button nc-bubble-button-active' : 'nc-bubble-button'}
        onClick={handleLink}
        title={isLink ? 'Remove link' : 'Add link'}
      >
        🔗
      </button>
      {showSaveAsTemplate && (
        <button
          type="button"
          className="nc-bubble-button"
          onClick={() => void handleSaveAsTemplate()}
          disabled={savingAsTemplate}
          title="Save selection as template"
        >
          {savingAsTemplate ? '⏳' : '📋'}
        </button>
      )}
    </div>
  );
}
