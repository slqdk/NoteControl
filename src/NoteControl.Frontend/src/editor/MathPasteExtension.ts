import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

import { escapeForHtmlAttr, rewriteMarkdownMathToHtml } from './mathParser';

/**
 * MathPasteExtension — intercepts pasted text and pasted HTML and
 * rewrites recognised LaTeX delimiters into our math-node HTML
 * placeholders.
 *
 * --- Text/plain path ---
 *
 * `transformPastedText` runs BEFORE tiptap-markdown's
 * clipboardTextParser. We scan the pasted text for `$..$`,
 * `$$..$$`, `\(..\)`, `\[..\]` (see mathParser.ts) and substitute
 * each match with `<span data-math-inline="…">` or `<div data-
 * math-block="…">`. The downstream markdown parser (markdown-it
 * with `html: true`) passes those placeholders through as raw
 * HTML, and the math node's parseHTML rule turns them into math
 * nodes.
 *
 * The substitution skips inline code spans and fenced code blocks
 * so a snippet like `\`$x = 1$\`` doesn't get rewritten. Indented
 * code blocks are also skipped — see mathParser.ts.
 *
 * --- Text/html path ---
 *
 * Copy-paste from another tab in *some* app that renders LaTeX
 * (e.g. a different KaTeX-based chat / docs surface) puts BOTH
 * text/plain (LaTeX source) and text/html (rendered KaTeX HTML)
 * on the clipboard. ProseMirror prefers the HTML path; without
 * a hook we'd lose the source entirely (the HTML is a forest of
 * `<span class="katex">` glyph shells, not LaTeX).
 *
 * The pragmatic save: KaTeX embeds the original LaTeX source in
 * a `<annotation encoding="application/x-tex">` inside its
 * MathML mirror (so screen readers and copy-paste workflows have
 * access to the source). We extract those annotations and rewrite
 * each surrounding `<span class="katex">` to our placeholder.
 * Sources that don't follow this convention fall through to the
 * plain-text path (ProseMirror's default behaviour is to use
 * text/plain when text/html is empty or unhelpful).
 *
 * --- Order with AssetPasteExtension ---
 *
 * AssetPasteExtension's `handlePaste` returns true for image /
 * video / file pastes (those are clipboardItems, not text), so
 * the two extensions don't compete on the same input. We
 * register MathPasteExtension AFTER AssetPasteExtension in the
 * editor's extensions array so the file path runs first; the
 * order doesn't actually matter at runtime (different ProseMirror
 * hooks) but it keeps the mental model consistent.
 *
 * --- Order with tiptap-markdown ---
 *
 * tiptap-markdown registers its own paste handler with the same
 * hook category we use. Empirically, our handler runs first
 * because we register earlier in the extensions list (we're added
 * after AssetPaste but BEFORE MarkdownExtension). If that
 * ordering changes — e.g. someone refactors the extensions list
 * — the test to run is: paste plain text `$x^2$` into the editor
 * and confirm it renders as math, not as the literal characters.
 */

const PLUGIN_KEY = new PluginKey('mathPaste');

export const MathPasteExtension = Extension.create({
  name: 'mathPaste',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: PLUGIN_KEY,
        props: {
          transformPastedText(text) {
            // Plain-text paste from anywhere. We use mathParser's
            // scanner with `allowFences: false` because pasted
            // text is usually a snippet, not a full markdown doc,
            // and there's no useful notion of "inside a fence" at
            // the slice level (the slice boundary may slice through
            // a fence). Inline backtick code spans are still
            // honoured.
            return rewriteMarkdownMathToHtml(text, { allowFences: false });
          },

          transformPastedHTML(html) {
            // Cheap no-op when no katex / math annotation is present.
            // We also skip if our own data-math-* placeholders already
            // exist (a paste of HTML that came FROM NoteControl).
            if (
              html.indexOf('data-math-inline') < 0 &&
              html.indexOf('data-math-block') < 0 &&
              html.indexOf('application/x-tex') < 0
            ) {
              return html;
            }

            // Use DOMParser to walk the HTML safely. textContent of
            // the annotation element holds the LaTeX source verbatim.
            //
            // Why DOMParser instead of regex on the HTML string?
            // KaTeX's MathML annotations contain HTML entities, line
            // breaks, and other quoting noise that's painful to
            // regex out reliably. Going through the browser parser
            // is one short function and handles all that for free.
            let doc: Document;
            try {
              doc = new DOMParser().parseFromString(html, 'text/html');
            } catch {
              return html;     // can't parse → leave it alone
            }

            // For each `<span class="katex">` element, find the
            // annotation child and replace the outer span with our
            // placeholder. The annotation's display mode is signalled
            // by an ancestor class `katex-display` (block) vs. its
            // absence (inline).
            const katexNodes = doc.querySelectorAll('.katex');
            katexNodes.forEach((kn) => {
              const ann = kn.querySelector(
                'annotation[encoding="application/x-tex"]',
              );
              if (!ann) return;
              const src = (ann.textContent ?? '').trim();
              if (src === '') return;
              const isBlock =
                kn.classList.contains('katex-display') ||
                kn.parentElement?.classList.contains('katex-display');
              const placeholder = doc.createElement(isBlock ? 'div' : 'span');
              if (isBlock) {
                placeholder.setAttribute(
                  'data-math-block',
                  // Decode here is intentional: setAttribute will
                  // entity-encode automatically; we want the raw
                  // string in the DOM attribute.
                  src,
                );
              } else {
                placeholder.setAttribute('data-math-inline', src);
              }
              // Replace the outermost katex-display wrapper if
              // present (block math) so we don't leave its
              // surrounding chrome behind.
              const replaceTarget =
                kn.closest('.katex-display') ?? kn;
              replaceTarget.replaceWith(placeholder);
            });

            return doc.body.innerHTML;
          },
        },
      }),
    ];
  },
});

/**
 * Convenience: run the math substitution on a markdown body
 * string before it's handed to TipTap as `content`. Lets callers
 * (NoteEditor's setContent path) do the same rewrite that the
 * paste path does, but for fresh content load.
 *
 * Kept as a thin export from this file so all the "this is a
 * paste/load entry point" logic lives in one module.
 */
export function preprocessMarkdownForMath(markdown: string): string {
  return rewriteMarkdownMathToHtml(markdown, { allowFences: true });
}

// Re-export for callers that don't need the extension but need
// the helper directly (e.g. tests).
export { escapeForHtmlAttr };
