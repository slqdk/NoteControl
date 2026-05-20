import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';

import { MathNodeView } from '../components/MathNodeView';

/**
 * Math (LaTeX / KaTeX) nodes for the editor.
 *
 * Two flavours:
 *
 *   - mathInline : an inline atom node (no editable content). Sits
 *                  inside paragraphs and list items like a fancy
 *                  word. Renders as a single line of math.
 *
 *   - mathBlock  : a block atom node. Sits at block level (between
 *                  paragraphs). Renders display-style math
 *                  (centred, larger).
 *
 * Both store the LaTeX source in a `latex` attribute. The on-DOM
 * rendering — actually invoking KaTeX — is done by the React
 * NodeView (MathNodeView) so we can attach a hover/click affordance
 * that opens the edit popover without fighting ProseMirror's view
 * lifecycle.
 *
 * --- Markdown round-trip ---
 *
 * Serialize: each math node writes itself back as a dollar-form
 * delimiter pair, regardless of which delimiter style the source
 * arrived in. See ./mathParser.ts for the rationale.
 *
 *   mathInline  →  `$<latex>$`
 *   mathBlock   →  standalone `$$\n<latex>\n$$` block (closeBlock
 *                  gives us the blank-line separation either side).
 *
 * Parse from markdown: handled BEFORE tiptap-markdown sees the
 * text, in a pre-process pass (./mathParser.ts) that rewrites
 * `$$..$$` / `$..$` / `\[..\]` / `\(..\)` as `<div data-math-block>`
 * / `<span data-math-inline>` HTML placeholders. tiptap-markdown's
 * `html: true` setting lets these placeholders survive parsing
 * intact, and the parseHTML rules below pick them up as math
 * nodes. Same path is used by the paste interceptor.
 *
 * --- TipTap node semantics ---
 *
 * Both nodes are `atom: true` (ProseMirror treats them as opaque —
 * cursor moves over them as a single unit, content is not editable
 * inline). The actual LaTeX is edited through the popover, not by
 * typing into the node. This is the same pattern Notion uses and
 * the standard approach for tiptap-mathematics / @aarkue/tiptap-
 * math-extension etc., which we deliberately don't use because
 * NoteControl's markdown round-trip needs custom serializer hooks
 * those packages don't expose cleanly.
 */

export interface MathOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    math: {
      /** Insert a block math node at the cursor with the given LaTeX source. */
      insertMathBlock: (latex: string) => ReturnType;
      /** Insert an inline math node at the cursor with the given LaTeX source. */
      insertMathInline: (latex: string) => ReturnType;
      /** Replace the LaTeX of the currently-selected math node (block or inline). */
      updateMathLatex: (latex: string) => ReturnType;
    };
  }
}

/**
 * Inline math node. Lives inside `inline` content (paragraphs,
 * list items, table cells, etc.). Has no child content — the
 * LaTeX source is on the `latex` attribute only.
 */
export const MathInline = Node.create<MathOptions>({
  name: 'mathInline',

  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-math-inline') ?? '',
        renderHTML: (attrs) => ({
          'data-math-inline': (attrs.latex as string) ?? '',
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-math-inline]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    // The renderHTML output is what tiptap-markdown's HTML
    // fallback would emit if our markdown serializer below
    // weren't registered. The serializer ALWAYS wins for the
    // markdown path; this renderHTML matters only for the
    // browser DOM (and the clipboard HTML when someone copies).
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: 'nc-math-inline',
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView, {
      // Inline atom: must render inline-level in the outer DOM
      // so it sits next to surrounding text, not on its own line.
      as: 'span',
    });
  },

  /**
   * Commands. insertMathInline + updateMathLatex (shared with
   * block, but we only need to declare it once — TipTap unions
   * commands from all extensions, but declaring on both is
   * harmless because both implementations do the same thing
   * through updateAttributes).
   */
  addCommands() {
    return {
      insertMathInline:
        (latex: string) =>
        ({ chain }) => {
          return chain()
            .insertContent({
              type: 'mathInline',
              attrs: { latex },
            })
            .run();
        },
      updateMathLatex:
        (latex: string) =>
        ({ editor, commands }) => {
          // Look at the current selection — if it's pointing at
          // a math node, update via updateAttributes. NodeSelection
          // is the case where the user clicked the math node (the
          // node view sets selection.node when clicked). The other
          // case (Selection just before an inline math atom) is
          // less common; we fall through to the generic block
          // updater which handles it.
          const sel = editor.state.selection;
          const nodeAfter = sel.$anchor.nodeAfter;
          if (nodeAfter?.type.name === 'mathInline') {
            return commands.updateAttributes('mathInline', { latex });
          }
          if (nodeAfter?.type.name === 'mathBlock') {
            return commands.updateAttributes('mathBlock', { latex });
          }
          // NodeSelection case — selection.node() resolves to the
          // math node directly. updateAttributes uses the selection
          // node when present.
          if (editor.isActive('mathInline')) {
            return commands.updateAttributes('mathInline', { latex });
          }
          if (editor.isActive('mathBlock')) {
            return commands.updateAttributes('mathBlock', { latex });
          }
          return false;
        },
    };
  },

  /**
   * Ctrl+Shift+M / Cmd+Shift+M — insert an empty inline math node
   * at the cursor. The freshly inserted node's MathNodeView sees
   * `latex===''` on mount and auto-opens the edit popover, so the
   * user lands directly in the source textarea.
   *
   * Single-key path for the "I want to type math right now"
   * gesture. Block math intentionally has no shortcut — the slash
   * menu's "/math" item is the path for it, and a `Ctrl+Shift+Alt+M`
   * combo would be fiddly enough to not be worth the mental load.
   */
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-m': () => {
        return this.editor.chain().focus().insertMathInline('').run();
      },
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write: (s: string) => void },
          node: { attrs: Record<string, unknown> },
        ) {
          const latex = ((node.attrs.latex as string) ?? '').trim();
          // Empty math nodes get dropped entirely — emitting `$$`
          // back to disk would re-parse on next load as the start
          // of an unclosed block math and corrupt later content.
          if (latex === '') return;
          state.write('$' + latex + '$');
        },
        parse: {
          // Pre-processing rewrites `$...$` to HTML before
          // markdown-it sees it; parseHTML above picks it up.
        },
      },
    };
  },
});

/**
 * Block math node. Lives at block level (between paragraphs etc.).
 * Same atom semantics as inline.
 */
export const MathBlock = Node.create<MathOptions>({
  name: 'mathBlock',

  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-math-block') ?? '',
        renderHTML: (attrs) => ({
          'data-math-block': (attrs.latex as string) ?? '',
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-math-block]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: 'nc-math-block',
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView, {
      as: 'div',
    });
  },

  addCommands() {
    return {
      insertMathBlock:
        (latex: string) =>
        ({ chain }) => {
          // Insert the block math followed by an empty paragraph,
          // and place the cursor on the math node so the popover
          // (if the host opens it post-insert) targets it. The
          // trailing paragraph matches the callout/table convention
          // so the user has a clickable line below; TrailingParagraph
          // also guarantees one survives save/load.
          return chain()
            .insertContent([
              {
                type: 'mathBlock',
                attrs: { latex },
              },
              { type: 'paragraph' },
            ])
            .run();
        },
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            write: (s: string) => void;
            ensureNewLine: () => void;
            closeBlock: (n: unknown) => void;
          },
          node: { attrs: Record<string, unknown> },
        ) {
          const latex = ((node.attrs.latex as string) ?? '').trim();
          if (latex === '') {
            // Empty block math: drop it. Saving `$$\n\n$$` would
            // re-parse as a block whose source is whitespace-only
            // and get rejected; the result would be silent loss
            // of the empty block on reload. Drop now to make the
            // behaviour explicit at save time.
            return;
          }
          // Pandoc / Obsidian convention: each delimiter on its
          // own line, source between them. closeBlock gives the
          // surrounding blank-line separation.
          state.write('$$\n');
          state.write(latex);
          state.ensureNewLine();
          state.write('$$');
          state.closeBlock(node);
        },
        parse: {
          // Same pre-process path as inline math.
        },
      },
    };
  },
});

/**
 * Bundle export. Add `...MathExtension` to your TipTap extensions
 * list to register both math nodes plus their commands.
 */
export const MathExtension = [MathInline, MathBlock] as const;
