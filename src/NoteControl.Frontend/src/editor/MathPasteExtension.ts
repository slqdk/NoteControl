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
            // Two jobs in this hook, in order:
            //
            // 1. If the HTML contains KaTeX's MathML annotations
            //    (a paste from another KaTeX-rendering app), extract
            //    the LaTeX source from each annotation and replace
            //    the surrounding `<span class="katex">` with our
            //    placeholder element.
            //
            // 2. THEN walk the remaining text nodes and run the
            //    math scanner on each — this covers the common
            //    case of pasting from an AI chat where the
            //    clipboard's HTML representation is plain HTML
            //    with literal `$..$` / `$$..$$` in paragraph text.
            //    (ProseMirror prefers HTML over text/plain when
            //    both are on the clipboard, so transformPastedText
            //    never runs in that case — we MUST do the dollar
            //    rewrite here as well.)
            //
            // Step 2 used to live only on the text/plain path; the
            // user-visible result of the previous version was that
            // pasted LaTeX delimiters survived verbatim as literal
            // text whenever the source app also offered text/html
            // (most modern web apps do). Source: the actual paste
            // bug that prompted this whole feature.

            let doc: Document;
            try {
              doc = new DOMParser().parseFromString(html, 'text/html');
            } catch {
              return html;     // can't parse → leave it alone
            }

            // --- Step 1: KaTeX MathML annotations ---------------
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
                placeholder.setAttribute('data-math-block', src);
              } else {
                placeholder.setAttribute('data-math-inline', src);
              }
              const replaceTarget =
                kn.closest('.katex-display') ?? kn;
              replaceTarget.replaceWith(placeholder);
            });

            // --- Step 2: dollar / backslash delimiters in text --
            //
            // We walk text nodes and scan each one. Matches get
            // replaced by a mix of text + placeholder elements in
            // the parent. Skip text inside <code>, <pre>, <script>,
            // <style>, and any element that's ALREADY one of our
            // own math placeholders (idempotency: re-pasting our
            // own HTML doesn't double-encode).
            rewriteTextNodesInPlace(doc, doc.body);

            return doc.body.innerHTML;
          },
        },
      }),
    ];
  },
});

/**
 * Walk all descendant text nodes of `root` and rewrite ones that
 * contain math delimiters. Each match becomes a placeholder
 * element inserted in place of the matched substring.
 *
 * Skips text inside elements where math substitution would do
 * harm: `<code>`, `<pre>`, `<script>`, `<style>`, and our own
 * placeholders (so re-pasting NoteControl HTML is idempotent).
 *
 * Mutates the DOM tree under `root`. Uses `doc` (the document
 * that owns `root`) for all DOM construction — DOMParser-created
 * documents are SEPARATE from `window.document`, and node
 * creation / TreeWalker creation MUST happen via the owning
 * document, not the global one.
 */
function rewriteTextNodesInPlace(doc: Document, root: Element): void {
  const SKIP_TAGS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE']);
  const walker = doc.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (n) => {
        let p: Node | null = n.parentNode;
        while (p && p !== root) {
          if (p.nodeType === Node.ELEMENT_NODE) {
            const el = p as Element;
            if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
            if (
              el.hasAttribute('data-math-inline') ||
              el.hasAttribute('data-math-block')
            ) {
              return NodeFilter.FILTER_REJECT;
            }
          }
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  const textNodes: Text[] = [];
  let cur = walker.nextNode();
  while (cur) {
    textNodes.push(cur as Text);
    cur = walker.nextNode();
  }

  for (const node of textNodes) {
    const text = node.nodeValue ?? '';
    if (
      text.indexOf('$') < 0 &&
      text.indexOf('\\(') < 0 &&
      text.indexOf('\\[') < 0
    ) {
      continue;
    }
    const rewritten = rewriteMarkdownMathToHtml(text, {
      allowFences: false,
    });
    if (rewritten === text) continue;

    // Convert the rewritten string into a fragment via a
    // throwaway wrapper. The non-tag gaps in `rewritten` are
    // raw text from the source DOM (which may contain `<` /
    // `&` already decoded), so we have to re-escape them
    // before letting innerHTML parse the string. The
    // placeholder tags themselves are well-formed because
    // mathParser.ts emits them with attribute-escaped sources.
    const wrapper = doc.createElement('span');
    wrapper.innerHTML = escapeNonMathGaps(rewritten);

    const parent = node.parentNode;
    if (!parent) continue;
    const frag = doc.createDocumentFragment();
    while (wrapper.firstChild) {
      frag.appendChild(wrapper.firstChild);
    }
    parent.replaceChild(frag, node);
  }
}

/**
 * The scanner output is a string like:
 *   "Force Limit: <span data-math-inline=\"5,650 \\text{ N}\"></span> and more."
 *
 * The non-tag gaps ("Force Limit: ", " and more.") were originally
 * plain text and may contain `<` or `&` that would mis-parse if
 * fed directly into innerHTML. This helper splits the rewritten
 * string at our placeholder tag boundaries, HTML-escapes the
 * gaps, and rejoins.
 */
function escapeNonMathGaps(rewritten: string): string {
  // Match either a math placeholder span/div (self-closing-shaped
  // as the scanner emits them) OR a chunk of non-tag text.
  // The placeholder pattern is anchored on the tag name and the
  // self-closing `></span>` / `></div>` shape so we don't match
  // user-provided HTML tags that happen to share a substring.
  const placeholderRe =
    /<(span|div)\s+data-math-(inline|block)="[^"]*"><\/\1>/g;
  let out = '';
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = placeholderRe.exec(rewritten)) !== null) {
    const gap = rewritten.slice(lastIdx, m.index);
    out += escapeHtmlText(gap) + m[0];
    lastIdx = m.index + m[0].length;
  }
  out += escapeHtmlText(rewritten.slice(lastIdx));
  return out;
}

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
