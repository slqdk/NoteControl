import { useState } from 'react';
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from '@tiptap/react';

import { RuntimeModal } from './RuntimeModal';
import {
  collectActionBodies,
  expandActions,
} from '../editor/actionExpansion';

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

  // Run-button state. Ship 2 (action expansion) replaces the
  // earlier single-boolean `runtimeOpen` with an "opened with
  // these texts" state, because the implementation text shown in
  // (and run by) the modal is the *post-expansion* form — actions
  // called from the main body have been inlined into it. We hold
  // both the declaration and implementation in state so the modal
  // sees a consistent snapshot taken at click time, not a value
  // that might race with editor edits during the modal session.
  const [runtimePayload, setRuntimePayload] = useState<{
    declarationText: string;
    implementationText: string;
  } | null>(null);

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

  // Determine whether to show the Run button — same rule as before:
  // st-language Implementation with a Declaration sibling above.
  // Actions don't satisfy this triplet (the slash menu emits them
  // with prefixed titles like "ACTION Foo — Implementation"), so
  // the Run button still appears ONLY on the POU's main body
  // block. That's deliberate: the entire FB + its actions is the
  // unit you run.
  const runnable = isRunnableImplementation(node, getPos, editor);

  /**
   * Run-click handler.
   *
   * Three steps:
   *   1. Read the Declaration sibling (existing behaviour).
   *   2. Walk the document for st-language code blocks whose title
   *      matches the "ACTION <name> — Implementation" pattern,
   *      and build a name → body map. This snapshot is taken at
   *      click time so subsequent edits don't change what we run.
   *   3. Expand action calls in the implementation source. On
   *      expansion failure (recursive action cycle, primarily),
   *      surface the error via window.alert and abort — leaves
   *      the editor untouched, the user can investigate.
   *
   * Success: stash the expanded payload in state, which triggers
   * the modal to render with the snapshot.
   *
   * Note: we deliberately don't memoise step (2) across renders.
   * The walk is O(top-level-children) and happens once per click;
   * caching would add complexity for a sub-millisecond saving.
   */
  function handleRunClick(): void {
    if (typeof getPos !== 'function' || !editor) return;
    const declarationText = readDeclarationSibling(getPos, editor) ?? '';
    const rawImplementation = node.textContent as string;
    const actionBodies = collectActionBodiesFromDoc(editor);

    let expanded: string;
    try {
      expanded = expandActions(rawImplementation, actionBodies);
    } catch (e) {
      window.alert(
        `Couldn't run this code block.\n\n${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    setRuntimePayload({
      declarationText,
      implementationText: expanded,
    });
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
            onClick={handleRunClick}
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
      {runtimePayload && (
        <RuntimeModal
          declarationText={runtimePayload.declarationText}
          implementationText={runtimePayload.implementationText}
          onClose={() => setRuntimePayload(null)}
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

/**
 * Walk top-level document children, find all st-language code
 * blocks, and build an ActionBodies map keyed by lower-cased
 * action name. Used by the Run handler to snapshot the action
 * universe at click time.
 *
 * Top-level only: the slash menu always inserts FBs (and their
 * member sections) flush at the document root. Nesting a code
 * block inside a callout or a table cell is technically possible
 * in TipTap but isn't a path the PLCOpenXML importer creates, so
 * we don't search inside containers. If someone manually authored
 * an action block inside a callout it just won't be picked up —
 * a known limitation that's never going to surprise an importer
 * user.
 */
function collectActionBodiesFromDoc(
  editor: NonNullable<NodeViewProps['editor']>,
): ReturnType<typeof collectActionBodies> {
  const blocks: Array<{ title: string | null; language: string | null; text: string }> = [];
  editor.state.doc.forEach((child) => {
    if (child.type.name !== 'codeBlock') return;
    const title = (child.attrs.title as string | null) ?? null;
    const language = (child.attrs.language as string | null) ?? null;
    const text = child.textContent as string;
    blocks.push({ title, language, text });
  });
  return collectActionBodies(blocks);
}
