import { Markdown } from 'tiptap-markdown';

/**
 * Centralised configuration for the tiptap-markdown extension.
 *
 * Why factor this out? Two places use it: the live editor (NoteEditor)
 * and any future "render markdown to HTML" preview tool. Keeping the
 * options identical is what guarantees round-trip stability: load the
 * note, save it without editing, and the bytes on disk are unchanged.
 *
 * Options:
 *   - html: true       — allow raw HTML in markdown (matches CommonMark
 *                        and is required for the spec's video/audio
 *                        embeds eventually).
 *   - tightLists: true — emit `- a\n- b` (no blank line between items)
 *                        when the list was authored that way.
 *   - bulletListMarker: '-' — `-` is the convention in most note apps;
 *                             also what humans most often type.
 *   - linkify: false   — don't auto-detect bare URLs as links on parse.
 *                        We let users decide via the link button.
 *   - breaks: false    — single newlines stay as soft breaks within a
 *                        paragraph, matching CommonMark.
 *   - transformPastedText: true — turn pasted markdown text into nodes
 *                                 instead of literal asterisks.
 *   - transformCopiedText: true — copy out as markdown, not HTML, so
 *                                 pasting into another note preserves
 *                                 formatting.
 */
export const markdownExtensionConfig = {
  html: true,
  tightLists: true,
  bulletListMarker: '-',
  linkify: false,
  breaks: false,
  transformPastedText: true,
  transformCopiedText: true,
} as const;

export const MarkdownExtension = Markdown.configure(markdownExtensionConfig);
