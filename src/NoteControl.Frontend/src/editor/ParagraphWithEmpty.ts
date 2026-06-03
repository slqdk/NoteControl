import { Paragraph } from '@tiptap/extension-paragraph';

/**
 * Paragraph node that round-trips empty paragraphs through markdown.
 *
 * Background — why this exists:
 *   The default prosemirror-markdown serializer writes a paragraph
 *   by emitting its inline content followed by a block separator.
 *   An empty paragraph has no inline content, so the serializer
 *   writes nothing for it. Multiple empty paragraphs in a row
 *   collapse on disk to a single `\n\n` separator, and on the next
 *   load the parser cannot tell that any of them ever existed —
 *   they vanish. Users press Enter several times to add vertical
 *   spacing, see what they want in the editor, save, reload the
 *   note (open it on another device, navigate away and back, switch
 *   to and from the archive viewer), and the spacing has collapsed.
 *
 * Fix:
 *   For empty paragraphs only, emit a single zero-width space
 *   (U+200B, "ZWSP") as the paragraph's content before the block
 *   separator. The ZWSP is:
 *     - invisible when rendered (zero width), so the line still
 *       looks blank to the user,
 *     - preserved by markdown-it during parsing (a line with ZWSP
 *       is not treated as a blank line, so the paragraph survives),
 *     - preserved by ProseMirror's DOMParser when the HTML comes
 *       back as <p>\u200B</p>.
 *
 *   The companion strip pass in src/markdown/zwsp.ts removes ZWSPs
 *   from lines that AREN'T placeholder-only — so when the user
 *   types into a previously-empty paragraph, the next save doesn't
 *   leave a ZWSP at the start of the content line.
 *
 * Why a custom extension instead of patching tiptap-markdown:
 *   tiptap-markdown's MarkdownSerializer reads each node extension's
 *   `storage.markdown.serialize` via getMarkdownSpec, which spreads
 *   the bundled default UNDER the extension's spec. Providing our
 *   own serialize on an extension named "paragraph" wins via that
 *   spread — same mechanism TableWithOptions uses for pipe-vs-HTML
 *   table serialization. We deliberately don't include `parse`
 *   here; the bundled parse handles markdown-it → DOM correctly,
 *   and clobbering it would break the editor's load path.
 *
 * Priority:
 *   Default extension priority in TipTap is 100. We bump to 1000 so
 *   our paragraph definitively wins over both StarterKit's bundled
 *   paragraph and tiptap-markdown's wrapper when the extension
 *   manager merges by name.
 *
 * Caveat:
 *   On disk, empty lines become "\u200B" lines. Viewed in vi or
 *   another text editor, the ZWSP is invisible but takes one byte
 *   (actually three, since UTF-8 encodes U+200B as E2 80 8B) per
 *   line. Other markdown tools opening these files will see the
 *   ZWSP characters; well-behaved parsers will treat them as
 *   regular paragraph content (matching our intent).
 */

const EMPTY_PARAGRAPH_PLACEHOLDER = '\u200B';

export const ParagraphWithEmpty = Paragraph.extend({
  priority: 1000,

  addStorage() {
    const parentStorage = (this.parent?.() ?? {}) as Record<string, unknown>;
    return {
      ...parentStorage,
      markdown: {
        // Types are `unknown` because prosemirror-markdown's
        // MarkdownSerializerState isn't re-exported with usable
        // types from tiptap-markdown — same situation as
        // TableWithOptions, see its addStorage comment.
        serialize(
          state: { write: (s: string) => void; renderInline: (n: unknown) => void; closeBlock: (n: unknown) => void },
          node: { content: { size: number } },
        ) {
          if (node.content.size === 0) {
            state.write(EMPTY_PARAGRAPH_PLACEHOLDER);
          } else {
            state.renderInline(node);
          }
          state.closeBlock(node);
        },
      },
    };
  },
});
