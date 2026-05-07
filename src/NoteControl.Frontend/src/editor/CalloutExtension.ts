import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';

import { CalloutNodeView } from '../components/CalloutNodeView';

/**
 * Callout / admonition block.
 *
 * Five variants — error (red), warning (yellow), info (blue),
 * tip (green), note (gray). Each renders as a coloured box with
 * an icon, holding arbitrary block content (paragraphs, lists,
 * code blocks etc.) — but NOT nested callouts (kept flat for
 * visual clarity + editorial sanity).
 *
 * Markdown round-trip uses RAW HTML:
 *
 *   <div class="nc-callout nc-callout-error" data-variant="error">
 *
 *   Body paragraphs as markdown
 *
 *   </div>
 *
 * Why not GitHub admonition syntax (> [!ERROR])? tiptap-markdown's
 * upstream markdown-it doesn't recognise it natively, so on save
 * + reload the callout would degrade to a blockquote with literal
 * "[!ERROR]" text. The HTML form parses back via our parseHTML
 * rule below, reliably.
 *
 * Plain markdown viewers that render HTML will see the styled
 * box; ones that strip HTML will see the body text only. That's
 * an acceptable fallback for export workflows.
 */

export type CalloutVariant = 'error' | 'warning' | 'info' | 'tip' | 'note';

export const CALLOUT_VARIANTS: readonly CalloutVariant[] = [
  'error',
  'warning',
  'info',
  'tip',
  'note',
];

export interface CalloutOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Insert an empty callout of the given variant at the cursor. */
      insertCallout: (variant: CalloutVariant) => ReturnType;
      /** Change the variant of the current callout (no-op if not in one). */
      setCalloutVariant: (variant: CalloutVariant) => ReturnType;
    };
  }
}

export const CalloutExtension = Node.create<CalloutOptions>({
  name: 'callout',

  group: 'block',
  // Block-level content. Originally I set isolating + defining
  // flags to prevent selection crossing the boundary, but those
  // can interfere with cursor placement on click. Plain block+
  // works fine — ProseMirror handles in/out navigation.
  content: 'block+',

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      variant: {
        default: 'note' as CalloutVariant,
        parseHTML: (element) => {
          // Try data-variant first (our own emission), then look
          // for any of our nc-callout-{variant} classes.
          const dv = element.getAttribute('data-variant');
          if (dv && (CALLOUT_VARIANTS as readonly string[]).includes(dv)) {
            return dv as CalloutVariant;
          }
          for (const v of CALLOUT_VARIANTS) {
            if (element.classList.contains(`nc-callout-${v}`)) return v;
          }
          return 'note';
        },
        renderHTML: (attributes) => {
          const v = (attributes.variant as CalloutVariant) ?? 'note';
          return {
            'data-variant': v,
            class: `nc-callout nc-callout-${v}`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div',
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          // Only match if it has our callout class. Other divs
          // pass through to the default block parser.
          if (!el.classList.contains('nc-callout')) return false;
          return null;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      0,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutNodeView);
  },

  /**
   * Commands exposed to the editor — wired into the slash menu.
   *
   *   insertCallout(variant)   — insert empty callout of given variant
   *                              with one empty paragraph inside, and
   *                              place the cursor inside that paragraph
   *                              so the user can immediately start
   *                              typing the body content
   *   setCalloutVariant(variant) — change variant of containing callout
   */
  addCommands() {
    return {
      insertCallout:
        (variant: CalloutVariant) =>
        ({ editor, chain }) => {
          // Insert the callout with an empty paragraph inside,
          // PLUS an empty paragraph after it so the user has a
          // clickable line below the callout to escape into.
          // Without that trailing paragraph there's nothing
          // beneath the callout to click — the cursor is trapped
          // unless they arrow-down out of the body.
          //
          // Cursor placement: after insertContent runs, we move
          // the selection INTO the callout's empty paragraph so
          // the user can immediately type the body content.
          //
          //   <pos before>           ← from
          //   <callout>              ← from
          //     <paragraph>          ← from + 1
          //                          ← from + 2  (cursor lands here)
          //   </callout>
          //   <paragraph/>           ← trailing (clickable line below)
          //
          // The trailing paragraph isn't added when the callout
          // already has content following it — but for fresh
          // insertion via the slash menu, the cursor is at the
          // end of an empty doc segment, so we always emit it.
          const from = editor.state.selection.from;
          return chain()
            .insertContent([
              {
                type: this.name,
                attrs: { variant },
                content: [{ type: 'paragraph' }],
              },
              { type: 'paragraph' },
            ])
            .setTextSelection(from + 2)
            .run();
        },
      setCalloutVariant:
        (variant: CalloutVariant) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { variant }),
    };
  },

  /**
   * Markdown round-trip via tiptap-markdown's storage hook.
   *
   * Serialisation strategy: emit raw HTML.
   *
   * I considered GitHub admonition syntax (> [!ERROR]) but
   * tiptap-markdown's upstream markdown-it doesn't recognise it
   * natively — so on save+reload the callout would degrade to a
   * blockquote. Raw HTML round-trips reliably via our parseHTML
   * rule above.
   *
   * The HTML is intentionally simple:
   *
   *   <div class="nc-callout nc-callout-error" data-variant="error">
   *
   *   ...rendered child blocks as markdown...
   *
   *   </div>
   *
   * BLANK LINES MATTER. CommonMark only switches the parser back
   * to block-mode markdown inside a raw HTML block after a blank
   * line. Without one, the inner text is treated as raw HTML and
   * `**bold**` survives as literal asterisks instead of becoming
   * a <strong>. The earlier version of this serializer used
   * `state.write('') ; state.ensureNewLine()` to try to emit the
   * gap, but `write('')` is a no-op and `ensureNewLine` is
   * idempotent at line start, so the result was a single newline
   * (no blank line) and the body never round-tripped formatting.
   * Now we emit `\n\n` after the open tag and before the close.
   *
   * Plain markdown viewers will render the inner content as HTML
   * (most do); ones that strip HTML will see the body text only.
   * Acceptable trade-off for v1.
   */
  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            renderContent: (n: unknown) => void;
            write: (s: string) => void;
            ensureNewLine: () => void;
            closeBlock: (n: unknown) => void;
          },
          node: { attrs: Record<string, unknown> },
        ) {
          const variant = ((node.attrs.variant as string) ?? 'note').toLowerCase();

          // Open the wrapping div, followed by a newline + blank
          // line. The blank line is the one that puts markdown-it
          // back in block mode for the body content.
          state.write(
            `<div class="nc-callout nc-callout-${variant}" data-variant="${variant}">`,
          );
          state.ensureNewLine();
          // Literal '\n' to ACTUALLY emit a blank line. (write('')
          // and ensureNewLine alone don't — the latter is a no-op
          // when already at line start.) See top-of-method comment.
          state.write('\n');

          state.renderContent(node);

          // Close: ensure we're at line start, then a blank line,
          // then the closing tag. The blank line on this side is
          // belt-and-braces — markdown-it accepts the close tag
          // at the start of a line either way, but symmetric
          // spacing keeps the on-disk markdown readable and matches
          // the open side.
          state.ensureNewLine();
          state.write('\n');
          state.write('</div>');
          state.closeBlock(node);
        },
      },
    };
  },
});
