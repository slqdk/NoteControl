import { useState } from 'react';
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from '@tiptap/react';

/**
 * NodeView for code blocks with an editable title.
 *
 * Layout:
 *   ┌───────────────────────────────────────┐
 *   │ [editable title]                      │  ← header bar, plain <input>
 *   ├───────────────────────────────────────┤
 *   │ code content (NodeViewContent)        │  ← actual prosemirror-managed code
 *   │ ...                                   │
 *   └───────────────────────────────────────┘
 *
 * The header bar is a regular HTML <input>, NOT part of the
 * prosemirror document. Its value lives in node.attrs.title.
 * NodeViewContent renders the code area where ProseMirror keeps
 * the editable code. We don't try to nest an editable region
 * inside the title — that's a recipe for selection bugs.
 *
 * Title editing semantics:
 *   - Click the title → focus the input
 *   - Type → updates node.attrs.title via updateAttributes
 *   - Enter → blurs back into the code area
 *   - Empty title falls back to "code" so the bar always shows
 *     something readable
 */
export function CodeBlockNodeView({ node, updateAttributes }: NodeViewProps) {
  const [draft, setDraft] = useState<string>(
    (node.attrs.title as string) ?? 'code',
  );

  // Sync draft when node attrs change from elsewhere (e.g. an undo
  // step). We do this with a useEffect-like pattern: just check on
  // every render — cheap because this only re-renders on prop
  // changes.
  if (typeof node.attrs.title === 'string' && node.attrs.title !== draft) {
    // Only sync when it's NOT mid-edit. Easiest heuristic: if the
    // input doesn't have focus, accept the external value.
    if (typeof document !== 'undefined' && document.activeElement?.tagName !== 'INPUT') {
      setDraft(node.attrs.title);
    }
  }

  function commit() {
    const t = draft.trim() || 'code';
    if (t !== node.attrs.title) {
      updateAttributes({ title: t });
    }
    if (t !== draft) {
      setDraft(t);
    }
  }

  return (
    <NodeViewWrapper className="nc-codeblock-wrap">
      <div className="nc-codeblock-header" contentEditable={false}>
        <input
          type="text"
          className="nc-codeblock-title"
          value={draft}
          placeholder="code"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              setDraft((node.attrs.title as string) || 'code');
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label="Code block title"
        />
      </div>
      <pre className="nc-codeblock-pre">
        <NodeViewContent as="code" />
      </pre>
    </NodeViewWrapper>
  );
}
