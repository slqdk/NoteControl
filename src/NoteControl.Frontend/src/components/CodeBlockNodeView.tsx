import { useState } from 'react';
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from '@tiptap/react';

import { RuntimeModal } from './RuntimeModal';

/**
 * NodeView for code blocks with an editable title.
 *
 * Layout:
 *   ┌───────────────────────────────────────┐
 *   │ [editable title]            [Run ▶]   │  ← header bar
 *   ├───────────────────────────────────────┤
 *   │ code content (NodeViewContent)        │
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
 *
 * Run button — Ship A introduces a conditional **Run ▶** button
 * in the header bar. Visibility rule:
 *
 *   - This block's language is "st"
 *   - This block's title is "Implementation" (case-insensitive)
 *   - The immediately-preceding sibling node in the document is
 *     a code block with language "st" and title "Declaration"
 *
 * That triplet is exactly what the PLCOpen XML import produces,
 * and matches the only configuration the runtime modal knows how
 * to handle. When the rule is false we render no button — a
 * regular code block stays unchanged.
 *
 * The "preceding sibling" check happens on each render. It's
 * cheap (one resolve + one nodeBefore peek) and the editor's
 * doc tree is small enough that we don't memoise.
 */
export function CodeBlockNodeView({
  node,
  updateAttributes,
  editor,
  getPos,
}: NodeViewProps) {
  const [draft, setDraft] = useState<string>(
    (node.attrs.title as string) ?? 'code',
  );
  const [runtimeOpen, setRuntimeOpen] = useState(false);

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

  // Determine whether to show the Run button.
  const runnable = isRunnableImplementation(node, getPos, editor);
  const declarationText = runnable ? readDeclarationSibling(getPos, editor) : null;
  const implementationText = runnable ? (node.textContent as string) : null;

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
        {runnable && (
          <button
            type="button"
            className="nc-codeblock-run"
            onMouseDown={(e) => {
              // Without preventDefault, ProseMirror steals focus
              // back into the code area on mousedown and we lose
              // the click.
              e.preventDefault();
            }}
            onClick={() => setRuntimeOpen(true)}
            aria-label="Run this code block"
            title="Run this code block in the ST sandbox"
          >
            Run ▶
          </button>
        )}
      </div>
      <pre className="nc-codeblock-pre">
        <NodeViewContent as="code" />
      </pre>
      {runtimeOpen && declarationText !== null && implementationText !== null && (
        <RuntimeModal
          declarationText={declarationText}
          implementationText={implementationText}
          onClose={() => setRuntimeOpen(false)}
        />
      )}
    </NodeViewWrapper>
  );
}

/**
 * Return true when this node is an Implementation block that has
 * a Declaration sibling immediately above. Both blocks must be
 * st-language code blocks.
 *
 * `getPos` and `editor` are optional in NodeViewProps in some
 * TipTap versions; we guard against absence and return false
 * (which just hides the Run button — safe fallback).
 */
function isRunnableImplementation(
  node: NodeViewProps['node'],
  getPos: NodeViewProps['getPos'],
  editor: NodeViewProps['editor'],
): boolean {
  if (typeof getPos !== 'function' || !editor) return false;

  const language = node.attrs.language as string | null;
  const title = (node.attrs.title as string | null) ?? '';
  if (language !== 'st') return false;
  if (title.toLowerCase() !== 'implementation') return false;

  const prev = readPreviousSibling(getPos, editor);
  if (!prev) return false;
  if (prev.type.name !== 'codeBlock') return false;
  if ((prev.attrs.language as string | null) !== 'st') return false;
  const prevTitle = (prev.attrs.title as string | null) ?? '';
  if (prevTitle.toLowerCase() !== 'declaration') return false;

  return true;
}

function readDeclarationSibling(
  getPos: NodeViewProps['getPos'],
  editor: NodeViewProps['editor'],
): string | null {
  const prev = readPreviousSibling(getPos, editor);
  return prev ? (prev.textContent as string) : null;
}

/**
 * Resolve the immediately-preceding sibling node, or null.
 *
 * Implementation note: getPos() returns the position of THIS
 * node's open token. The preceding sibling is reached by
 * resolving (getPos() - 1) and reading $pos.nodeBefore.
 */
function readPreviousSibling(
  getPos: NonNullable<NodeViewProps['getPos']>,
  editor: NodeViewProps['editor'],
): import('@tiptap/pm/model').Node | null {
  const pos = getPos();
  if (typeof pos !== 'number' || pos <= 0) return null;
  try {
    const $pos = editor.state.doc.resolve(pos);
    return $pos.nodeBefore ?? null;
  } catch {
    return null;
  }
}
