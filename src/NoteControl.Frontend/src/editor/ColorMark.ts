import { Mark } from '@tiptap/core';

/**
 * Per-selection text colour mark.
 *
 * The popup's colour swatches apply this mark; the "Defaults" button
 * removes it. Renders as `<span style="color: …">…</span>`, which is
 * how tiptap-markdown's html-mark fallback round-trips it through the
 * .md file on disk (markdown has no native colour primitive — raw
 * HTML is the only honest answer).
 *
 * Why not `@tiptap/extension-color`? That package depends on
 * `@tiptap/extension-text-style` and adds a TextStyle mark that
 * carries multiple style attributes (color, font-family, font-size,
 * background, …) on a single span. We'd inherit all of that whether
 * we want it or not, and the matching parseHTML rules then pick up
 * any inline-styled span the user pastes — which fights the paste
 * normalizer that's the whole point of this Ship.
 *
 * A dedicated single-attribute mark keeps the parse surface tight:
 * we ONLY recognize a span when it has a `color` style and nothing
 * else interesting (or wrapped in a `<font color>`); we never
 * accidentally scoop up a Word `font-family` declaration just because
 * it sits on the same span.
 *
 * On-disk shape:
 *   <span style="color: #c0392b">danger word</span>
 *
 * Parse:
 *   - any `<span style="color: X">` — we extract X verbatim
 *   - the legacy `<font color="X">` — same, for Word/Outlook paste
 *
 * If the parser sees `<span style="color: …; font-family: …">`, it
 * matches our color rule for the colour but the paste normalizer
 * (PasteNormalizeExtension) has already stripped font-family/size on
 * the way in — so the residual span is colour-only by the time it
 * reaches the schema. Belt-and-braces, since the parse rule wouldn't
 * touch font-family anyway.
 */

export interface ColorAttrs {
  color: string | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    nccolor: {
      setColor: (color: string) => ReturnType;
      unsetColor: () => ReturnType;
    };
  }
}

export const ColorMark = Mark.create({
  name: 'nccolor',

  // Allow this mark to coexist with bold/italic/underline/strike on
  // the same range. Default behaviour for marks already permits
  // multiple types, but spelling it out via `excludes: ''` makes it
  // explicit that colour and (say) bold can stack — pasting bold red
  // text keeps both marks.
  excludes: '',

  addAttributes() {
    return {
      color: {
        default: null,
        // Read from the rendered element (style.color) on parse, write
        // it into the inline `style` attribute on render.
        parseHTML: (el) => {
          // ProseMirror's parser hands us either an HTMLElement (when
          // the parse rule was `tag` or `style`) — `style` access is
          // safe in either case because we only get here for matched
          // spans / fonts.
          if (!(el instanceof HTMLElement)) return null;
          const direct = el.style?.color;
          if (direct) return direct;
          // Legacy `<font color="…">`.
          const fontAttr = el.getAttribute('color');
          return fontAttr || null;
        },
        renderHTML: (attrs) => {
          const c = (attrs as ColorAttrs).color;
          if (!c) return {};
          return { style: `color: ${c}` };
        },
      },
    };
  },

  parseHTML() {
    return [
      // Match any span that has a colour style. The actual extraction
      // of the colour value is in the attribute's parseHTML above.
      // Returning null from getAttrs vetoes the match; returning {}
      // accepts it. We veto when the span has no colour at all so we
      // don't capture a plain decorative span as a Color mark.
      {
        tag: 'span',
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false;
          return node.style?.color ? {} : false;
        },
      },
      // Legacy Word/Outlook tag.
      {
        tag: 'font[color]',
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false;
          return node.getAttribute('color') ? {} : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    // The `color` attribute already produced `{ style: 'color: …' }`
    // via its renderHTML; mergeAttributes-style spread happens in
    // TipTap's outer machinery. We just pass through.
    return ['span', HTMLAttributes, 0];
  },

  addCommands() {
    return {
      setColor:
        (color: string) =>
        ({ chain }) =>
          chain().setMark(this.name, { color }).run(),
      unsetColor:
        () =>
        ({ chain }) =>
          chain().unsetMark(this.name).run(),
    };
  },
});
