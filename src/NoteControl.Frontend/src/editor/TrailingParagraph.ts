import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * Ensures the document always ends with an empty paragraph when
 * its last block is a "trapping" block — one whose visual presence
 * at the very bottom of the doc leaves the user no place to click
 * or arrow into for further typing.
 *
 * The bug this fixes:
 *
 *   The user inserts a callout (or table, or code block, or
 *   horizontal rule, ...), types into it, and saves. On reload
 *   the callout is the last node in the document. There is no
 *   paragraph below it. Clicking below the callout, or pressing
 *   Down/End to escape downward, has nowhere to land — the
 *   cursor is trapped inside the callout for the rest of the
 *   editing session unless the user remembers an arrow-out trick.
 *
 *   The slash-menu insertion path (CalloutExtension.insertCallout
 *   and friends) already appends a trailing paragraph so the
 *   FRESHLY inserted block has an escape line. But that paragraph
 *   isn't part of the markdown — empty paragraphs serialise to
 *   nothing — so once the doc is saved and reloaded, the trailing
 *   paragraph is gone.
 *
 * The fix:
 *
 *   A ProseMirror plugin's appendTransaction hook runs after every
 *   transaction. We inspect the doc's last child; if it's a
 *   trapping block AND there's no trailing paragraph, we append
 *   one. This runs on initial load (the editor's first transaction
 *   sets the loaded doc) and after any edit, so the invariant
 *   "the doc ends in a paragraph" always holds.
 *
 * Why a transaction-time fix and not a NodeView-level "click
 * spacer below"? Several reasons:
 *
 *   - It's general. Any block-leaf (callout, table, code block,
 *     horizontal rule, image, video) needs the same affordance.
 *     A schema-level fix covers all of them with one rule; a
 *     per-NodeView fix needs to be wired into every node view
 *     individually and re-checked on every refactor.
 *
 *   - It's standard. The prosemirror-trailing-node package does
 *     exactly this. We re-implement instead of adding a dep
 *     because the logic is small (this file) and avoiding new
 *     deps matches the working agreement.
 *
 *   - It composes with the existing slash-menu trailing-paragraph
 *     logic. Both end up wanting "doc ends in paragraph", and
 *     this hook is the canonical place to express that — the
 *     slash-menu's manual paragraph insertion becomes redundant
 *     but harmless.
 *
 * Why it doesn't pollute saves:
 *
 *   An empty trailing paragraph serialises to nothing in
 *   markdown (paragraph serializer writes inline content then
 *   closeBlock; empty inline writes nothing, and closeBlock at
 *   the very end of the doc never gets flushed). So
 *   getMarkdown() returns the same string before and after the
 *   trailing paragraph is added. The dirty-check in NoteEditor's
 *   onUpdate compares strings, so adding the paragraph doesn't
 *   trigger a save. Verified by inspection of
 *   prosemirror-markdown's paragraph serializer.
 *
 * Why it doesn't pollute history:
 *
 *   We mark the appended transaction with `addToHistory: false`
 *   so undo/redo skips over it. Without this, pressing Ctrl+Z
 *   right after load would remove the trailing paragraph and
 *   trap the user again — exactly the behaviour we're fixing.
 *
 * Why it doesn't loop:
 *
 *   appendTransaction only fires for transactions OTHER than the
 *   one it returned, so returning a transaction here doesn't
 *   re-trigger the hook on the same transaction. We also gate
 *   on "is the last node already a paragraph?" so a no-op
 *   appendTransaction returns null and the transaction chain
 *   stops cleanly.
 */

/**
 * Block types whose presence as the very last node of the doc
 * traps the cursor with no clickable line below.
 *
 * Inclusion criteria: a block that
 *   (a) consumes a full editor row visually, AND
 *   (b) doesn't itself accept a click below its content as
 *       "click outside the block".
 *
 * Paragraphs are excluded — paragraph already IS the escape
 * affordance, so a trailing paragraph means the user already
 * has somewhere to land.
 *
 * heading is excluded — clicking below a heading already lands
 * the cursor at the end of the heading line (browsers and
 * ProseMirror handle this fine for inline-content blocks).
 *
 * blockquote / lists are excluded — same reason as heading
 * (their last child is itself a paragraph, so the user can
 * always escape by clicking at the very bottom of that paragraph
 * and pressing Enter; there's no node-view boundary in the way).
 *
 * If a future block type joins this list (e.g. a chart or
 * embedded form node), add its node name here.
 */
const TRAPPING_BLOCKS = new Set<string>([
  'callout',
  'table',
  'codeBlock',
  'horizontalRule',
  'image',
  'video',
]);

const trailingParagraphPluginKey = new PluginKey('trailingParagraph');

export const TrailingParagraph = Extension.create({
  name: 'trailingParagraph',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: trailingParagraphPluginKey,

        appendTransaction(_transactions, _oldState, newState) {
          const { doc, schema, tr } = newState;
          const paragraphType = schema.nodes.paragraph;
          if (!paragraphType) return null;   // schema without paragraph — nothing to do

          // Empty doc is fine — the schema's `block+` content match
          // already requires at least one block, which the editor
          // initialises as a paragraph. Defensive guard regardless.
          if (doc.childCount === 0) return null;

          const last = doc.lastChild;
          if (!last) return null;

          // Already ends in a paragraph (any paragraph — empty or
          // not). The user has somewhere to land; do nothing.
          if (last.type.name === 'paragraph') return null;

          // Last block isn't trapping — leave the doc alone.
          // Examples: heading, blockquote, bulletList, orderedList.
          // Their last leaf is itself an inline-content block the
          // user can click into.
          if (!TRAPPING_BLOCKS.has(last.type.name)) return null;

          // Append an empty paragraph at the very end of the doc.
          // doc.content.size is the position immediately after
          // the doc's last node — the canonical "end of doc"
          // insertion point.
          const insertPos = doc.content.size;
          const para = paragraphType.create();
          tr.insert(insertPos, para);

          // Don't pollute history — the user shouldn't be able to
          // Ctrl+Z away the escape paragraph and re-trap themselves.
          tr.setMeta('addToHistory', false);

          // Don't move the cursor. The user might be mid-edit
          // somewhere; appending a node at the end shouldn't snap
          // the selection. ProseMirror preserves the existing
          // selection through tr.insert at a position past the
          // selection, so we don't need to do anything explicit.

          return tr;
        },
      }),
    ];
  },
});
