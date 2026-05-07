import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * Strip font-family / font-size / colour-related styling from pasted
 * HTML so pasted text inherits the note's defaults (frontmatter font /
 * fontSize, plus the editor's default text colour).
 *
 * What we keep:
 *   - bold       (<b>, <strong>)
 *   - italic     (<i>, <em>)
 *   - underline  (<u>, text-decoration: underline)
 *   - strike     (<s>, <del>, <strike>, text-decoration: line-through)
 *   - inline code (<code>)
 *   - links      (<a href>)
 *   - block structure (paragraphs, lists, headings, tables)
 *
 * What we strip:
 *   - inline `font-family`     CSS declarations
 *   - inline `font-size`       CSS declarations
 *   - inline `color`           CSS declarations  (per the user's design
 *                              decision: text colour is per-selection
 *                              applied via the popup, not pasted in)
 *   - inline `background-color`/`background` CSS declarations (Word's
 *                              default highlight tinting otherwise
 *                              persists into the note)
 *   - legacy `<font face="…" size="…" color="…">` attributes — we keep
 *                              the element so its child text survives,
 *                              but drop the styling attrs
 *   - `class` attributes that smell like Word's mso-* clutter
 *     (mso-, MsoNormal, etc) — these reference Word's own stylesheet
 *     which we don't ship, so they're dead weight that mainly serves
 *     to confuse the schema parser.
 *
 * Why a transformPastedHTML plugin and not a TipTap parseHTML rule:
 * parseHTML rules run AFTER ProseMirror's schema has accepted the
 * tag, so by the time a parseHTML rule sees a styled `<span>`, the
 * decision about which mark to attach has already happened. To
 * influence what marks attach we have to clean the HTML BEFORE
 * ProseMirror parses it. transformPastedHTML is the documented
 * editorProps hook for exactly this case.
 *
 * Composability with AssetPasteExtension: that extension's
 * handlePaste runs on `paste` events and wins (returning true) for
 * file pastes and Office-image pastes. transformPastedHTML doesn't
 * fire when handlePaste returns true, so the asset-paste branches
 * are unaffected. For Office HTML that doesn't have image
 * placeholders (text-only Word paste), handlePaste returns false
 * and transformPastedHTML cleans the HTML before insertion.
 *
 * AssetPasteExtension's image-placeholder branch builds its own HTML
 * via insertContentAt — that path also needs cleaning. The pure
 * function `normalizePastedHtml` is exported so AssetPasteExtension
 * can call it on `doc.body.innerHTML` before insertion.
 */

const PLUGIN_KEY = new PluginKey('pasteNormalize');

// Style declarations that are removed from every pasted element.
const STRIP_PROPERTIES = new Set([
  'font-family',
  'font-size',
  'color',
  'background',
  'background-color',
  // Mso-* lookalikes — these reference Word's own stylesheet which
  // we don't ship. Stripping them avoids ProseMirror logging schema
  // mismatches every time someone pastes from Word.
  'mso-style-name',
  'mso-bidi-font-family',
  'mso-bidi-font-size',
  'mso-bidi-language',
  'mso-fareast-language',
  'mso-ansi-language',
  'mso-pagination',
  'mso-list',
  'mso-margin-top-alt',
  'mso-margin-bottom-alt',
  'mso-add-space',
  'mso-spacerun',
]);

/**
 * Public function: take an HTML string, return a cleaned HTML string.
 * Idempotent — running it twice produces the same output as once.
 *
 * Operates on a detached <template> so we don't touch the live DOM.
 * That also avoids resource fetches (e.g. <img src> is parsed but
 * not loaded inside a template).
 */
export function normalizePastedHtml(html: string): string {
  if (!html) return html;

  // <template>.content is a DocumentFragment that DOES NOT trigger
  // resource loads or script execution for its children — exactly
  // what we want for a hostile-input cleanup pass.
  const tpl = document.createElement('template');
  tpl.innerHTML = html;

  // Walk every element in the fragment. We use a TreeWalker so we
  // hit elements in document order without re-walking after mutation
  // (we only mutate attributes / styles, not the tree shape, so the
  // walker's iteration is stable).
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.currentNode;

  while (node) {
    if (node instanceof HTMLElement) {
      cleanElement(node);
    }
    node = walker.nextNode();
  }

  return tpl.innerHTML;
}

function cleanElement(el: HTMLElement): void {
  const tag = el.tagName.toLowerCase();

  // Strip mso-* and Word's own classes — they reference an absent
  // stylesheet. We keep classes that look genuinely user-applied
  // (no mso prefix, not "MsoNormal", etc).
  const className = el.getAttribute('class');
  if (className) {
    const cleaned = className
      .split(/\s+/)
      .filter((c) => !/^mso/i.test(c) && !/^Mso/.test(c))
      .join(' ')
      .trim();
    if (cleaned) {
      el.setAttribute('class', cleaned);
    } else {
      el.removeAttribute('class');
    }
  }

  // Strip the offending CSS declarations from the inline `style`
  // attribute, leaving anything else (e.g. text-align, which we
  // don't currently support but might eventually) intact.
  const style = el.getAttribute('style');
  if (style) {
    const cleaned = filterStyleDeclarations(style);
    if (cleaned) {
      el.setAttribute('style', cleaned);
    } else {
      el.removeAttribute('style');
    }
  }

  // Legacy `<font>` attributes — drop the styling but keep the
  // element so its children survive. ProseMirror's parser tolerates
  // unknown elements and unwraps them around their content.
  if (tag === 'font') {
    el.removeAttribute('face');
    el.removeAttribute('size');
    el.removeAttribute('color');
  }
}

/**
 * Given an inline `style` value string, return the same value with
 * every declaration in STRIP_PROPERTIES removed.
 *
 * We tokenise on `;` (CSS declaration separator) instead of using
 * the CSSStyleDeclaration API because:
 *
 *   - assigning to .style.X normalizes / loses some hyphenation
 *   - some Word inline styles include vendor-prefixed properties
 *     that the live CSSOM throws away silently, but the source
 *     text still needs cleaning
 *   - the input is a flat string and we need to return a flat
 *     string — staying in string-space is the simpler path
 */
function filterStyleDeclarations(style: string): string {
  const out: string[] = [];
  for (const decl of style.split(';')) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const colonIx = trimmed.indexOf(':');
    if (colonIx <= 0) continue; // malformed — drop it
    const prop = trimmed.slice(0, colonIx).trim().toLowerCase();
    if (STRIP_PROPERTIES.has(prop)) continue;
    // Keep — re-emit the original (post-trim) text. We don't
    // canonicalise whitespace inside the value; the browser's CSS
    // parser handles that fine.
    out.push(trimmed);
  }
  return out.join('; ');
}

export const PasteNormalizeExtension = Extension.create({
  name: 'pasteNormalize',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: PLUGIN_KEY,
        props: {
          // transformPastedHTML runs on the HTML string of a paste
          // BEFORE ProseMirror's DOMParser turns it into nodes. That
          // gives us the chance to strip styling so the resulting
          // marks/nodes already inherit the note's defaults.
          //
          // This hook does NOT fire for plain-text pastes (no HTML
          // on the clipboard) — those have no styling to strip
          // anyway. It also doesn't fire when AssetPasteExtension's
          // handlePaste claims the event (returns true), which is
          // exactly what we want: file pastes and image-bearing
          // Office pastes go through the asset path; text-only
          // pastes (the case we're cleaning) come through here.
          transformPastedHTML: (html) => normalizePastedHtml(html),
        },
      }),
    ];
  },
});
