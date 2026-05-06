import { Extension } from '@tiptap/core';
import type { Editor as TiptapEditor } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';

import {
  StAutocompleteList,
  type AutocompleteItem,
  type StAutocompleteListHandle,
  type StAutocompleteListProps,
} from '../components/StAutocompleteList';
import { scanDeclaredVars } from './stDeclarationScan';

/**
 * F2 autocomplete inside Structured Text code blocks.
 *
 * Two modes, picked automatically from the active code block:
 *
 *   - **Declaration mode**  — when the cursor is inside any st-language
 *     code block whose title is "Declaration" (case-insensitive),
 *     OR any st code block that ISN'T paired as an Implementation
 *     of a preceding Declaration. Items: built-in scalar types
 *     (BOOL, BYTE, ..., LREAL, STRING, TIME) + common Beckhoff
 *     function blocks (TON, TOF, R_TRIG, ...). Picking inserts
 *     the type / FB name at the cursor.
 *
 *   - **Implementation mode** — when the cursor is inside an st
 *     code block titled "Implementation" whose immediate previous
 *     sibling is an st code block titled "Declaration" (the
 *     PLCOpen-import shape, identical to the Run-button rule in
 *     CodeBlockNodeView). Items: every variable parsed from the
 *     declaration block. Picking a scalar variable inserts its
 *     name. Picking an FB-instance variable inserts a call
 *     signature with the formal parameters of that FB type — e.g.
 *     `Timer01(IN := , PT := , Q => , ET => )` — and places the
 *     cursor right after the first `:= ` so the user can keep
 *     typing.
 *
 * The popup styling reuses the .nc-slash-* classes for row layout;
 * positioning uses tippy.js (same recipe SlashMenuExtension uses).
 *
 * Letter/digit/underscore keystrokes while the popup is open
 * filter the list — they're consumed before the editor sees them.
 * Esc dismisses without inserting; Enter or Tab inserts the
 * highlighted item.
 *
 * Why a separate extension instead of folding into CodeBlockWithTitle?
 * The popup state is non-trivial (tippy instance, React renderer,
 * window-level keydown listener) and the lifecycle is shorter than
 * the code block's own. Keeping it isolated means CodeBlockWithTitle
 * stays focused on the title attribute + indentation, and the F2
 * machinery can evolve (more modes, better matching) without
 * touching node serialisation.
 */

// --- Static item lists for declaration mode --------------------

interface DeclItemSeed {
  name: string;
  subtitle: string;
  keywords: string[];
}

/**
 * Built-in elementary types. Sourced manually rather than imported
 * from runtime/types.ts because (a) the runtime list is keyed for
 * its own purposes and (b) we want this set to be the user-facing
 * "what's reasonable to declare a variable as", not literally what
 * the interpreter understands. The two lists may legitimately
 * diverge over time (e.g. LTIME, DATE_AND_TIME could be added here
 * before the runtime supports them).
 */
const TYPE_ITEMS: DeclItemSeed[] = [
  { name: 'BOOL', subtitle: '1-bit boolean', keywords: ['bool', 'bit', 'flag'] },
  { name: 'BYTE', subtitle: '8-bit unsigned', keywords: ['byte', 'u8'] },
  { name: 'WORD', subtitle: '16-bit unsigned', keywords: ['word', 'u16'] },
  { name: 'DWORD', subtitle: '32-bit unsigned', keywords: ['dword', 'u32'] },
  { name: 'LWORD', subtitle: '64-bit unsigned', keywords: ['lword', 'u64'] },
  { name: 'SINT', subtitle: '8-bit signed', keywords: ['sint', 'i8'] },
  { name: 'USINT', subtitle: '8-bit unsigned', keywords: ['usint', 'u8'] },
  { name: 'INT', subtitle: '16-bit signed', keywords: ['int', 'i16'] },
  { name: 'UINT', subtitle: '16-bit unsigned', keywords: ['uint', 'u16'] },
  { name: 'DINT', subtitle: '32-bit signed', keywords: ['dint', 'i32'] },
  { name: 'UDINT', subtitle: '32-bit unsigned', keywords: ['udint', 'u32'] },
  { name: 'LINT', subtitle: '64-bit signed', keywords: ['lint', 'i64'] },
  { name: 'ULINT', subtitle: '64-bit unsigned', keywords: ['ulint', 'u64'] },
  { name: 'REAL', subtitle: '32-bit float', keywords: ['real', 'f32', 'float'] },
  { name: 'LREAL', subtitle: '64-bit float', keywords: ['lreal', 'f64', 'double'] },
  { name: 'STRING', subtitle: 'Character string', keywords: ['string', 'str', 'text'] },
  { name: 'TIME', subtitle: 'Duration (e.g. T#1s)', keywords: ['time', 'duration'] },
];

/**
 * FB types and their formal parameters, in the order TwinCAT
 * presents them in the call-completion popup. `:=` is used for
 * inputs, `=>` for outputs (matches TwinCAT's online help).
 *
 * The first input position is what we want the cursor to land on
 * after insertion — it's where the user's first edit goes.
 */
interface FbSignature {
  name: string;
  subtitle: string;
  /** Formal parameters in source order. */
  params: { name: string; isOutput: boolean }[];
  keywords: string[];
}

const FB_SIGNATURES: FbSignature[] = [
  {
    name: 'TON',
    subtitle: 'On-delay timer',
    params: [
      { name: 'IN', isOutput: false },
      { name: 'PT', isOutput: false },
      { name: 'Q', isOutput: true },
      { name: 'ET', isOutput: true },
    ],
    keywords: ['ton', 'timer', 'on-delay', 'fb'],
  },
  {
    name: 'TOF',
    subtitle: 'Off-delay timer',
    params: [
      { name: 'IN', isOutput: false },
      { name: 'PT', isOutput: false },
      { name: 'Q', isOutput: true },
      { name: 'ET', isOutput: true },
    ],
    keywords: ['tof', 'timer', 'off-delay', 'fb'],
  },
  {
    name: 'TP',
    subtitle: 'Pulse timer',
    params: [
      { name: 'IN', isOutput: false },
      { name: 'PT', isOutput: false },
      { name: 'Q', isOutput: true },
      { name: 'ET', isOutput: true },
    ],
    keywords: ['tp', 'timer', 'pulse', 'fb'],
  },
  {
    name: 'R_TRIG',
    subtitle: 'Rising edge detector',
    params: [
      { name: 'CLK', isOutput: false },
      { name: 'Q', isOutput: true },
    ],
    keywords: ['r_trig', 'rtrig', 'edge', 'rising', 'fb'],
  },
  {
    name: 'F_TRIG',
    subtitle: 'Falling edge detector',
    params: [
      { name: 'CLK', isOutput: false },
      { name: 'Q', isOutput: true },
    ],
    keywords: ['f_trig', 'ftrig', 'edge', 'falling', 'fb'],
  },
  {
    name: 'CTU',
    subtitle: 'Up counter',
    params: [
      { name: 'CU', isOutput: false },
      { name: 'RESET', isOutput: false },
      { name: 'PV', isOutput: false },
      { name: 'Q', isOutput: true },
      { name: 'CV', isOutput: true },
    ],
    keywords: ['ctu', 'counter', 'up', 'fb'],
  },
  {
    name: 'CTD',
    subtitle: 'Down counter',
    params: [
      { name: 'CD', isOutput: false },
      { name: 'LOAD', isOutput: false },
      { name: 'PV', isOutput: false },
      { name: 'Q', isOutput: true },
      { name: 'CV', isOutput: true },
    ],
    keywords: ['ctd', 'counter', 'down', 'fb'],
  },
  {
    name: 'CTUD',
    subtitle: 'Up/down counter',
    params: [
      { name: 'CU', isOutput: false },
      { name: 'CD', isOutput: false },
      { name: 'RESET', isOutput: false },
      { name: 'LOAD', isOutput: false },
      { name: 'PV', isOutput: false },
      { name: 'QU', isOutput: true },
      { name: 'QD', isOutput: true },
      { name: 'CV', isOutput: true },
    ],
    keywords: ['ctud', 'counter', 'fb'],
  },
  {
    name: 'RS',
    subtitle: 'Reset-dominant SR latch',
    params: [
      { name: 'SET', isOutput: false },
      { name: 'RESET1', isOutput: false },
      { name: 'Q1', isOutput: true },
    ],
    keywords: ['rs', 'latch', 'sr', 'fb'],
  },
  {
    name: 'SR',
    subtitle: 'Set-dominant SR latch',
    params: [
      { name: 'SET1', isOutput: false },
      { name: 'RESET', isOutput: false },
      { name: 'Q1', isOutput: true },
    ],
    keywords: ['sr', 'latch', 'rs', 'fb'],
  },
];

/**
 * Render the call-signature insertion text for an FB at the given
 * instance name. Returns both the text and the cursor offset (so
 * the editor can place the caret right after the first `:= `).
 *
 * Example: instance="Timer01", fb=TON →
 *   text  = "Timer01(IN := , PT := , Q => , ET => )"
 *   caret = position right after "IN := "
 */
function renderFbCall(instance: string, fb: FbSignature): { text: string; caretOffset: number } {
  const parts = fb.params.map((p) => `${p.name} ${p.isOutput ? '=>' : ':='} `);
  const joined = parts.join(', ');
  const text = `${instance}(${joined})`;

  // First input parameter — that's where the cursor goes. If the
  // FB has only outputs (none currently in the list, but be
  // defensive), fall back to right after the first `=> `.
  const firstInput = fb.params.findIndex((p) => !p.isOutput);
  const targetIdx = firstInput === -1 ? 0 : firstInput;
  const prefix = `${instance}(` + parts.slice(0, targetIdx).join(', ') + (targetIdx > 0 ? ', ' : '') + parts[targetIdx];
  return { text, caretOffset: prefix.length };
}

/**
 * Build the menu items for declaration mode.
 *
 * Order matches the user's typical declaration flow: scalars by
 * width, then STRING / TIME, then FBs. Within a group the order
 * mirrors TwinCAT's auto-complete.
 */
function buildDeclarationItems(): AutocompleteItem[] {
  const items: AutocompleteItem[] = [];

  for (const t of TYPE_ITEMS) {
    items.push({
      title: t.name,
      subtitle: t.subtitle,
      insertText: t.name,
      keywords: t.keywords,
    });
  }
  for (const fb of FB_SIGNATURES) {
    items.push({
      title: fb.name,
      subtitle: fb.subtitle,
      insertText: fb.name,
      keywords: fb.keywords,
    });
  }
  return items;
}

/**
 * Build the menu items for implementation mode given the variables
 * scanned from the declaration block.
 *
 * For each variable:
 *   - If its type is a known FB type → insert a call-signature
 *     using the instance name + that FB's formal parameters.
 *   - Otherwise → insert just the variable name.
 *
 * Subtitle shows the type name so the user can disambiguate (`i :
 * INT` vs `i : DINT` vs `i : Counter` user-defined).
 */
function buildImplementationItems(declText: string): AutocompleteItem[] {
  const vars = scanDeclaredVars(declText);
  const fbByName = new Map<string, FbSignature>();
  for (const fb of FB_SIGNATURES) fbByName.set(fb.name.toUpperCase(), fb);

  const items: AutocompleteItem[] = [];
  for (const v of vars) {
    const typeUpper = v.type.toUpperCase();
    const fb = fbByName.get(typeUpper);
    if (fb) {
      const rendered = renderFbCall(v.name, fb);
      items.push({
        title: v.name,
        subtitle: `${v.type} — function block call`,
        insertText: rendered.text,
        caretOffset: rendered.caretOffset,
        keywords: [v.name.toLowerCase(), v.type.toLowerCase(), 'fb', 'call'],
      });
    } else {
      items.push({
        title: v.name,
        subtitle: v.type,
        insertText: v.name,
        keywords: [v.name.toLowerCase(), v.type.toLowerCase()],
      });
    }
  }
  return items;
}

// --- Mode resolution -------------------------------------------

interface ResolvedMode {
  kind: 'declaration' | 'implementation';
  items: AutocompleteItem[];
  heading: string;
}

/**
 * Inspect the editor state and pick a mode. Returns null when F2
 * shouldn't fire (cursor outside an st code block, or inside one
 * but the surrounding doc is in some unexpected shape).
 */
function resolveMode(editor: ResolveEditor): ResolvedMode | null {
  const { state } = editor;
  const { $from } = state.selection;

  // Walk up the ancestor chain looking for a codeBlock node. We
  // don't use editor.isActive('codeBlock') because we also need
  // the node itself + its position to inspect siblings.
  let codeBlock: { node: AnyNode; pos: number } | null = null;
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'codeBlock') {
      codeBlock = { node, pos: $from.before(depth) };
      break;
    }
  }
  if (!codeBlock) return null;

  const language = (codeBlock.node.attrs.language as string | null) ?? null;
  if (language !== 'st') return null;

  const title = ((codeBlock.node.attrs.title as string | null) ?? '').toLowerCase();

  if (title === 'implementation') {
    // Look at the previous sibling. If it's an st code block titled
    // "Declaration" we're in implementation mode and we have a
    // declaration to scan.
    const $here = state.doc.resolve(codeBlock.pos);
    const before = $here.nodeBefore;
    if (
      before &&
      before.type.name === 'codeBlock' &&
      ((before.attrs.language as string | null) ?? null) === 'st' &&
      ((before.attrs.title as string | null) ?? '').toLowerCase() === 'declaration'
    ) {
      const declText = before.textContent;
      const items = buildImplementationItems(declText);
      return {
        kind: 'implementation',
        items,
        heading: 'Declared variables',
      };
    }
    // Fall through: titled "Implementation" but no Declaration
    // sibling. Treat as a generic st block — declaration items.
  }

  return {
    kind: 'declaration',
    items: buildDeclarationItems(),
    heading: 'Types & function blocks',
  };
}

// Minimal structural type aliases so this file doesn't need a hard
// dependency on the prosemirror-model types beyond what the editor
// gives us through its public API.
interface AnyNode {
  type: { name: string };
  attrs: Record<string, unknown>;
  textContent: string;
  nodeSize: number;
}
interface ResolveEditor {
  state: {
    selection: { $from: AnyResolvedPos };
    doc: { resolve(pos: number): AnyResolvedPos };
  };
}
interface AnyResolvedPos {
  depth: number;
  node(depth: number): AnyNode;
  before(depth: number): number;
  nodeBefore: AnyNode | null;
}

// --- The extension itself --------------------------------------

export const StAutocompleteExtension = Extension.create({
  name: 'stAutocomplete',

  addKeyboardShortcuts() {
    return {
      F2: () => {
        // Only activate inside a code block. The mode resolver
        // returns null for non-st blocks, but checking here saves
        // us from constructing a popup we'd immediately throw away.
        if (!this.editor.isActive('codeBlock')) return false;
        openPopup(this.editor as unknown as RealEditor);
        return true;
      },
    };
  },
});

// --- Popup orchestration ---------------------------------------

// We only allow one popup open at a time, app-wide. Pressing F2
// while a popup is already open re-opens it at the new cursor —
// the cleanest way to "refresh" the position.
let active: ActivePopup | null = null;

interface ActivePopup {
  destroy(): void;
}

/** Real editor type — kept narrow to what we actually use. */
interface RealEditor {
  state: {
    selection: { $from: AnyResolvedPos; from: number };
    doc: { resolve(pos: number): AnyResolvedPos };
  };
  view: {
    coordsAtPos(pos: number): { left: number; right: number; top: number; bottom: number };
  };
  chain(): EditorChain;
  commands: {
    setTextSelection(pos: number): boolean;
  };
}
interface EditorChain {
  focus(): EditorChain;
  setTextSelection(pos: number): EditorChain;
  insertContent(text: string): EditorChain;
  run(): boolean;
}

function openPopup(editor: RealEditor): void {
  if (active) {
    active.destroy();
    active = null;
  }

  const mode = resolveMode(editor);
  if (!mode) return;

  // Snapshot the cursor position at the moment F2 is pressed. The
  // popup may be open while the editor's selection technically
  // moves (it shouldn't, since we capture all keys, but pile-up
  // events from a long task could). We insert at this captured
  // position so the result is predictable.
  const insertionAnchor = editor.state.selection.from;

  // Compute the screen position for tippy. coordsAtPos returns a
  // 0-width caret rect; we present it as a 1×1 DOMRect.
  const coords = editor.view.coordsAtPos(insertionAnchor);
  const referenceClientRect = (): DOMRect =>
    domRectFromCaret(coords.left, coords.top, coords.bottom);

  // Render the React component. We keep the renderer's element
  // alive across filter typing — only the props (items + command)
  // change.
  const renderer = new ReactRenderer<StAutocompleteListHandle, StAutocompleteListProps>(
    StAutocompleteList,
    {
      props: {
        items: mode.items,
        heading: mode.heading,
        command: (item: AutocompleteItem) => insertAndClose(editor, insertionAnchor, item),
      },
      // ReactRenderer requires an Editor for the editor prop. We
      // cast through unknown because our local RealEditor interface
      // is intentionally narrower than @tiptap/core's Editor (we
      // only use a handful of methods). The renderer never reads
      // editor inside our component, so the cast is safe at runtime.
      editor: editor as unknown as TiptapEditor,
    },
  );

  const popup: TippyInstance = tippy(document.body, {
    getReferenceClientRect: referenceClientRect,
    appendTo: () => document.body,
    content: renderer.element,
    showOnCreate: true,
    interactive: true,
    trigger: 'manual',
    placement: 'bottom-start',
    arrow: false,
    theme: 'light-border',
    maxWidth: 360,
  });

  // Window-level keydown listener. We capture all keys the popup
  // wants and prevent them from reaching the editor. Esc closes
  // unconditionally.
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      destroy();
      return;
    }
    const handle = renderer.ref;
    if (handle && handle.onKeyDown(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  // Capture-phase listener so we beat the editor's own keydown
  // handlers (TipTap binds at the contenteditable). The editor's
  // F2 binding has already fired by the time we get here (that's
  // what opened us), so capture-phase only matters for subsequent
  // keys.
  window.addEventListener('keydown', onKey, true);

  // Click outside dismisses. We use mousedown so the editor's
  // selection-on-click happens AFTER we've torn down (otherwise
  // the user clicks somewhere and the popup briefly relocates).
  const onMouseDown = (event: MouseEvent) => {
    if (popup.popper.contains(event.target as Node)) return;
    destroy();
  };
  document.addEventListener('mousedown', onMouseDown, true);

  function destroy(): void {
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    popup.destroy();
    renderer.destroy();
    if (active && active.destroy === destroy) active = null;
  }

  active = { destroy };
}

/**
 * Build a 1×1 DOMRect at the caret. The polyfilled `DOMRect` is
 * available in every browser we ship to; constructing one is
 * cheaper than tippy's own offset acrobatics.
 */
function domRectFromCaret(left: number, top: number, bottom: number): DOMRect {
  return new DOMRect(left, top, 1, bottom - top);
}

/**
 * Apply a chosen item's insertion. If the item carries a
 * caretOffset, set the selection to that offset within the just-
 * inserted text.
 */
function insertAndClose(
  editor: RealEditor,
  anchor: number,
  item: AutocompleteItem,
): void {
  // The popup also captured Esc / Enter / etc — we must close it
  // before mutating the editor so the popup's keydown handler
  // doesn't fight us on the next event loop. The active-ref check
  // tolerates the popup having been closed already.
  if (active) {
    active.destroy();
    active = null;
  }

  // Insert at the captured anchor. We explicitly setTextSelection
  // first because `insertContent` inserts at the editor's CURRENT
  // selection — and although our keystroke capture should keep the
  // selection at the original anchor, a stray event leak (e.g. a
  // browser autocomplete popup intercepting then releasing focus)
  // could move it. Anchoring first makes the insertion point
  // deterministic.
  //
  // Inside a code block ProseMirror won't try to parse markdown /
  // paragraphs out of the inserted text — single text node only.
  editor
    .chain()
    .focus()
    .setTextSelection(anchor)
    .insertContent(item.insertText)
    .run();

  // If the item asks for a specific caret position, apply it. We
  // use the anchor + offset because the just-inserted text starts
  // at the anchor.
  if (typeof item.caretOffset === 'number') {
    const target = anchor + item.caretOffset;
    editor.commands.setTextSelection(target);
  }
}
