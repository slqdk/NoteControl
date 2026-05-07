import { Mark } from '@tiptap/core';

/**
 * Per-selection font size mark.
 *
 * The bubble menu's Size dropdown applies this mark; the Defaults
 * button removes it. Renders as `<span style="font-size: …px">…</span>`,
 * round-tripped through markdown as raw HTML via tiptap-markdown's
 * html-mark fallback.
 *
 * Why a dedicated mark — see FontFamilyMark.ts for the full
 * rationale. Same approach: single attribute, tight parse rules,
 * clean stacking with the other inline marks (bold, italic,
 * underline, strike, link, code, colour, font-family).
 *
 * On-disk shape:
 *   <span style="font-size: 14px">word</span>
 *
 * Parse rules:
 *   - `<span>` whose inline style has font-size
 *   - legacy `<font size="…">` (Word/Outlook paste). Translates
 *     the legacy 1..7 size to a px equivalent — Word's size 3
 *     (medium) is roughly 13px; we round to integers below.
 *
 * The paste normalizer strips `font-size` from incoming HTML so
 * Word's sizes don't leak in by default. The legacy <font size>
 * attribute is also stripped by the normalizer's <font>
 * cleanup. So in practice these parse rules only fire on:
 *   1. Markdown round-trip (re-loading a saved note)
 *   2. Internal copy/paste between notes
 */

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    ncsize: {
      setFontSize: (px: number) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
  }
}

// Word's <font size="N"> mapping. Approximate but close enough for
// the rare round-trip case where this fires. Modern <span style>
// is the canonical encoding.
const LEGACY_SIZE_PX: Record<string, number> = {
  '1': 10,
  '2': 12,
  '3': 13,
  '4': 16,
  '5': 18,
  '6': 24,
  '7': 32,
};

export const FontSizeMark = Mark.create({
  name: 'ncsize',
  excludes: '',

  addAttributes() {
    return {
      size: {
        // Stored as a px integer — we always render as `<size>px`.
        default: null,
        parseHTML: (el) => {
          if (!(el instanceof HTMLElement)) return null;
          const direct = el.style?.fontSize;
          if (direct) {
            // Common shapes: "14px", "1.2em", "small". We only
            // honour px-based sizes; em / keyword fall through
            // (mark won't be applied) since we have no way to
            // resolve those without a layout context.
            const m = /^(\d+(?:\.\d+)?)\s*px$/i.exec(direct.trim());
            if (m) return Math.round(Number(m[1]));
            return null;
          }
          const legacy = el.getAttribute('size');
          if (legacy && LEGACY_SIZE_PX[legacy] != null) {
            return LEGACY_SIZE_PX[legacy];
          }
          return null;
        },
        renderHTML: (attrs) => {
          const s = (attrs as { size: number | null }).size;
          if (s == null) return {};
          return { style: `font-size: ${s}px` };
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
          // Only match px-encoded font-size — em / keyword / %
          // we deliberately don't capture (mark won't apply, the
          // styling stays in the raw HTML and won't survive
          // markdown round-trip cleanly anyway).
          const fs = node.style?.fontSize;
          if (!fs) return false;
          return /^\d+(?:\.\d+)?\s*px$/i.test(fs.trim()) ? {} : false;
        },
      },
      {
        tag: 'font[size]',
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const sz = node.getAttribute('size');
          return sz && LEGACY_SIZE_PX[sz] != null ? {} : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0];
  },

  addCommands() {
    return {
      setFontSize:
        (px: number) =>
        ({ chain }) =>
          chain().setMark(this.name, { size: px }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain().unsetMark(this.name).run(),
    };
  },
});
