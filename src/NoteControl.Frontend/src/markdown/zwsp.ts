/**
 * Strip stray zero-width-space (U+200B) characters from a markdown
 * string before the editor parses it.
 *
 * Companion to ParagraphWithEmpty in src/editor/ParagraphWithEmpty.ts.
 * That extension's serializer emits a single ZWSP on a line by itself
 * to represent an empty paragraph on disk — the bare minimum needed
 * to survive markdown-it parsing and ProseMirror DOMParser without
 * the paragraph being dropped.
 *
 * When the user later types into that previously-empty paragraph,
 * the serializer writes the paragraph's full content — which now
 * starts with the ZWSP they typed past. Without this strip pass the
 * disk file would accumulate leading ZWSPs on every line the user
 * has visited, harmless to display (zero-width) but visible to
 * external tools and breaking literal-text searches (`grep "hello"`
 * misses `\u200Bhello`).
 *
 * Strategy:
 *   - lines that contain ONLY a single ZWSP are the placeholder for
 *     an empty paragraph — keep them as-is so the parser produces
 *     an empty paragraph node;
 *   - on every other line, drop all ZWSPs so the content is the
 *     user's actual text only.
 *
 * Run this at every "markdown enters the editor" boundary: the
 * initial useEditor `content:` setup, the nc:note-reload-body
 * handler, and any future paste-from-disk path.
 *
 * Hot-path optimization: skip the split/join when the string has no
 * ZWSP at all — the overwhelmingly common case for notes that have
 * never had an empty paragraph saved.
 */
const ZWSP = '\u200B';

export function stripStrayZeroWidthSpaces(markdown: string): string {
  if (!markdown.includes(ZWSP)) return markdown;
  return markdown
    .split('\n')
    .map((line) => (line === ZWSP ? line : line.split(ZWSP).join('')))
    .join('\n');
}
