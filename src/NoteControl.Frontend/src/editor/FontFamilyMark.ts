import { Mark } from '@tiptap/core';

/**
 * Per-selection font family mark.
 *
 * The bubble menu's Font dropdown applies this mark; the Defaults
 * button removes it. Renders as `<span style="font-family: …">…</span>`,
 * round-tripped through markdown as raw HTML via tiptap-markdown's
 * html-mark fallback.
 *
 * Why a dedicated single-attribute mark and not @tiptap/extension-
 * font-family + @tiptap/extension-text-style? The TextStyle approach
 * carries multiple style attributes on a single span, and adds
 * generous parseHTML rules that scoop up almost any inline-styled
 * span we encounter. That fights the paste normalizer (which only
 * wants the USER's own clicks to apply font/size/colour, not
 * pasted styling). A dedicated single-attribute mark with a tight
 * parse rule keeps the contract clean: only spans that look
 * specifically like our own font-family marks are matched.
 *
 * On-disk shape:
 *   <span style="font-family: Inter, system-ui, sans-serif">word</span>
 *
 * Parse rules:
 *   - `<span>` whose inline style has font-family
 *   - legacy `<font face="…">`  (Word/Outlook paste, mostly)
 *
 * The paste normalizer strips `font-family` from incoming HTML
 * before ProseMirror's parser runs, so practically these parse
 * rules only fire on:
 *   1. Markdown round-trip (loading a note Claude saved earlier)
 *   2. Internal copy/paste between notes within NoteControl
 *
 * If the parser sees a span with multiple inline styles
 * (e.g. font-family + color + bold via font-weight), the marks
 * stack — TipTap creates one mark per type — so a span styled in
 * Word as bold + Calibri will, after paste-normalisation, end up
 * as Bold-only (font stripped). Pasted from another NoteControl
 * note (where styles weren't stripped), it'd come through as
 * FontFamily + Color + bold marks all applied to the same range,
 * which is the round-trip we want.
 *
 * Stacking with sibling marks: marks default to non-exclusive,
 * which is what we want — font + size + colour + bold + italic
 * + underline can all coexist on the same character. We spell it
 * out via `excludes: ''` to be explicit.
 */

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    ncfont: {
      setFontFamily: (font: string) => ReturnType;
      unsetFontFamily: () => ReturnType;
    };
  }
}

export const FontFamilyMark = Mark.create({
  name: 'ncfont',
  excludes: '',

  addAttributes() {
    return {
      font: {
        default: null,
        parseHTML: (el) => {
          if (!(el instanceof HTMLElement)) return null;
          const direct = el.style?.fontFamily;
          if (direct) return direct;
          // Legacy <font face="…">
          const face = el.getAttribute('face');
          return face || null;
        },
        renderHTML: (attrs) => {
          const f = (attrs as { font: string | null }).font;
          if (!f) return {};
          return { style: `font-family: ${f}` };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span',
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false;
          return node.style?.fontFamily ? {} : false;
        },
      },
      {
        tag: 'font[face]',
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false;
          return node.getAttribute('face') ? {} : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0];
  },

  addCommands() {
    return {
      setFontFamily:
        (font: string) =>
        ({ chain }) =>
          chain().setMark(this.name, { font }).run(),
      unsetFontFamily:
        () =>
        ({ chain }) =>
          chain().unsetMark(this.name).run(),
    };
  },
});
