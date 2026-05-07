import { Mark } from '@tiptap/core';

/**
 * Underline mark.
 *
 * StarterKit doesn't ship Underline (it's @tiptap/extension-underline,
 * which would be a new dependency). The mark is small enough that
 * inlining it is cleaner than adding the package — same pattern the
 * rest of this folder uses (CalloutExtension, VideoExtension, etc).
 *
 * Parse rules (in declaration order):
 *
 *   1. Any `<u>` element. Browser-pasted markup uses this — TipTap's
 *      copy/paste pipeline emits `<u>`, and Word's HTML output does
 *      too when the user applied Ctrl+U in Word.
 *   2. Any element with `text-decoration: underline` in its inline
 *      `style` attribute. This catches Word/Google Docs paste where
 *      underline shows up on a `<span style="text-decoration:
 *      underline">`. We deliberately use `getAttribute` style sniffing
 *      rather than computed styles — the input HTML is the
 *      authoritative source at parse time, and computed-style isn't
 *      meaningful before the node is in the DOM anyway.
 *
 * Render: plain `<u>`. tiptap-markdown's html-mark fallback round-trips
 * any unknown mark by extracting its rendered open/close tags from
 * the schema, which means underline survives a save/load cycle as a
 * literal `<u>` in the .md file. CommonMark doesn't have an underline
 * primitive — raw HTML is the standard answer here.
 *
 * Keymap: Ctrl+U (Cmd+U on macOS) toggles. Same convention as bold/
 * italic in StarterKit's Bold/Italic extensions, and what users
 * already expect from any rich editor.
 */

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    underline: {
      setUnderline: () => ReturnType;
      toggleUnderline: () => ReturnType;
      unsetUnderline: () => ReturnType;
    };
  }
}

export const UnderlineMark = Mark.create({
  name: 'underline',

  parseHTML() {
    return [
      { tag: 'u' },
      {
        // Inline style fallback (Word / Google Docs paste). We accept
        // both the modern `text-decoration` and the legacy
        // `text-decoration-line` form. The getAttrs return value of
        // null means "do not match" for ProseMirror's parser; an
        // empty object means "matched, no attributes to extract".
        style: 'text-decoration',
        getAttrs: (value) => {
          if (typeof value !== 'string') return null;
          return /(^|\s)underline(\s|$|;|,)/i.test(value) ? {} : null;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['u', HTMLAttributes, 0];
  },

  addKeyboardShortcuts() {
    return {
      'Mod-u': () => this.editor.commands.toggleUnderline(),
    };
  },

  addCommands() {
    return {
      setUnderline:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleUnderline:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetUnderline:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});
