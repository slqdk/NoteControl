import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { common, createLowlight } from 'lowlight';

import { CodeBlockNodeView } from '../components/CodeBlockNodeView';
import structuredText from './structuredText';

/**
 * Code block extension for NoteControl.
 *
 * Three additions on top of the standard CodeBlockLowlight:
 *   1. An editable <c>title</c> attribute (default "code") that
 *      renders as a small caption above the code area.
 *   2. Tab and Shift-Tab insert/remove indentation (4 spaces)
 *      instead of moving keyboard focus.
 *   3. IEC 61131-3 Structured Text / TwinCAT 3 syntax highlighting,
 *      registered with the alias "st" and used as the default
 *      language for new code blocks.
 *
 * Why CodeBlockLowlight + lowlight + highlight.js? Because lowlight
 * is the standard highlight.js wrapper used in TipTap, and it
 * accepts custom languages registered via `lowlight.register`.
 * highlight.js doesn't ship Structured Text, so we contribute our
 * own grammar (see `./structuredText.ts`).
 *
 * On round-trip: when title === default ("code") AND language is
 * one of the well-known set, we serialise as the standard fenced
 * code block with the language slot
 *
 *   ```st
 *   IF foo THEN ... END_IF
 *   ```
 *
 * When the title is non-default, we emit raw HTML
 * <pre data-title="..."><code class="language-st">...</code></pre>
 * which still parses back cleanly. Markdown viewers that don't
 * understand "st" will just render the body without highlighting.
 */
const DEFAULT_TITLE = 'code';
const DEFAULT_LANGUAGE = 'st';

// One lowlight instance for the whole app. We pre-register the
// "common" set (~30 popular languages) plus our custom ST grammar.
const lowlight = createLowlight(common);
lowlight.register('st', structuredText);

export const CodeBlockWithTitle = CodeBlockLowlight.extend({
  name: 'codeBlock',

  addAttributes() {
    return {
      ...this.parent?.(),

      title: {
        default: DEFAULT_TITLE,
        parseHTML: (element) => {
          const dataTitle = element.getAttribute('data-title');
          if (dataTitle) return dataTitle;
          const pre = element.tagName === 'PRE' ? element : element.closest('pre');
          if (pre) {
            const t = pre.getAttribute('data-title');
            if (t) return t;
          }
          return DEFAULT_TITLE;
        },
        renderHTML: (attributes) => {
          const t = attributes.title || DEFAULT_TITLE;
          if (t === DEFAULT_TITLE) return {};
          return { 'data-title': t };
        },
      },
    };
  },

  /**
   * Tab / Shift-Tab handlers. Without these, Tab inside a code
   * block moves keyboard focus out of the editor (browser default
   * for contenteditable inside a focusable parent), which is
   * surprising — every IDE and most online code editors expect
   * Tab to indent.
   *
   * We insert 4 spaces (matching TwinCAT 3's default indent).
   * Shift-Tab removes up to 4 leading spaces from the LINE
   * containing the cursor — not the start of the whole code block.
   */
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Tab: ({ editor }) => {
        if (!editor.isActive(this.name)) return false;
        editor.commands.insertContent('    ');
        return true;
      },
      'Shift-Tab': ({ editor }) => {
        if (!editor.isActive(this.name)) return false;
        // Remove up to 4 leading spaces from the line containing
        // the cursor. Done at the prosemirror-transaction level
        // because TipTap commands don't have a built-in "outdent
        // line" for code blocks.
        //
        // Implementation note (was buggy until this version):
        // a code block in ProseMirror is one node containing one
        // flat text node. `$from.parentOffset` is the character
        // offset within that text — measured from the start of
        // the code block, NOT from the start of the current line.
        // Earlier code treated the two as equivalent, so Shift-Tab
        // only outdented the FIRST line of the block. Fix is to
        // find the previous `\n` in the parent's textContent and
        // measure the line start from there.
        const { state, view } = editor;
        const { from } = state.selection;
        const $from = state.doc.resolve(from);
        const parentText = $from.parent.textContent;
        const parentOffset = $from.parentOffset;

        // Document position of the parent's first character.
        const contentStart = from - parentOffset;

        // Index of the line start within parentText (0-indexed).
        const prevNewline = parentText.lastIndexOf('\n', parentOffset - 1);
        const lineStartInText = prevNewline === -1 ? 0 : prevNewline + 1;

        // Slice of the line from its start to the end of the
        // parent — enough to inspect leading spaces.
        const lineText = parentText.slice(lineStartInText);

        const match = lineText.match(/^(    | {1,3})/);
        if (!match) return true; // consume the keystroke either way
        const removeCount = match[1].length;

        const lineStartDocPos = contentStart + lineStartInText;
        const tr = state.tr.delete(
          lineStartDocPos,
          lineStartDocPos + removeCount,
        );
        view.dispatch(tr);
        return true;
      },
    };
  },

  /**
   * Custom markdown serialiser. Mirrors the ImageWithControls
   * approach: emit raw HTML when the title attribute is non-default,
   * standard markdown otherwise.
   */
  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            write: (s: string) => void;
            text: (s: string) => void;
            ensureNewLine: () => void;
            closeBlock: (n: unknown) => void;
          },
          node: { attrs: Record<string, unknown>; textContent: string },
        ) {
          const title = (node.attrs.title as string) ?? DEFAULT_TITLE;
          const language = (node.attrs.language as string | null) ?? DEFAULT_LANGUAGE;
          const code = node.textContent;

          if (title !== DEFAULT_TITLE) {
            // Raw HTML form — preserves the title across save+reload.
            const escapedTitle = escapeAttr(title);
            const escapedCode = escapeText(code);
            const langAttr = ` class="language-${escapeAttr(language)}"`;
            state.write(
              `<pre data-title="${escapedTitle}"><code${langAttr}>${escapedCode}</code></pre>`,
            );
            state.closeBlock(node);
          } else {
            // Standard fenced code block.
            state.write('```' + language + '\n');
            state.text(code);
            state.ensureNewLine();
            state.write('```');
            state.closeBlock(node);
          }
        },
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView);
  },
}).configure({
  // CodeBlockLowlight option: which lowlight instance to use.
  lowlight,
  // Default language: Structured Text. Users can change it via the
  // language selector inside the code block (a future polish step
  // could expose a dropdown). For now this gives them TwinCAT 3
  // highlighting on every new block — matches the user's primary
  // use-case.
  defaultLanguage: DEFAULT_LANGUAGE,
});

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
