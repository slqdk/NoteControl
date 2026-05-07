import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';

import { ApiError, notesApi, templatesApi } from '../api/client';
import { refreshTemplates } from '../editor/templateCache';
import { showToast } from '../utils/toast';
import { FONT_OPTIONS, fontStackToId } from './EditableNoteAppearance';

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
 * Layout: two rows.
 *
 *   Row 1 — per-selection mark toggles:
 *     Bold | Italic | Underline | inline Code | Link | (Save as template)
 *
 *   Row 2 — note-level + colour + defaults (only when
 *     showAppearanceControls is true):
 *     Font ▼ | Size ▼ | colour swatches | Defaults
 *
 *   Font and Size are NOTE-LEVEL: changing them in the popup
 *   writes to the note's frontmatter (same shape as the
 *   properties panel). They're intentionally not per-selection
 *   marks — markdown notes pollute fast if every paragraph can
 *   carry its own font-family span. Colour IS per-selection, via
 *   the ColorMark; that's the one piece of inline styling that
 *   genuinely earns the on-disk cost of an inline span.
 *
 *   Defaults clears the selection's colour mark AND, if the
 *   selection covers the whole document, clears the note's per-
 *   note font + fontSize so the global defaults take over.
 *   "Selection covers the whole document" is the only safe
 *   trigger for note-level resets, since the user might be
 *   trying to "reset just this paragraph" and only the colour
 *   reset can honour that — note font/size has no per-paragraph
 *   counterpart.
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
  /**
   * When true, render the second row (Font / Size / colour /
   * Defaults). The TemplateEditor passes false because templates
   * have no frontmatter — there's no per-note appearance for
   * Font/Size to write to. Colour-only mode could still make
   * sense for templates eventually, but is out of scope for the
   * first cut: keeping the entire row hidden in TemplateEditor
   * keeps the wiring obvious.
   */
  showAppearanceControls?: boolean;
  /**
   * Current note font stack (verbatim from frontmatter, null when
   * the note has no override). Drives the Font dropdown's
   * displayed value. Updates live as the user changes the field
   * elsewhere (properties panel) since the parent re-renders.
   */
  currentNoteFont?: string | null;
  /**
   * Current note font size in pixels (verbatim from frontmatter,
   * null when the note has no override). Drives the Size dropdown.
   */
  currentNoteFontSize?: number | null;
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

// Estimated rendered toolbar height.
//
// Used to decide whether "above" placement would clip behind the
// topbar; not used for rendering (CSS handles that). Bumped from
// the previous 36 to 76 because the menu is now two rows tall when
// showAppearanceControls is true. The single-row template-editor
// case slightly over-estimates, which means we'll prefer "below"
// placement a few extra pixels earlier — harmless. If precise
// placement matters more later, switch to a measurement-via-ref
// pattern.
const TOOLBAR_HEIGHT_ESTIMATE = 76;

// Fallback minimum-top clamp for when no .nc-topbar exists in the
// DOM (e.g. tests, future embeddings). Slightly inset from the
// viewport top so the toolbar isn't kissing the screen edge.
const FALLBACK_TOP_INSET = 8;

// Estimated rendered toolbar width. Used only for clamping the
// horizontal anchor so the toolbar doesn't slide off-screen on
// narrow viewports. Two rows: row 1 is ~180px, row 2 (with all
// controls) is ~360px. We use the wider one for the clamp so the
// menu never slides off either edge regardless of which row is
// visually widest.
const TOOLBAR_WIDTH_ESTIMATE = 380;

// Colour palette for the inline ColorMark. Eight named slots —
// enough to flag a TODO red, mark a quote blue, highlight a
// caveat amber, etc., without being a full colour picker.
//
// Hex values picked for OK contrast on both light and dark
// backgrounds (no neon, no near-black). The ⊘ "no colour" option
// doesn't live in this list — it's a dedicated button that calls
// unsetColor.
const COLOUR_PALETTE: ReadonlyArray<{ hex: string; label: string }> = [
  { hex: '#1f2937', label: 'Default text' },        // near-black
  { hex: '#dc2626', label: 'Red' },
  { hex: '#ea580c', label: 'Orange' },
  { hex: '#ca8a04', label: 'Amber' },
  { hex: '#16a34a', label: 'Green' },
  { hex: '#0891b2', label: 'Teal' },
  { hex: '#2563eb', label: 'Blue' },
  { hex: '#9333ea', label: 'Purple' },
];

// Font sizes offered in the size dropdown. Mirrors the per-note
// FontSize range used elsewhere (10..32). We don't list every
// integer — round step of 1 between the most-used sizes plus a
// few jumps near the extremes keeps the dropdown manageable.
const FONT_SIZE_OPTIONS: ReadonlyArray<number> = [
  10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28, 32,
];

export function BubbleMenu({
  editor,
  vaultId,
  getNotePath,
  showAppearanceControls,
  currentNoteFont,
  currentNoteFontSize,
}: BubbleMenuProps) {
  const [active, setActive] = useState(false);
  const [position, setPosition] = useState<BubblePosition | null>(null);

  // Ref to the menu's root div, used by update() to keep the menu
  // visible when focus has moved INTO the menu itself (e.g. the
  // user clicked the Font <select>, which steals focus from the
  // editor). Without this check, hasFocus() would flip to false
  // the instant a dropdown opens and the menu would unmount mid-
  // pick. Set via the ref attribute on the root div below.
  const menuRef = useRef<HTMLDivElement | null>(null);

  // "User is currently mousedown-ing the menu" flag. Set on
  // mousedown over any descendant of the menu, cleared on the
  // global mouseup that ends that gesture. While true, update()
  // refuses to hide the menu — even if the editor blurs and
  // document.activeElement flits to <body> mid-transition (which
  // happens for native <select> dropdowns on some browsers), the
  // menu stays put until the user finishes their click.
  //
  // A ref (not state) because we don't need a re-render when it
  // flips — update() reads it directly from the closure on the
  // next event tick.
  const interactingRef = useRef(false);

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

  // The colour palette opens on click. Closed by default; closes
  // again after a swatch is picked or on outside click. We don't
  // also auto-close on selection change because the user may be
  // adjusting a multi-line range and expects the palette to stay
  // open across re-positions.
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Saving spinner for the note-level Font/Size writes. Gated on
  // a single boolean since the saves are sequential — the popup
  // doesn't try to fire two in flight at once.
  const [savingNoteAppearance, setSavingNoteAppearance] = useState(false);

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
      //
      // EXCEPTIONS — keep the menu visible when:
      //
      //   1. The user is currently mid-click on the menu itself
      //      (interactingRef). Set on mousedown anywhere inside the
      //      menu, cleared on the global mouseup. This is the only
      //      reliable signal across browsers — document.activeElement
      //      is unreliable during a native <select> dropdown's
      //      transition (it can briefly read as <body>), so a
      //      hasFocus-only check would unmount the menu mid-pick.
      //
      //   2. Focus has settled inside the menu (focusInsideMenu) —
      //      e.g. the select keeps focus while its dropdown is open
      //      on some browsers. Belt-and-braces with rule 1.
      const focusedEl = document.activeElement as HTMLElement | null;
      const focusInsideMenu =
        !!focusedEl && !!menuRef.current && menuRef.current.contains(focusedEl);
      const isInteracting = interactingRef.current;
      if (!editor.view.hasFocus() && !focusInsideMenu && !isInteracting) {
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
    // might shift positions; focus covers the editor regaining
    // focus.
    //
    // Blur is special: at the moment a 'blur' event fires,
    // document.activeElement hasn't necessarily moved to its new
    // home yet (browser timing varies). If we run update()
    // immediately, hasFocus is false AND focusInsideMenu reads as
    // false (because the new focus target — e.g. a <select> in
    // our menu — hasn't been recorded yet). The menu would
    // unmount mid-click. Defer blur-driven updates to the next
    // tick via requestAnimationFrame so the activeElement check
    // sees the settled focus.
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    function focusUpdate() {
      // Editor regaining focus = the user is back in the editor,
      // not interacting with the menu. Clear the flag so a
      // subsequent click outside the editor can hide the menu
      // normally. Without this, the flag would stick on after the
      // first dropdown pick and the menu would never auto-hide
      // again.
      interactingRef.current = false;
      update();
    }
    editor.on('focus', focusUpdate);
    function deferredBlurUpdate() {
      requestAnimationFrame(() => {
        // interactingRef is set on menu mousedown; if the user is
        // mid-click on the menu, even rAF may not be enough — the
        // dropdown can stay open across multiple frames. Skip the
        // hide entirely while interacting; a later selectionUpdate
        // (or focus event when the editor regains focus) will run
        // update() with proper state.
        if (interactingRef.current) return;
        update();
      });
    }
    editor.on('blur', deferredBlurUpdate);

    // Belt-and-braces: clear interactingRef on any window mouseup
    // so the flag can't get stuck if the user mousedowns on the
    // menu but then moves the mouse off and releases. mouseup
    // fires reliably on the document for in-window releases. For
    // a release outside the OS window we never get the event, but
    // the next focus-flip into the editor will clear it via the
    // focusUpdate handler above.
    function onWindowMouseUp() {
      interactingRef.current = false;
    }
    window.addEventListener('mouseup', onWindowMouseUp);

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
      editor.off('focus', focusUpdate);
      editor.off('blur', deferredBlurUpdate);
      window.removeEventListener('scroll', update, { capture: true });
      window.removeEventListener('resize', update);
      window.removeEventListener('mouseup', onWindowMouseUp);
      if (vv) {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      }
    };
  }, [editor]);

  // Close the colour palette when the menu hides (active flips off)
  // or the editor hands focus elsewhere. Without this, picking a
  // colour, then clicking outside the editor, would leave the
  // palette stuck open the next time a selection brings the menu
  // back.
  useEffect(() => {
    if (!active) setPaletteOpen(false);
  }, [active]);

  // ---- Note-level Font / Size save -----------------------------------
  //
  // Same shape as PropertiesPanel's saveAppearance — call notesApi.update
  // with `body: <current markdown>` plus the changed field, then
  // dispatch nc:note-appearance-changed so the open editor picks up
  // the new value without a remount.
  const saveNoteAppearance = useCallback(
    async (
      field: 'font' | 'fontSize',
      value: string | number,
    ) => {
      if (!editor || !vaultId || !getNotePath) return;
      const path = getNotePath();
      if (!path) return;
      // Read the editor's CURRENT in-memory body so the field write
      // doesn't accidentally roll back unsaved keystrokes.
      // editor.storage.markdown.getMarkdown() is the same source the
      // autosave uses.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const md = (editor.storage as any).markdown?.getMarkdown?.();
      if (typeof md !== 'string') {
        showToast('Could not read note body.');
        return;
      }
      const patch =
        field === 'font'
          ? { body: md, font: value as string }
          : { body: md, fontSize: value as number };
      setSavingNoteAppearance(true);
      try {
        await notesApi.update(vaultId, path, patch);
        // The editor's appearance state listens for this event and
        // re-renders the note's font/size live.
        window.dispatchEvent(
          new CustomEvent('nc:note-appearance-changed', {
            detail: { path, field, value },
          }),
        );
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : 'Could not save note appearance.';
        showToast(msg, 5000);
      } finally {
        setSavingNoteAppearance(false);
      }
    },
    [editor, vaultId, getNotePath],
  );

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
  const toggleUnderline = () => {
    // toggleUnderline is provided by UnderlineMark. If the extension
    // isn't registered (shouldn't happen — both NoteEditor and
    // TemplateEditor register it), the chain step silently no-ops
    // rather than throwing.
    editor.chain().focus().toggleUnderline().run();
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

  // ---- Colour mark handlers ------------------------------------------

  const handleColourPick = (hex: string) => {
    editor.chain().focus().setColor(hex).run();
    setPaletteOpen(false);
  };

  const handleColourClear = () => {
    editor.chain().focus().unsetColor().run();
    setPaletteOpen(false);
  };

  // ---- Defaults handler ----------------------------------------------
  //
  // "Defaults" has two effects, in order:
  //
  //   1. Strip the selection's colour mark — same as ⊘ in the
  //      palette, but always (even if the palette is closed).
  //
  //   2. If the selection covers the entire document AND the note
  //      has per-note Font/FontSize set, clear those frontmatter
  //      fields so the global defaults take over.
  //
  // The whole-document gate exists because there's no per-paragraph
  // Font/FontSize granularity — clearing them mid-selection would
  // affect the whole note, which is surprising. Restricting the
  // reset to "user has explicitly selected everything" matches the
  // mental model: "make my entire note use the defaults again".
  // Users with a partial selection still get the colour cleared,
  // which is the most common ask anyway.
  const handleDefaults = () => {
    // Step 1 — colour mark
    editor.chain().focus().unsetColor().run();

    // Step 2 — note-level reset, only if selection covers the doc
    // (or close enough — ProseMirror's whole-doc range includes the
    // start/end document edges, so we test inclusive of those).
    const { from, to } = editor.state.selection;
    const docSize = editor.state.doc.content.size;
    const coversWholeDoc = from <= 1 && to >= docSize - 1;

    if (!coversWholeDoc) return;
    if (!showAppearanceControls || !vaultId || !getNotePath) return;

    // Fire-and-forget the two saves. saveNoteAppearance handles its
    // own busy/toast state. We send empty-string / 0 sentinels per
    // the API contract: those tell the server "remove this field
    // from frontmatter".
    if (currentNoteFont) {
      void saveNoteAppearance('font', '');
    }
    if (currentNoteFontSize) {
      void saveNoteAppearance('fontSize', 0);
    }
  };

  // Pre-compute active states so each button can show its
  // pressed/depressed style. Read once per render — cheap.
  const isBold = editor.isActive('bold');
  const isItalic = editor.isActive('italic');
  const isUnderline = editor.isActive('underline');
  const isCode = editor.isActive('code');
  const isLink = editor.isActive('link');
  const activeColour =
    (editor.getAttributes('nccolor') as { color?: string | null } | undefined)?.color ?? null;

  // Selected ids for the dropdowns. Both fall back to '' when the
  // note has no override, which selects the (Default) option.
  const selectedFontId = fontStackToId(currentNoteFont ?? null);
  const selectedFontSize = currentNoteFontSize ?? 0;

  return (
    <div
      ref={menuRef}
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
      //
      // EXCEPT for native <select> and <input> — those need the
      // real mousedown to open their dropdown / show a caret. With
      // preventDefault swallowing the mousedown, clicks on the
      // Font and Size dropdowns simply did nothing. We still
      // preventDefault for buttons because their onClick already
      // calls editor.chain().focus() to restore focus + selection
      // explicitly (TipTap's chain remembers the last selection
      // across the focus loss), so swallowing mousedown there is
      // safe AND keeps the menu from disappearing mid-click.
      //
      // Why only on the root, not per-element: the root catches
      // mousedown on the empty padding/borders of the menu (where
      // there's no specific control) which we DO want to swallow.
      // The closest-check below threads the needle: native
      // controls work, dead space stays sticky.
      //
      // Also: flip interactingRef ON. The global mouseup listener
      // (registered in the visibility useEffect) flips it back OFF.
      // While the flag is set, update() refuses to hide the menu —
      // so the editor losing focus to a <select>'s dropdown can't
      // unmount the menu before the click completes.
      onMouseDown={(e) => {
        interactingRef.current = true;
        const t = e.target as HTMLElement | null;
        if (t && t.closest('select, input')) return;
        e.preventDefault();
      }}
    >
      {/* Row 1 — selection-mark toggles */}
      <div className="nc-bubble-row">
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
          className={isUnderline ? 'nc-bubble-button nc-bubble-button-active' : 'nc-bubble-button'}
          onClick={toggleUnderline}
          title="Underline (Ctrl+U)"
        >
          <u>U</u>
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

      {/* Row 2 — note-level appearance + colour + Defaults.
          Hidden in the TemplateEditor (templates have no
          frontmatter font/size to write to). */}
      {showAppearanceControls && (
        <div className="nc-bubble-row nc-bubble-row-secondary">
          {/* Font dropdown — sets the note's frontmatter font.
              Curated stack list shared with EditableNoteAppearance
              so the popup and the properties panel agree on the
              available options. The "Default" entry sends an empty
              string, which the server interprets as "clear the
              field" — the resolver then falls through to the global
              default. */}
          <select
            className="nc-bubble-select"
            value={selectedFontId}
            onChange={(e) => {
              const opt = FONT_OPTIONS.find((f) => f.id === e.currentTarget.value);
              if (!opt) return;
              void saveNoteAppearance('font', opt.stack);
              // The user has finished interacting with the menu.
              // Clear the flag so a later focus shift away from the
              // editor can hide the menu normally.
              interactingRef.current = false;
              // Restore focus to the editor so the user's prior
              // selection is visible again and they can keep
              // formatting without re-selecting. TipTap's chain
              // remembers the last selection across the focus
              // round-trip via the select dropdown.
              editor.chain().focus().run();
            }}
            disabled={savingNoteAppearance}
            title="Note font"
            aria-label="Note font"
          >
            {FONT_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>

          {/* Font size dropdown — sets the note's frontmatter
              fontSize. The "(default)" option sends 0, which the
              server reads as "remove the key" — the resolver then
              uses the global default. */}
          <select
            className="nc-bubble-select nc-bubble-select-narrow"
            value={selectedFontSize === 0 ? '' : String(selectedFontSize)}
            onChange={(e) => {
              const v = e.currentTarget.value;
              if (v === '') {
                void saveNoteAppearance('fontSize', 0);
              } else {
                const n = parseInt(v, 10);
                if (Number.isFinite(n)) {
                  void saveNoteAppearance('fontSize', n);
                }
              }
              // Same flag-clear + focus restoration as the Font
              // dropdown — see comment there.
              interactingRef.current = false;
              editor.chain().focus().run();
            }}
            disabled={savingNoteAppearance}
            title="Note font size"
            aria-label="Note font size"
          >
            <option value="">size</option>
            {FONT_SIZE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s} px
              </option>
            ))}
          </select>

          <span className="nc-bubble-divider" aria-hidden="true" />

          {/* Colour swatch button + popover palette. The button
              shows the currently-applied colour as its swatch, or
              a black "A" letter when nothing is applied. Clicking
              toggles the palette open. */}
          <div className="nc-bubble-colour">
            <button
              type="button"
              className={paletteOpen ? 'nc-bubble-button nc-bubble-button-active' : 'nc-bubble-button'}
              onClick={() => setPaletteOpen((open) => !open)}
              title={activeColour ? `Text colour: ${activeColour}` : 'Text colour'}
              aria-haspopup="true"
              aria-expanded={paletteOpen}
            >
              <span
                className="nc-bubble-colour-letter"
                style={{ color: activeColour ?? 'inherit' }}
              >
                A
              </span>
            </button>
            {paletteOpen && (
              <div className="nc-bubble-palette" role="menu">
                {COLOUR_PALETTE.map((c) => (
                  <button
                    key={c.hex}
                    type="button"
                    className="nc-bubble-swatch"
                    style={{ background: c.hex }}
                    onClick={() => handleColourPick(c.hex)}
                    title={c.label}
                    aria-label={c.label}
                  />
                ))}
                <button
                  type="button"
                  className="nc-bubble-swatch nc-bubble-swatch-clear"
                  onClick={handleColourClear}
                  title="Remove text colour"
                  aria-label="Remove text colour"
                >
                  ⊘
                </button>
              </div>
            )}
          </div>

          <span className="nc-bubble-divider" aria-hidden="true" />

          {/* Defaults — clears the selection's colour, AND if the
              selection covers the whole document, clears the
              note's per-note Font/FontSize. Tooltip leans into
              the colour case since that's the more common
              partial-selection scenario. */}
          <button
            type="button"
            className="nc-bubble-button nc-bubble-button-defaults"
            onClick={handleDefaults}
            disabled={savingNoteAppearance}
            title="Clear formatting on the selection (and reset note Font/Size if the whole note is selected)"
          >
            Defaults
          </button>
        </div>
      )}
    </div>
  );
}
