import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';

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
 * The fix has TWO entry points, both of which call the same
 * helper:
 *
 *   1. onCreate (TipTap lifecycle hook) — fires once after the
 *      editor mounts and the initial doc is loaded. THIS IS THE
 *      CRITICAL PATH for the user's bug, because the most common
 *      trapping case is opening an existing note that already
 *      ends with a callout. EditorState.create does NOT call
 *      appendTransaction (only applyTransaction does), so without
 *      onCreate the loaded doc would never get the trailing
 *      paragraph and clicking below the callout would still go
 *      nowhere.
 *
 *   2. appendTransaction (ProseMirror plugin hook) — fires after
 *      every subsequent transaction. Catches the case where the
 *      user creates / pastes / converts content during editing
 *      such that the last block becomes trapping (e.g. delete a
 *      paragraph that previously sat below a callout). Without
 *      this, edits that produce a trapping last block during
 *      live editing would still trap the user.
 *
 * Earlier ship attempted appendTransaction only and left the
 * onCreate path out, on the assumption that the editor's initial
 * content load would itself fire a transaction. It does not —
 * EditorState.create initialises plugin state via field.init,
 * not via dispatched transactions. The user reproed exactly this
 * gap: opened a note ending with a callout, saw no trailing
 * paragraph, clicks went nowhere.
 *
 * Why a schema-level fix and not a per-NodeView "click below to
 * add line" affordance:
 *
 *   - General. Any block-leaf (callout, table, code block,
 *     horizontal rule, image, video) needs the same affordance.
 *     One rule covers all; per-NodeView wiring needs to be
 *     re-implemented for each node type.
 *
 *   - Standard. The prosemirror-trailing-node package does
 *     exactly this. We re-implement instead of adding a dep
 *     because the logic is small (this file) and avoiding new
 *     deps matches the working agreement.
 *
 *   - Composes with the existing slash-menu trailing-paragraph
 *     logic. Both want "doc ends in paragraph"; this hook is
 *     where that invariant lives.
 *
 * Why it doesn't pollute saves:
 *
 *   An empty trailing paragraph serialises to nothing in
 *   markdown (the paragraph serializer writes inline content
 *   then closeBlock; empty inline writes nothing, and the final
 *   closeBlock at the very end of the doc is never flushed). So
 *   getMarkdown() returns the same string before and after the
 *   trailing paragraph is added. The dirty-check in NoteEditor's
 *   onUpdate compares strings, so the onCreate-dispatched
 *   transaction triggers onUpdate but the equality check passes
 *   and no save is scheduled. Verified by inspection of
 *   prosemirror-markdown's paragraph serializer.
 *
 * Why it doesn't pollute history:
 *
 *   Both code paths set `addToHistory: false` on the transaction,
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
 *   appendTransaction returns null and the chain stops cleanly.
 *
 *   For onCreate's dispatch: that fires only once per editor
 *   mount, and the resulting transaction's appendTransaction
 *   pass sees the freshly added paragraph as the last node and
 *   returns null.
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
 * Excluded:
 *   - paragraph — already IS the escape affordance.
 *   - heading — clicking below a heading lands the cursor at the
 *     end of the heading line; no trapping problem.
 *   - blockquote / lists — their last child is itself a paragraph,
 *     so clicking at the bottom of that paragraph and pressing
 *     Enter creates a new line; no NodeView boundary in the way.
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
  // mathBlock is a block-level atom node (KaTeX-rendered display
  // equation). Without a paragraph beneath it the cursor has
  // nowhere to land below the last math block in a note — same
  // trap as the other block atoms.
  'mathBlock',
]);

const trailingParagraphPluginKey = new PluginKey('trailingParagraph');

export const TrailingParagraph = Extension.create({
  name: 'trailingParagraph',

  /**
   * Dispatches the fix-up transaction once after the editor is
   * created with its initial content. See top-of-file comment
   * for why this matters more than the appendTransaction hook.
   */
  onCreate() {
    ensureTrailingParagraph(this.editor);
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: trailingParagraphPluginKey,
        appendTransaction(_transactions, _oldState, newState) {
          return computeTrailingParagraphTr(newState) ?? undefined;
        },
      }),
    ];
  },
});

// ---- Shared logic ---------------------------------------------------

/**
 * If the doc's last child is a trapping block and there's no
 * trailing paragraph, return a transaction that appends one.
 * Returns null when no change is needed.
 *
 * Shared between the appendTransaction plugin (ongoing edits)
 * and the onCreate hook (initial loaded doc), so both code paths
 * use exactly the same rule.
 */
function computeTrailingParagraphTr(state: EditorState): Transaction | null {
  const { doc, schema, tr } = state;
  const paragraphType = schema.nodes.paragraph;
  if (!paragraphType) return null;     // schema without paragraph — bail

  if (doc.childCount === 0) return null;
  const last = doc.lastChild;
  if (!last) return null;

  // Already ends in a paragraph — escape line is present.
  if (last.type.name === 'paragraph') return null;

  // Last block isn't trapping (heading, list, blockquote, ...).
  if (!TRAPPING_BLOCKS.has(last.type.name)) return null;

  const insertPos = doc.content.size;
  const para = paragraphType.create();
  tr.insert(insertPos, para);

  // Don't pollute history — the user shouldn't be able to Ctrl+Z
  // away the escape paragraph and re-trap themselves.
  tr.setMeta('addToHistory', false);

  // Tag the transaction so other observers can recognise it as
  // a no-op fix-up (currently unused, but useful for debugging
  // or a future "ignore-in-dirty-check" optimisation).
  tr.setMeta(trailingParagraphPluginKey, true);

  return tr;
}

/**
 * Editor-level helper for the onCreate path. Computes the fix-up
 * transaction from editor.state and dispatches it through the
 * view if needed. No-op when the doc is already well-formed.
 */
function ensureTrailingParagraph(editor: Editor): void {
  const tr = computeTrailingParagraphTr(editor.state);
  if (tr) editor.view.dispatch(tr);
}
