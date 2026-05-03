import Image from '@tiptap/extension-image';
import { ReactNodeViewRenderer } from '@tiptap/react';

import { ImageNodeView } from '../components/ImageNodeView';

/**
 * Extends the standard TipTap Image extension with extra attributes
 * the user can edit through the in-editor controls:
 *
 *   width   — pixels, optional. Set by drag-resize handles.
 *   border  — boolean. Toggleable from the floating toolbar.
 *
 * Why a custom node and not just CSS? Because:
 *   - The width has to survive save → load → save (the markdown on
 *     disk needs to encode the size). We emit raw HTML in the
 *     serialiser when any of these attributes differ from defaults,
 *     and CommonMark accepts inline HTML transparently.
 *   - The user wants per-image control (one bordered, one not),
 *     which requires per-node attributes — CSS classes alone can't
 *     do that on data that round-trips through plain markdown.
 *
 * The renderHTML config below is what actually emits the right
 * attributes on the DOM, and tiptap-markdown's serialiser falls
 * back to "render the node as HTML" whenever the markdown rule
 * for an image can't capture all the attributes — exactly the
 * behaviour we want.
 */
export const ImageWithControls = Image.extend({
  name: 'image',

  // Keep the same defaults as the upstream Image extension we replaced.
  // Block-level (not inline) so an image always sits on its own line —
  // matches Notion / Obsidian conventions.
  inline: false,
  group: 'block',
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      // Pull in the parent's attributes (src, alt, title) so we
      // don't re-implement them, then add our own.
      ...this.parent?.(),

      width: {
        default: null,
        parseHTML: (element) => {
          // Width can come from either the explicit width attribute
          // or an inline style. Prefer the attribute since it's what
          // we emit on save.
          const attr = element.getAttribute('width');
          if (attr) {
            const n = parseInt(attr, 10);
            return Number.isFinite(n) ? n : null;
          }
          const style = element.style.width;
          if (style && style.endsWith('px')) {
            const n = parseInt(style, 10);
            return Number.isFinite(n) ? n : null;
          }
          return null;
        },
        renderHTML: (attributes) => {
          if (!attributes.width) return {};
          return {
            width: attributes.width,
            style: `width: ${attributes.width}px; height: auto;`,
          };
        },
      },

      border: {
        default: false,
        parseHTML: (element) => {
          // Mirror the class we set on save.
          return element.classList.contains('nc-img-bordered');
        },
        renderHTML: (attributes) => {
          if (!attributes.border) return {};
          return { class: 'nc-img-bordered' };
        },
      },
    };
  },

  /**
   * Custom markdown serialiser. tiptap-markdown's default image rule
   * only emits `![alt](src "title")` and silently drops any other
   * attributes — including our width and border. To preserve those
   * across save/reload we override the serialiser and emit raw HTML
   * `<img>` whenever width or border has a non-default value.
   *
   * For the common case (no resize, no border), we keep the standard
   * `![]()` syntax so the markdown stays clean and readable in any
   * other markdown viewer.
   *
   * The `parse` side is handled by the upstream parser plus our
   * `parseHTML` config above — markdown-it parses inline HTML and
   * passes the resulting DOM through tiptap's HTML parser, which
   * picks up our width/border attrs from the rendered `<img>` tag.
   */
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write: (s: string) => void; closeBlock: (n: unknown) => void; esc: (s: string) => string },
          node: { attrs: Record<string, unknown> },
        ) {
          const width = node.attrs.width as number | null;
          const border = node.attrs.border as boolean;
          const src = (node.attrs.src as string) ?? '';
          const alt = (node.attrs.alt as string) ?? '';
          const title = (node.attrs.title as string) ?? '';

          if (width || border) {
            // Emit raw HTML. Building the tag manually rather than via
            // a DOM API because we need the exact format that round-
            // trips back through parseHTML cleanly.
            const parts: string[] = ['<img'];
            parts.push(` src="${escapeAttr(src)}"`);
            if (alt) parts.push(` alt="${escapeAttr(alt)}"`);
            if (title) parts.push(` title="${escapeAttr(title)}"`);
            if (width) {
              parts.push(` width="${width}"`);
              parts.push(` style="width: ${width}px; height: auto;"`);
            }
            if (border) {
              parts.push(' class="nc-img-bordered"');
            }
            parts.push(' />');
            state.write(parts.join(''));
          } else {
            // Standard CommonMark image syntax. Note the title is
            // wrapped in quotes inside the parens: ![alt](src "title")
            const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : '';
            state.write(`![${state.esc(alt)}](${src}${titlePart})`);
          }
          state.closeBlock(node);
        },
        parse: {
          // No custom parse rules — the parent's parseHTML/markdown-it
          // image rule handles both the markdown and HTML forms.
        },
      },
    };
  },

  // Render the React-based node view that hosts the image plus
  // its overlay controls (resize handles, toolbar). The node view
  // takes over rendering inside the editor; tiptap-markdown still
  // serialises via the addStorage().markdown hook above.
  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
});

/**
 * Minimal HTML attribute value escaping for the markdown serialiser.
 * Just enough to produce a valid round-trippable tag — escapes the
 * five XML metacharacters. We don't try to be a full HTML escaper
 * because the inputs (asset paths, alt text the user typed) are
 * already constrained.
 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');
}
