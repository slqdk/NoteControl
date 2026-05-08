import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * Force plain-text paste when the cursor is inside a code block.
 *
 * The bug this fixes:
 *
 * When the user copies text from a rendered code block in
 * NoteControl, the browser puts BOTH `text/plain` and `text/html`
 * onto the clipboard. The `text/html` payload includes our own
 * code block wrapper:
 *
 *     <pre data-title="Implementation"><code class="language-st">…
 *     XPUMoverID
 *     </code></pre>
 *
 * Pasting that back INTO a code block goes through TipTap's normal
 * HTML-paste pipeline. The destination is a code block, which only
 * accepts text — but ProseMirror's slice-fitting heuristics for
 * "structured node landing in a code block" aren't perfect for our
 * `data-title` carrying wrapper, and the wrapper ends up serialised
 * back into the body as HTML-escaped literal text:
 *
 *     &lt;pre data-title="Implementation"&gt;&lt;code class=…&gt;
 *     XPUMoverID
 *     &lt;/code&gt;&lt;/pre&gt;
 *
 * Visible to the user as a wall of `<pre…><code…>…</code></pre>`
 * inside their code, which is what they reported as "annoying".
 *
 * The fix is what every code-aware editor (VS Code, Notion's code
 * block, Obsidian) does: when pasting into code, ignore the HTML
 * payload entirely and use the `text/plain` payload directly.
 *
 * Why a separate extension and not a tweak to PasteNormalizeExtension:
 *
 *   - Different hook. PasteNormalizeExtension is a `transformPastedHTML`
 *     plugin — it only sees the HTML string, not the destination
 *     node. We need to know "is the cursor inside a code block?"
 *     to decide whether to override, and that information is on the
 *     ProseMirror state, not the HTML string.
 *
 *   - Different concern. PasteNormalizeExtension cleans Word's
 *     mso-* clutter and background fills out of arbitrary HTML.
 *     This extension makes a routing decision: should we paste as
 *     HTML at all, or fall back to plain text? Mixing the two would
 *     muddle both responsibilities.
 *
 * Composability with AssetPasteExtension:
 *
 *   AssetPasteExtension's `handlePaste` runs first (it's registered
 *   earlier in the extensions array). It claims the event (returns
 *   true) only when the clipboard has direct files or Office HTML
 *   with image placeholders. Neither case is the bug here — those
 *   are deliberate "upload as asset" flows that the user wants.
 *   For ordinary text/HTML paste (the bug case), AssetPasteExtension
 *   returns false, ProseMirror moves to the next handler, and we
 *   take over.
 *
 *   We also intentionally let AssetPasteExtension win when a user
 *   pastes a screenshot directly into a code block. That gives them
 *   a markdown image link as literal text inside the code, which is
 *   awkward but matches the pre-existing behaviour and isn't what
 *   they reported. Keeping this extension's scope tight to the
 *   reported bug.
 */

const PLUGIN_KEY = new PluginKey('codeBlockPlainPaste');

export const CodeBlockPlainPasteExtension = Extension.create({
  name: 'codeBlockPlainPaste',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: PLUGIN_KEY,
        props: {
          handlePaste: (view, event) => {
            // Are we pasting into a code block? Walk up from the
            // current selection's parent to see if any ancestor is
            // a `codeBlock` node. We use a name match (not a node-
            // type identity check) because TipTap's CodeBlockLowlight
            // and our extension both register as "codeBlock" — the
            // string is the canonical identifier in either case.
            const { $from } = view.state.selection;
            let inCodeBlock = false;
            for (let depth = $from.depth; depth > 0; depth--) {
              if ($from.node(depth).type.name === 'codeBlock') {
                inCodeBlock = true;
                break;
              }
            }
            if (!inCodeBlock) return false;

            // We only intervene when there's a text/plain payload
            // available. If somehow only text/html is on the
            // clipboard (rare — basically only programmatic copies
            // from a hostile page), we fall through to TipTap's
            // default paste which does its best with the HTML. The
            // alternative — strip the HTML to text via DOMParser —
            // adds complexity for a case that doesn't come up in
            // normal use.
            const text = event.clipboardData?.getData('text/plain') ?? '';
            if (!text) return false;

            event.preventDefault();

            // Insert the text via a direct prosemirror transaction.
            // We use `tr.insertText` so the text is literal — no
            // HTML parsing, no slice-fitting, no marks applied. The
            // current selection (which may be a range, e.g. the user
            // selected some text and pasted to replace it) is
            // handled by `replaceSelectionWith` semantics that
            // `insertText` follows when `from`/`to` are omitted.
            const { tr } = view.state;
            view.dispatch(tr.insertText(text).scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});
