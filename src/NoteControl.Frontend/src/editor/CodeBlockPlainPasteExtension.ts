import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Slice } from '@tiptap/pm/model';

/**
 * Force code-block copy AND paste to deal in plain text only.
 *
 * The bug this fixes — TWO halves:
 *
 * HALF A (copy poisoning):
 *
 *   The MarkdownExtension is configured with `transformCopiedText: true`,
 *   which installs a ProseMirror `clipboardTextSerializer` that turns
 *   the selected slice into markdown via the markdown serializer
 *   before the browser puts it on the clipboard. For most content
 *   that's exactly what we want — copying a bullet list produces
 *   `- a\n- b` on the clipboard so a paste into another note keeps
 *   structure.
 *
 *   But when the user copies text out of a code block whose title is
 *   non-default (e.g. "Implementation"), the markdown serializer in
 *   CodeBlockWithTitle.ts emits the RAW HTML form
 *   `<pre data-title="Implementation"><code class="language-st">…</code></pre>`
 *   for round-trip stability with the on-disk markdown. That HTML
 *   goes on `text/plain` instead of just the code text, and now the
 *   clipboard is poisoned.
 *
 *   Fix: register our own `clipboardTextSerializer` that runs FIRST
 *   (default extension priority 100; MarkdownClipboard runs at 50).
 *   When the editor's current selection is fully inside a code
 *   block, return the slice's plain text content. Otherwise return
 *   null and let MarkdownClipboard take over for non-code copies.
 *
 * HALF B (paste landing):
 *
 *   Even with the copy fix, content arriving from elsewhere (a code
 *   block in another browser tab, a stale clipboard buffer, an
 *   external editor) can carry HTML that, when pasted into a code
 *   block, gets fitted as escaped literal text by ProseMirror's
 *   slice-fitting heuristics.
 *
 *   Fix: when the cursor is inside a code block, intercept paste
 *   via `handlePaste`, ignore the HTML payload, take `text/plain`
 *   directly, and insert it via `tr.insertText`. No HTML pipeline,
 *   no marks, no slice fitting.
 *
 * Both halves matter. The copy fix prevents poisoning in the
 * NoteControl-internal round-trip. The paste fix defends against
 * everything else.
 *
 * Why one extension instead of two:
 *
 *   They share the same "is this code-block territory?" predicate
 *   and the same lifecycle. Splitting them would just duplicate the
 *   ancestor walk and the file boilerplate.
 *
 * Composability with MarkdownClipboard:
 *
 *   ProseMirror only uses the FIRST plugin whose
 *   `clipboardTextSerializer` is defined per copy event. By
 *   registering at default extension priority (100) we sit before
 *   MarkdownClipboard (priority 50) in TipTap's plugin ordering,
 *   so we're first in line. Returning null from our serializer
 *   defers to the next handler — i.e. MarkdownClipboard runs as
 *   normal for non-code-block copies. The markdown copy/paste flow
 *   for paragraphs, lists, and other normal content is untouched.
 *
 * Composability with AssetPasteExtension:
 *
 *   Its `handlePaste` runs first (registered earlier in the array)
 *   and claims file/screenshot pastes. It returns false for ordinary
 *   text/HTML, which is when ours runs. Asset paste flows are
 *   unchanged.
 */

const PLUGIN_KEY = new PluginKey('codeBlockPlainPaste');

/**
 * True iff the current selection sits entirely inside a code block.
 * Walks up from $from; the selection is considered "in" a code
 * block when any ancestor is a node named "codeBlock". We don't
 * require both ends to share the same code block — a multi-block
 * selection that crosses out of code-block territory falls back to
 * default behaviour, which is the right call (MarkdownClipboard's
 * markdown serialization handles the mixed case).
 */
function selectionInsideCodeBlock(
  $from: { depth: number; node: (depth: number) => { type: { name: string } } },
  $to: { depth: number; node: (depth: number) => { type: { name: string } } },
): boolean {
  function inCodeBlock(
    $pos: { depth: number; node: (depth: number) => { type: { name: string } } },
  ): boolean {
    for (let depth = $pos.depth; depth > 0; depth--) {
      if ($pos.node(depth).type.name === 'codeBlock') return true;
    }
    return false;
  }
  return inCodeBlock($from) && inCodeBlock($to);
}

export const CodeBlockPlainPasteExtension = Extension.create({
  name: 'codeBlockPlainPaste',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: PLUGIN_KEY,
        props: {
          // ── HALF A: COPY ──────────────────────────────────────
          //
          // Override what goes onto `text/plain` when the user
          // copies. ProseMirror calls this with the slice that was
          // selected. We use `editor.state.selection` (captured
          // from the closure) instead of trying to inspect the
          // slice itself, because a selection of inline text
          // *inside* a code block produces a slice whose root
          // content is just the text node — the codeBlock parent
          // isn't *in* the slice. The state is the truth.
          clipboardTextSerializer: (slice: Slice) => {
            const sel = this.editor.state.selection;
            if (!selectionInsideCodeBlock(sel.$from, sel.$to)) {
              // Not a code-block copy — defer to the next handler
              // (MarkdownClipboard) so paragraph / list / table
              // copies keep going through the markdown serializer
              // as designed.
              return null;
            }
            // Code-block copy. Just emit the plain text. `\n` is
            // the right block separator for a slice that contains
            // multiple text-with-hardbreaks pieces — it matches
            // how code blocks store newlines internally.
            return slice.content.textBetween(0, slice.content.size, '\n');
          },

          // ── HALF B: PASTE ─────────────────────────────────────
          //
          // Force plain-text paste when the cursor is inside a
          // code block. The text/plain payload may have been put
          // there by us (which after Half A is just code), by
          // another tab still running the old build, or by an
          // external app — we don't care about the source, we just
          // know that inside a code block, anything but plain text
          // is wrong.
          handlePaste: (view, event) => {
            const { $from, $to } = view.state.selection;
            if (!selectionInsideCodeBlock($from, $to)) return false;

            const text = event.clipboardData?.getData('text/plain') ?? '';
            if (!text) return false;

            event.preventDefault();
            const { tr } = view.state;
            view.dispatch(tr.insertText(text).scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});
