import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Slice } from '@tiptap/pm/model';
import type { ResolvedPos } from '@tiptap/pm/model';

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
 *   Fix: register our own `clipboardTextSerializer` that runs FIRST.
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
 * Composability with MarkdownClipboard:
 *
 *   ProseMirror only uses the FIRST plugin whose
 *   `clipboardTextSerializer` is defined per copy event AND that
 *   returns a non-null value. By registering earlier in the
 *   extension array than MarkdownExtension, we sit before
 *   MarkdownClipboard in the plugin chain. Returning null from
 *   our serializer defers to the next handler — MarkdownClipboard
 *   then runs as normal for non-code-block copies. The markdown
 *   copy/paste flow for paragraphs, lists, and other content is
 *   untouched.
 *
 * Composability with AssetPasteExtension:
 *
 *   Its `handlePaste` runs first (registered earlier in the array)
 *   and claims file/screenshot pastes. It returns false for ordinary
 *   text/HTML, which is when ours runs. Asset paste flows are
 *   unchanged.
 *
 * TypeScript note re: `clipboardTextSerializer` return type:
 *
 *   ProseMirror's `.d.ts` declares the signature as
 *     `(this: P, content: Slice, view: EditorView) => string`
 *   — `string`, NOT `string | null`. But ProseMirror's RUNTIME
 *   behaviour treats a null return as "defer to default" (see the
 *   prosemirror-view source for `serializeForClipboard`, and note
 *   that tiptap-markdown's own MarkdownClipboard returns null too;
 *   it works in plain JS because no type-check runs there).
 *
 *   To satisfy TypeScript without lying about the function shape,
 *   we declare the inner serializer as returning `string | null`
 *   and cast the whole `props` object once at the boundary where
 *   it's handed to ProseMirror. The cast is narrow, well-commented,
 *   and lives in exactly one place.
 */

const PLUGIN_KEY = new PluginKey('codeBlockPlainPaste');

/**
 * True iff the position is inside a code block. Walks ancestors
 * up from the resolved position; matches by node-type name to be
 * robust against any extension naming variants.
 */
function inCodeBlock($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === 'codeBlock') return true;
  }
  return false;
}

/**
 * True iff BOTH endpoints of a selection sit inside a code block.
 * A multi-block selection that crosses into or out of code-block
 * territory falls back to default behaviour, which is the right
 * call: MarkdownClipboard's markdown serializer handles mixed
 * selections fine.
 */
function selectionInsideCodeBlock($from: ResolvedPos, $to: ResolvedPos): boolean {
  return inCodeBlock($from) && inCodeBlock($to);
}

export const CodeBlockPlainPasteExtension = Extension.create({
  name: 'codeBlockPlainPaste',

  addProseMirrorPlugins() {
    const editor = this.editor;

    // Build the props object with our preferred (honest) types,
    // then cast once at the Plugin boundary. See the TypeScript
    // note in the file header for why this cast is necessary.
    const props = {
      // ── HALF A: COPY ────────────────────────────────────────
      clipboardTextSerializer: (slice: Slice): string | null => {
        const sel = editor.state.selection;
        if (!selectionInsideCodeBlock(sel.$from, sel.$to)) {
          // Not a code-block copy — defer to the next handler
          // (MarkdownClipboard) so paragraph / list / table copies
          // keep going through the markdown serializer as designed.
          return null;
        }
        // Code-block copy. Just emit the plain text. `\n` is the
        // right block separator for a slice that contains text
        // with hard breaks — it matches how code blocks store
        // newlines internally.
        return slice.content.textBetween(0, slice.content.size, '\n');
      },

      // ── HALF B: PASTE ───────────────────────────────────────
      handlePaste: (
        view: import('@tiptap/pm/view').EditorView,
        event: ClipboardEvent,
      ): boolean => {
        const { $from, $to } = view.state.selection;
        if (!selectionInsideCodeBlock($from, $to)) return false;

        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (!text) return false;

        event.preventDefault();
        const { tr } = view.state;
        view.dispatch(tr.insertText(text).scrollIntoView());
        return true;
      },
    };

    return [
      new Plugin({
        key: PLUGIN_KEY,
        // The cast: ProseMirror's published .d.ts declares
        // `clipboardTextSerializer` as `=> string` rather than
        // `=> string | null`, but the runtime treats a null return
        // as "defer to default" (matching tiptap-markdown's own
        // usage). We assert the shape we know works.
        props: props as unknown as ConstructorParameters<typeof Plugin>[0]['props'],
      }),
    ];
  },
});
