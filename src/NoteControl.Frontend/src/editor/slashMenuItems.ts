import type { Editor, Range } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';

import { ApiError, assetsApi, templatesApi } from '../api/client';
import {
  parsePlcopenXml,
  type PlcopenPou,
  type PlcopenMember,
  type PlcopenMemberKind,
  type PlcopenTreeNode,
} from './plcopenImport';
import { importFromGitHubUrl } from './tcpouImport';
import { getCachedTemplates } from './templateCache';

/**
 * One row in the slash-menu popup.
 *
 *   title    — primary label shown in the menu
 *   subtitle — secondary description (one line, optional)
 *   icon     — single-character glyph or short emoji
 *   keywords — extra strings that should match in the filter beyond
 *              the title (e.g. "h1" for heading-1)
 *   command  — invoked when the user picks the item. It receives
 *              the editor and the range that should be REPLACED
 *              (i.e. the "/" plus whatever filter text the user
 *              typed). The command must consume that range itself,
 *              typically via an editor.chain().focus().deleteRange().run()
 *              before doing its own insertion.
 *
 *              Optional when `submenuItems` is set — picking the
 *              item opens the submenu instead of running a command.
 *
 *   submenuItems — if set, picking the item navigates the slash
 *              menu's UI into a submenu showing these items
 *              instead. The submenu inherits the same trigger
 *              range; selecting an item in the submenu runs that
 *              item's command using the original range.
 */
export interface SlashMenuItem {
  title: string;
  subtitle?: string;
  icon: string;
  keywords?: string[];
  /** Optional. Required unless submenuItems is set. */
  command?: (args: { editor: Editor; range: Range }) => void | Promise<void>;
  /** Optional. If present, picking this item swaps the popup into submenu mode. */
  submenuItems?: () => SlashMenuItem[];
  /**
   * If true, this row is rendered with a different visual style
   * to indicate it's a back-navigation rather than an action.
   * Used in submenus to provide a way back to the main list.
   */
  isBack?: boolean;
}

/**
 * Args passed to the command-resolver below by the suggestion
 * plugin. `getNotePath` and `vaultId` are needed for the Image
 * picker, which uploads to the current note's assets folder.
 *
 * Two flags control which dynamic items appear:
 *
 *   allowImages    — include the "Image" item that opens a file
 *                    picker. Pre-Ship-98 templates set this false
 *                    because they had no asset folder. Ship 98
 *                    introduces template asset folders, so the
 *                    template editor now sets allowImages=true and
 *                    sets `templateName` to route uploads through
 *                    the template-asset endpoint instead.
 *
 *   allowTemplates — include the per-template items pulled from
 *                    the cache. Templates set this false to avoid
 *                    nested-template recursion in the picker
 *                    experience (a template inserting another
 *                    template is technically fine but confusing).
 *
 * Both default to true (the note-editor's behaviour).
 *
 * `templateName` (Ship 98): when set, the Image command uploads
 * via `templatesApi.uploadAsset` instead of `assetsApi.upload`.
 * When unset (the note editor's case), uploads go through the
 * note-asset path. The two are mutually exclusive — a given
 * editor instance is either editing a note (uses getNotePath) or
 * a template (uses templateName).
 */
export interface SlashMenuContext {
  getNotePath: () => string;
  vaultId: string;
  allowImages?: boolean;
  allowTemplates?: boolean;
  templateName?: string;
  /**
   * Optional handler for the Table item. When provided, picking
   * Table calls this instead of inserting a default 3×3 — the host
   * editor can show its TableInsertDialog and run insertTable with
   * the user's chosen rows/cols/header/rowHeight.
   *
   * The trigger range (the "/" plus typed filter) has already been
   * deleted from the editor by the slash menu's command runner
   * before this is called, so the host just needs to focus and
   * insertTable when the dialog confirms — no range bookkeeping.
   *
   * If this is NOT provided, the Table item falls back to the
   * legacy immediate-3×3-insert behaviour. Keeps headless callers
   * (tests, future template-of-template scenarios) working without
   * having to plumb a dialog through.
   */
  onTableInsertRequest?: () => void;
}

/**
 * Insert one or more PLCOpen POUs at the current selection.
 * Per POU we emit, in order:
 *
 *   1. A paragraph header in the form **<name>** (<pouType>) — this
 *      is just a styled paragraph rather than a Heading because an
 *      imported POU is body content, not a top-level section. Users
 *      can promote it to a heading themselves if they want.
 *
 *   2. (NEW) A tree-view header when the POU has any members or
 *      folders: a bold "Structure" paragraph followed by a nested
 *      bullet list showing folders + members in document order.
 *      The bullet list is plain prosemirror — no custom node type —
 *      so it round-trips through markdown trivially as nested
 *      bullets. Each leaf bullet labels the member kind (METHOD,
 *      ACTION, PROPERTY GET, PROPERTY SET). Tree-view is display-
 *      only: clicking a bullet has no effect (no scroll-to, no
 *      collapse), matching the spec for Ship 1.
 *
 *   3. A code block with title "Declaration", language "st",
 *      containing the FB/POU declaration text.
 *
 *   4. A code block with title "Implementation", language "st",
 *      containing the FB/POU implementation text.
 *
 *   5. For each Method / Action / Property accessor, in document
 *      order: a small bold paragraph header naming the member
 *      (with kind tag), followed by 1 or 2 code blocks:
 *        - Method:   Declaration + Implementation pair (titles
 *                    "Declaration" / "Implementation" — so users
 *                    can see the method's signature).
 *        - Action:   Implementation only, title "Implementation"
 *                    of an action carries no declaration in
 *                    TwinCAT — actions share their parent FB's
 *                    scope. The lack of a Declaration sibling
 *                    means the runtime Run button (which keys off
 *                    a Declaration+Implementation triplet) does
 *                    NOT appear next to action implementations
 *                    in Ship 1; the runtime hookup for actions
 *                    lands in Ship 2.
 *        - Property: each accessor (Get / Set) gets its own
 *                    Declaration + Implementation pair.
 *
 *      Member headers use "ACTION", "METHOD", "PROPERTY GET",
 *      "PROPERTY SET" as the kind tag (uppercase, matches
 *      TwinCAT's vocabulary). The Run button is intentionally
 *      suppressed on every member because no member's title is
 *      bare "Implementation" with a preceding sibling whose
 *      title is bare "Declaration" — the sibling structure is
 *      a paragraph header in between, breaking the triplet rule
 *      used by CodeBlockNodeView.isRunnableImplementation.
 *
 *      Wait — that's wrong. The titles ARE bare "Declaration" and
 *      "Implementation". To prevent the Run button appearing on
 *      every method, we'd need different titles OR we'd need to
 *      tighten the runnable rule. We do the simple thing: prefix
 *      the member's titles with the kind+name, e.g.
 *      "METHOD AbortMover Declaration" / "METHOD AbortMover
 *      Implementation". That keeps them out of the runnable
 *      triplet (which case-insensitively requires the literal
 *      strings "Declaration" / "Implementation"), and double-duty
 *      makes the title obvious in collapsed listings.
 *
 * Between consecutive POUs we drop an empty paragraph so they're
 * visually separated. After the last POU we also drop an empty
 * paragraph and place the cursor in it — same finishing touch
 * the regular slash items use via insertTrailingParagraph.
 *
 * The whole insertion goes through one editor.chain().insertContent()
 * call so it's a single undo step. Building the prosemirror JSON
 * directly (rather than chaining toggleCodeBlock + setNode etc.)
 * keeps the title / language attributes on each code block from
 * leaking onto the next one.
 */
function insertPousAtSelection(editor: Editor, pous: PlcopenPou[]): void {
  if (pous.length === 0) return;

  type Json = Record<string, unknown>;
  const content: Json[] = [];

  pous.forEach((pou, index) => {
    if (index > 0) {
      content.push({ type: 'paragraph' });
    }

    // (1) Header paragraph: bold POU name, optional pouType.
    const headerInline: Json[] = [
      {
        type: 'text',
        marks: [{ type: 'bold' }],
        text: pou.name,
      },
    ];
    if (pou.pouType) {
      headerInline.push({ type: 'text', text: ` (${pou.pouType})` });
    }
    content.push({ type: 'paragraph', content: headerInline });

    // (2) Tree-view header (only if there's a tree to show).
    // (2) Tree-view header (only if there's a tree to show).
    // We render the hierarchy as plain ASCII inside a single
    // language="text" code block titled "Structure". The big
    // visual win over a bulletList is vertical density: a bullet
    // listItem in TipTap defaults to ~36px tall (paragraph
    // margins + list indent + line-height), so a POU with 17
    // members ate ~600px of screen before the user reached any
    // actual code. A code-block line is line-height 1.4 over a
    // 13-14px font, roughly 20px tall — that's a 50% reduction.
    //
    // Layout convention used here:
    //   - Top-level entries (folders + members directly under the
    //     POU) are emitted flush-left with no tree connector. The
    //     POU itself is the implicit root and isn't redrawn.
    //   - Folder children are indented one step and decorated with
    //     '├─' (intermediate) and '└─' (last) per the standard
    //     box-drawing tree convention.
    //   - Members orphaned by a partial ProjectStructure are
    //     appended flush-left after all tree entries (same fall-
    //     back behaviour as before — nothing dropped).
    //
    // language: "text" + title: "Structure" intentionally:
    //   * "text" suppresses ST syntax highlighting (identifiers
    //     like "AbortMover" would otherwise get coloured as
    //     symbols), and also keeps the runtime Run button from
    //     appearing (CodeBlockNodeView gates on language === "st").
    //   * "Structure" as the title makes the small header bar
    //     above the block self-documenting.
    const members = pou.members ?? [];
    const tree = pou.tree ?? [];
    if (members.length > 0 || tree.length > 0) {
      const asciiTree = buildAsciiTree(tree, members);
      if (asciiTree.length > 0) {
        content.push({
          type: 'codeBlock',
          attrs: { title: 'Structure', language: 'text' },
          content: [{ type: 'text', text: asciiTree }],
        });
      }
    }

    // (3) Declaration + (4) Implementation for the POU body.
    // Titles are bare "Declaration" / "Implementation" so the
    // existing runtime Run button keeps working for POU-level
    // ST exactly as before.
    content.push(codeBlockNode('Declaration', pou.declaration));
    content.push(codeBlockNode('Implementation', pou.implementation));

    // (5) Per-member sections. Skipped silently if empty.
    for (const m of members) {
      // Empty separator paragraph between members so the wall of
      // code blocks gets visible breathing room. (Inserting at
      // document level, prosemirror collapses adjacent paragraphs
      // visually anyway — but the header paragraph below this
      // creates the actual gap.)
      content.push(...buildMemberSection(m));
    }
  });

  // Trailing paragraph so the cursor lands on a fresh line and
  // the user can immediately keep writing.
  content.push({ type: 'paragraph' });

  editor.chain().focus().insertContent(content).run();
}

/**
 * Render the parsed tree (PlcopenTreeNode[]) as an ASCII text
 * block suitable for insertion into a language="text" code block.
 *
 * Cross-references the `members` list to resolve each leaf's
 * actual kind — the tree parser stores a placeholder memberKind
 * because the structural XML (<Object Name="..." ObjectId=".."/>)
 * doesn't say what kind a leaf is; only the member parser knows.
 *
 * Unresolved leaves (an ObjectId in the tree that doesn't match
 * any parsed member) are kept anyway, labelled with the leaf's
 * name only — that's better than silently dropping them, because
 * an unmatched ObjectId is almost certainly a kind of member we
 * didn't parse (e.g. a transition) and the user should still see
 * its name in the overview.
 *
 * After the tree's own entries we append any members NOT mentioned
 * in the tree (orphans), flush-left at the root. That covers the
 * case where ProjectStructure is partial — every member still
 * shows up in the structure header.
 *
 * Output shape (top-level flush-left, folder contents indented
 * with box-drawing connectors):
 *
 *   📁 InternalMethods
 *   └─ METHOD  DetectFirstScan
 *   METHOD  AbortMover
 *   METHOD  AddMoverToTrack
 *   ...
 *
 * Returns an empty string when there are no entries at all
 * (caller suppresses the code block in that case).
 */
function buildAsciiTree(
  tree: PlcopenTreeNode[],
  members: PlcopenMember[],
): string {
  // Build an objectId → kind index for the leaf-kind resolution.
  // We dedupe by objectId because a property can produce two
  // accessor entries with the same objectId, and the tree-view
  // probably wants to show "Property GET/SET" once.
  const kindByObjectId = new Map<string, PlcopenMemberKind>();
  for (const m of members) {
    if (m.objectId && !kindByObjectId.has(m.objectId)) {
      kindByObjectId.set(m.objectId, m.kind);
    }
  }

  // Track ObjectIds referenced anywhere in the tree so we can
  // identify orphans.
  const referenced = new Set<string>();
  collectReferencedIds(tree, referenced);

  const lines: string[] = [];

  // Top-level entries flush-left, no connectors. Folder contents
  // get one-step indent and box-drawing connectors via the
  // recursive helper below.
  for (const node of tree) {
    renderTreeNode(node, '', true, kindByObjectId, lines, /*topLevel*/ true);
  }

  // Append orphan members flush-left.
  for (const m of members) {
    if (!m.objectId || !referenced.has(m.objectId)) {
      lines.push(formatLeaf(m.name, m.kind));
    }
  }

  return lines.join('\n');
}

function collectReferencedIds(
  tree: PlcopenTreeNode[],
  out: Set<string>,
): void {
  for (const n of tree) {
    if (n.kind === 'folder') {
      collectReferencedIds(n.children, out);
    } else if (n.objectId) {
      out.add(n.objectId);
    }
  }
}

/**
 * Recursive ASCII tree renderer.
 *
 * `prefix` is the indent string accumulated from ancestors —
 * either "" at the top, or some combination of "│  " / "   "
 * for each level of nesting (the bar continues when there are
 * more siblings ahead at that level, the spaces continue when
 * the ancestor was the last child). At THIS level, the line is
 * prefixed with the parent's `prefix` plus either "├─ " or
 * "└─ " (last-sibling).
 *
 * `topLevel` suppresses the connectors for the top-level call
 * (folders and members directly under the POU). Top-level rows
 * are flush-left for a cleaner overview; only items inside
 * folders get tree connectors. The POU itself is the implicit
 * root and is never redrawn.
 */
function renderTreeNode(
  node: PlcopenTreeNode,
  prefix: string,
  isLast: boolean,
  kindByObjectId: Map<string, PlcopenMemberKind>,
  out: string[],
  topLevel: boolean,
): void {
  const connector = topLevel ? '' : (isLast ? '└─ ' : '├─ ');
  const childIndent = topLevel ? '' : prefix + (isLast ? '   ' : '│  ');

  if (node.kind === 'folder') {
    out.push(prefix + connector + `📁 ${node.name}`);
    const kids = node.children;
    kids.forEach((child, i) => {
      renderTreeNode(
        child,
        childIndent,
        i === kids.length - 1,
        kindByObjectId,
        out,
        /*topLevel*/ false,
      );
    });
  } else {
    // Member leaf. Resolve kind from objectId; fall back to the
    // placeholder the parser gave us.
    const resolvedKind = kindByObjectId.get(node.objectId) ?? node.memberKind;
    out.push(prefix + connector + formatLeaf(node.name, resolvedKind));
  }
}

/**
 * Format a single member-leaf line: "METHOD  Name" (two spaces
 * between the kind label and the name — wider than one looks
 * deliberate, narrower than tab risks alignment surprises if the
 * user's monospace font is unusual). Used by both the in-tree
 * walk and the orphan-append step.
 */
function formatLeaf(name: string, kind: PlcopenMemberKind): string {
  return `${kindLabel(kind)}  ${name}`;
}

/** "METHOD" / "ACTION" / "PROPERTY GET" / "PROPERTY SET". */
function kindLabel(kind: PlcopenMemberKind): string {
  switch (kind) {
    case 'method': return 'METHOD';
    case 'action': return 'ACTION';
    case 'property-get': return 'PROPERTY GET';
    case 'property-set': return 'PROPERTY SET';
  }
}

/** Build the prosemirror JSON for one member's code-block section:
 *  a small bold header paragraph naming the member, then 1–2 code
 *  blocks (Declaration + Implementation for methods/properties,
 *  Implementation only for actions). Code-block titles are
 *  prefixed with the kind + name so they don't accidentally satisfy
 *  the runnable-triplet rule used by CodeBlockNodeView. */
function buildMemberSection(m: PlcopenMember): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];

  // Header: "**METHOD** AbortMover" — kind label bolded, name plain.
  out.push({
    type: 'paragraph',
    content: [
      {
        type: 'text',
        marks: [{ type: 'bold' }],
        text: kindLabel(m.kind),
      },
      { type: 'text', text: `  ${m.name}` },
    ],
  });

  // Action: implementation only. Method / property accessor:
  // declaration + implementation. We use prefixed titles so the
  // Run button only triggers on the POU's main Declaration/
  // Implementation pair, not on every member.
  const titlePrefix =
    m.kind === 'method' ? `${kindLabel(m.kind)} ${m.name}` :
    m.kind === 'action' ? `${kindLabel(m.kind)} ${m.name}` :
    `${kindLabel(m.kind)} ${m.name}`;

  if (m.kind !== 'action') {
    out.push(codeBlockNode(`${titlePrefix} — Declaration`, m.declaration));
  }
  out.push(codeBlockNode(`${titlePrefix} — Implementation`, m.implementation));

  return out;
}

/**
 * Build a prosemirror JSON node for a code block with the given
 * title and ST source. Empty source becomes a code block with no
 * inner text content (which prosemirror renders as an empty
 * editable code area — fine).
 */
function codeBlockNode(title: string, source: string): Record<string, unknown> {
  const node: Record<string, unknown> = {
    type: 'codeBlock',
    attrs: { title, language: 'st' },
  };
  if (source.length > 0) {
    node.content = [{ type: 'text', text: source }];
  }
  return node;
}

/**
 * Build the SupportCall skeleton as an array of real prosemirror
 * Node instances:
 *
 *   <info callout>
 *     <paragraph>**Kunde**</paragraph>
 *   </info callout>
 *   <table>
 *     <row>  Project :                <empty cell>
 *     <row>  Kontakt person :         <empty cell>
 *     <row>  Hardware :               <empty cell>
 *     <row>  Software :               <empty cell>
 *     <row>  Remote ID / Password :   <empty cell>
 *     <row>  Problem beskrivelse :    <empty cell>
 *   </table>
 *   <paragraph/>
 *
 * Why schema nodes (not raw JSON):
 *
 * Earlier revisions built this as a plain `insertContent` JSON
 * payload. That worked for the callout and the paragraphs, but the
 * resulting TABLE rendered with a phantom thin third column on the
 * left — the table-resize plugin's colgroup measurement gets
 * confused when cells come in without their default attributes
 * (colspan / rowspan / colwidth) materialised. Building real Node
 * instances via the schema's `create` / `createChecked` runs the
 * normal default-attr resolution, so every tableCell carries the
 * canonical `{ colspan: 1, rowspan: 1, colwidth: null }` set —
 * which is what tiptap-table's plugin expects when computing the
 * column layout on first paint.
 *
 * Cell-height behaviour: the table has NO rowHeight attribute.
 * Rows size to fit their content via the upstream table CSS —
 * pressing Enter inside any cell inserts a hard break and the
 * cell grows downward. (rowHeight, when set, would pin every row
 * to a fixed pixel height and force overflow inside the cell.)
 *
 * Label asymmetry: "Project :" is bolded because it's the primary
 * identifier — matches the screenshot the request was based on.
 * The other five labels render plain. Tweak by passing different
 * bold flags to `labelCell`.
 *
 * The trailing empty paragraph below the table gives the user a
 * clickable escape line beneath the inserted block, same pattern
 * the callout extension uses for its own insertCallout.
 */
/**
 * Build the SupportCall skeleton.
 *
 *   <info callout>
 *     <paragraph>**Kunde**</paragraph>
 *   </info callout>
 *   <table>                              ← the resizable structure
 *     <row>  Project : [180]  | _ [540]   ← first row pins col widths
 *     <row>  Kontakt person :
 *     <row>  Hardware :
 *     <row>  Software :
 *     <row>  Remote ID / Password :
 *     <row>  Problem beskrivelse :
 *   </table>
 *   <paragraph/>
 *
 * History — why this isn't wrapped in an outer 1×1 frame:
 *
 * An earlier ship wrapped the callout + table in an outer 1×1
 * table so the whole composition was draggable as a single frame.
 * That broke at the markdown serializer (TableWithOptions's HTML
 * emitter only writes cell.textContent, no recursion through
 * nested block content) — saving the note flattened the whole
 * thing into a single cell containing all the labels concatenated,
 * and re-parsing produced nothing. Also: the nested table was
 * almost impossible for the user to delete via normal keyboard
 * gestures.
 *
 * The redesign drops the outer frame. The inner table alone gives
 * the user width-adjustability (its column-resize handle on the
 * right edge), and the callout sits above as a labelled cap. The
 * "frame" affordance is gone but the resize affordance — which
 * is what the user actually asked for — is intact, and the
 * structure round-trips cleanly through the existing serializer
 * because it's the same flat shape regular tables use.
 *
 * Column widths (set on the FIRST row's cells per prosemirror-
 * tables convention; subsequent rows inherit):
 *
 *   - Label column: 180px. Enough for "Remote ID / Password :"
 *     and "Problem beskrivelse :" — the two longest labels —
 *     without wrapping. Earlier 160px was just slightly too
 *     narrow; the wrap was visible in the user's screenshot.
 *
 *   - Value column: 540px. 180 + 540 = 720px total, which is
 *     the default table width on insert. The user can drag the
 *     column-resize handle (the right edge of any cell border)
 *     to resize after insert.
 *
 * Cell-height behaviour: no rowHeight on the table, so cells size
 * to fit their content via the upstream table CSS — pressing
 * Enter inside any cell inserts a hard break and the cell grows
 * downward.
 *
 * Label asymmetry: "Project :" is bolded (primary identifier).
 *
 * Three values returned (callout, table, trailing). The caller
 * assembles them into a single Fragment and passes that to one
 * insertContent call — see the command-site comment for the
 * history of why neither chained inserts nor a JS array of nodes
 * works in this case.
 */
function supportCallNodes(editor: Editor): {
  callout: ProseMirrorNode;
  table: ProseMirrorNode;
  trailing: ProseMirrorNode;
} {
  const schema = editor.schema;
  const boldMark = schema.marks.bold;

  // --- Cell helpers ---------------------------------------------------
  // labelCell builds a tableCell whose paragraph contains the label
  // text (optionally bold). emptyCell builds a tableCell containing
  // one empty paragraph — the minimum prosemirror needs for a cell
  // the user can click into and type in.
  //
  // `colwidthValue` is the array assigned to the cell's colwidth
  // attribute. Non-null only on the first row; null on subsequent
  // rows (those values are ignored anyway once row 0 has set the
  // column geometry).
  const labelCell = (
    label: string,
    bold: boolean,
    colwidthValue: number[] | null,
  ): ProseMirrorNode => {
    const marks = bold ? [boldMark.create()] : [];
    const text = schema.text(label, marks);
    const para = schema.nodes.paragraph.createChecked(null, text);
    return schema.nodes.tableCell.createChecked({ colwidth: colwidthValue }, para);
  };

  const emptyCell = (colwidthValue: number[] | null = null): ProseMirrorNode => {
    const para = schema.nodes.paragraph.createChecked(null);
    return schema.nodes.tableCell.createChecked({ colwidth: colwidthValue }, para);
  };

  // First row sets column widths for the whole table:
  // labels = 180px, values = 540px, total = 720px.
  const firstRow = schema.nodes.tableRow.createChecked(null, [
    labelCell('Project :', true, [180]),
    emptyCell([540]),
  ]);

  const otherRow = (label: string): ProseMirrorNode =>
    schema.nodes.tableRow.createChecked(null, [
      labelCell(label, false, null),
      emptyCell(null),
    ]);

  // --- Table (6 rows × 2 cols) ---------------------------------------
  const table = schema.nodes.table.createChecked(null, [
    firstRow,
    otherRow('Kontakt person :'),
    otherRow('Hardware :'),
    otherRow('Software :'),
    otherRow('Remote ID / Password :'),
    otherRow('Problem beskrivelse :'),
  ]);

  // --- Callout --------------------------------------------------------
  const calloutPara = schema.nodes.paragraph.createChecked(
    null,
    schema.text('Kunde', [boldMark.create()]),
  );
  const callout = schema.nodes.callout.createChecked({ variant: 'info' }, calloutPara);

  // --- Trailing paragraph --------------------------------------------
  const trailing = schema.nodes.paragraph.createChecked(null);

  return { callout, table, trailing };
}

/**
 * After the user picks a slash-menu item we want them to land on
 * a fresh empty paragraph BELOW the just-inserted block, ready to
 * keep typing. Without this the cursor sits at the end of the
 * inserted node — fine for inline things like "Heading 1" (you
 * can still type the heading text), but awkward for blocks like
 * code, quote, or divider where the natural next step is to keep
 * writing prose.
 *
 * Strategy: after the item's command finishes, find the position
 * AFTER the node currently containing the selection, insert an
 * empty paragraph there if one isn't already, and place the
 * cursor inside it.
 */
function insertTrailingParagraph(editor: Editor): void {
  const { state, view } = editor;
  const { $to } = state.selection;

  // Walk up to the nearest top-level (depth 1) node containing the
  // selection. For a heading we want the paragraph AFTER the
  // heading — not after the whole document.
  let depth = $to.depth;
  while (depth > 1) depth--;
  const containerEnd = $to.end(depth);
  const after = containerEnd + 1;
  const docSize = state.doc.content.size;

  if (after > docSize) {
    // Already at the very end of the doc. Append a paragraph and
    // move the cursor into it.
    const tr = state.tr.insert(
      docSize,
      state.schema.nodes.paragraph.create(),
    );
    tr.setSelection(Selection.near(tr.doc.resolve(docSize + 1)));
    view.dispatch(tr.scrollIntoView());
    return;
  }

  // If the next node is already an empty paragraph, just move the
  // cursor into it instead of inserting another one.
  const $next = state.doc.resolve(after);
  const nextNode = $next.nodeAfter;
  if (
    nextNode &&
    nextNode.type.name === 'paragraph' &&
    nextNode.content.size === 0
  ) {
    const tr = state.tr.setSelection(Selection.near($next));
    view.dispatch(tr.scrollIntoView());
    return;
  }

  const tr = state.tr.insert(after, state.schema.nodes.paragraph.create());
  tr.setSelection(Selection.near(tr.doc.resolve(after + 1)));
  view.dispatch(tr.scrollIntoView());
}

/**
 * Build the full item list. Curried with the context so each item's
 * command can capture vaultId / current note path without us having
 * to thread state through the suggestion plugin's filter calls.
 */
export function buildSlashMenuItems(ctx: SlashMenuContext): SlashMenuItem[] {
  // --- Image item (conditional) -----------------------------------
  // Built as a const so we can splice it into the items array at
  // the correct position via a conditional spread rather than
  // pushing it on at the end. Pre-Ship-98 templates set
  // allowImages=false; Ship 98 introduces template asset folders,
  // so the template editor now keeps allowImages=true and sets
  // ctx.templateName — the command branches based on that to hit
  // either the note-asset endpoint or the template-asset endpoint.
  const imageItem: SlashMenuItem = {
    title: 'Image',
    subtitle: 'Pick a file to upload and insert',
    icon: '🖼',
    keywords: ['image', 'picture', 'photo', 'upload', 'img'],
    command: async ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      document.body.appendChild(input);

      const cleanup = () => {
        if (input.parentNode) input.parentNode.removeChild(input);
      };

      input.addEventListener('change', async () => {
        try {
          const file = input.files?.[0];
          if (!file) return;

          // Branch based on context: template-mode (Ship 98) goes
          // through templatesApi.uploadAsset; note-mode keeps the
          // existing assetsApi.upload path. We don't fall back —
          // an editor with allowImages=true must have either a
          // notePath or a templateName, and it's a real bug if
          // neither is set.
          let res;
          if (ctx.templateName) {
            res = await templatesApi.uploadAsset(
              ctx.vaultId,
              ctx.templateName,
              file,
              file.name,
            );
          } else {
            const notePath = ctx.getNotePath();
            if (!notePath) return;
            res = await assetsApi.upload(ctx.vaultId, notePath, file, file.name);
          }

          editor
            .chain()
            .focus()
            .setImage({
              src: res.relativeMarkdownPath,
              alt: res.originalFileName,
              title: res.originalFileName,
            })
            .run();
          insertTrailingParagraph(editor);
        } finally {
          cleanup();
        }
      });

      const onFocusBack = () => {
        window.removeEventListener('focus', onFocusBack);
        setTimeout(() => {
          if (!input.files || input.files.length === 0) {
            cleanup();
          }
        }, 300);
      };
      window.addEventListener('focus', onFocusBack);

      input.click();
    },
  };

  // --- Slash menu ordering ----------------------------------------
  // Items shown in the slash menu, in display order. Templates (if
  // the cache is non-empty) is unshifted onto the front later in
  // this function, so the first entry here is what appears at
  // index 1 when templates exist.
  //
  // Order rationale (ship): the high-value insertable assets sit
  // at the top so they're one tap away — Image, Code block,
  // PLCOpen import — followed by the colour-coded callouts. The
  // structural / formatting blocks (headings, lists, quote,
  // divider, table) sit at the bottom: they're still easy to
  // filter to by typing (`/h1`, `/table`), but visually they
  // shouldn't dominate the menu since the user already has
  // markdown shortcuts (`#`, `-`, `1.`) for most of them.
  //
  // Image is conditional (allowImages gate) and goes in via
  // conditional spread. Templates stays a post-build unshift so
  // its dynamic submenu and cache lookup live in one place at the
  // end of this function.
  const items: SlashMenuItem[] = [
    // --- SupportCall -------------------------------------------------
    // Inserts a customer-support intake skeleton: an Info callout
    // titled "Kunde" followed by a 2-column / 6-row label table
    // (Project, Kontakt person, Hardware, Software, Remote ID /
    // Password, Problem beskrivelse).
    //
    // Sits at the front of the base array so — after the post-build
    // Templates unshift — it lands at position 1 in the menu (just
    // below Templates). When no templates exist for the vault, it
    // falls through to position 0, which is fine.
    //
    // No allow-flag gate: works in both note and template editors.
    // (Authoring a "SupportCall.md" template by inserting the
    // skeleton and saving is a perfectly reasonable workflow.)
    //
    // Cursor placement: after insertion the cursor lands at the
    // natural insertContent end-position (just after the trailing
    // paragraph below the table). The user clicks into the
    // "Project :" value cell to start filling fields. Trying to
    // auto-land the cursor inside the first table cell would
    // require computing a position offset that depends on the
    // exact prosemirror serialisation of the inserted structure —
    // fragile if the skeleton shape ever changes. One extra click
    // is the safer trade.
    {
      title: 'SupportCall',
      subtitle: 'Kunde intake skeleton (callout + labelled table)',
      icon: '☎',
      keywords: ['support', 'call', 'kunde', 'customer', 'ticket', 'intake'],
      command: ({ editor, range }) => {
        const { callout, table, trailing } = supportCallNodes(editor);
        // Build the three top-level blocks as a single Fragment, then
        // insert it in ONE insertContent call. Two earlier attempts
        // failed:
        //   - Passing them as a JS array tripped Fragment.fromJSON's
        //     array-path validation ("Invalid input for
        //     Fragment.fromJSON" RangeError).
        //   - Chaining .insertContent(callout).insertContent(table)
        //     left the cursor INSIDE the callout after the first
        //     insert (the callout's content rule is `block+`, so it
        //     happily accepted the table as a child) — the table
        //     ended up nested inside the Kunde callout, painted by
        //     the callout's blue background.
        //
        // Fragment.from(Node[]) builds a prosemirror Fragment from
        // real Node instances, sidestepping the JSON round-trip,
        // and a single insertContent call places all three nodes
        // at the same depth as siblings.
        const fragment = Fragment.from([callout, table, trailing]);
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent(fragment)
          .run();
      },
    },

    // --- Asset upload (gated) ---------------------------------------
    ...(ctx.allowImages !== false ? [imageItem] : []),

    // --- Code & PLCOpen ----------------------------------------------
    // Code block: produces the SAME structure the PLCOpen XML import
    // produces, minus the file-picker / XML parsing. That means a
    // bold name paragraph + Declaration code block + Implementation
    // code block, both `language: st`, with the canonical
    // "Declaration" / "Implementation" titles. Because the runtime
    // Run button (CodeBlockNodeView.isRunnableImplementation) keys
    // off exactly that triplet, the inserted skeleton is immediately
    // Runnable once the user fills in some ST.
    //
    // We reuse insertPousAtSelection with a single synthetic POU so
    // the inserted JSON is byte-for-byte identical to what the
    // importer emits — no risk of the two paths drifting. The
    // Declaration block ships with a starter PROGRAM/VAR/END_VAR
    // skeleton (the runtime parser requires PROGRAM at the top of
    // the declaration), and the Implementation block ships empty.
    //
    // Placeholder name "Program1" because the runtime parser is
    // PROGRAM-only in v1; a default name avoids forcing the user
    // to remember to rename two places.
    {
      title: 'Code block',
      subtitle: 'ST runtime-ready: Declaration + Implementation pair',
      icon: '</>',
      keywords: ['code', 'snippet', 'pre', 'st', 'program', 'plc', 'run'],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();
        insertPousAtSelection(editor, [
          {
            name: 'Program1',
            pouType: 'program',
            declaration: 'PROGRAM Program1\nVAR\n\t\nEND_VAR',
            implementation: '',
            // No members and no tree — the Code-block slash item
            // produces a plain POU skeleton, no method/action/
            // property scaffolding. insertPousAtSelection's tree-
            // view step short-circuits on the empty arrays, so the
            // result is byte-for-byte identical to the pre-extended
            // Code-block output: header + Declaration + Implementation
            // + trailing paragraph.
            members: [],
            tree: [],
          },
        ]);
      },
    },
    // PLCOpen XML import: import a PLCOpen XML file (typically a
    // TwinCAT 3 PLCopenXML export of a single POU) and insert each
    // POU as a paragraph header followed by two code blocks —
    // Declaration (the PROGRAM/VAR/END_VAR area) and Implementation
    // (the body).
    //
    // Both blocks use language=st so the existing Structured Text
    // highlighter colours them. Titles "Declaration" and
    // "Implementation" carry through the markdown round-trip
    // because the code block extension serialises non-default
    // titles as raw <pre data-title="..."> HTML.
    //
    // No allow-flag gate — this is not asset-bound, works in both
    // the note editor and the template editor. (Templates can't
    // host live runtime state, but a *static* declaration+body
    // pair is just text — perfectly fine to keep in a template
    // body.)
    {
      title: 'PLCOpen XML',
      subtitle: 'Import a TwinCAT 3 PLCopenXML export as code blocks',
      icon: 'PLC',
      keywords: ['plc', 'plcopen', 'twincat', 'st', 'xml', 'import'],
      command: ({ editor, range }) => {
        // Strip the "/" trigger immediately so the editor isn't left
        // with a stranded slash if the user cancels the file picker.
        editor.chain().focus().deleteRange(range).run();

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.xml,application/xml,text/xml';
        input.style.display = 'none';
        document.body.appendChild(input);

        const cleanup = () => {
          if (input.parentNode) input.parentNode.removeChild(input);
        };

        input.addEventListener('change', async () => {
          try {
            const file = input.files?.[0];
            if (!file) return;

            let text: string;
            try {
              text = await file.text();
            } catch (e) {
              window.alert(
                `Couldn't read the file: ${e instanceof Error ? e.message : String(e)}`,
              );
              return;
            }

            let result;
            try {
              result = parsePlcopenXml(text);
            } catch (e) {
              window.alert(
                `PLCOpen XML import failed.\n\n${e instanceof Error ? e.message : String(e)}`,
              );
              return;
            }

            insertPousAtSelection(editor, result.pous);

            // Surface anything that was skipped — both non-ST POUs
            // (whole POUs dropped because their main body was LD/
            // FBD/SFC) and non-ST members (methods/actions/
            // property accessors of an otherwise-importable POU
            // whose body wasn't ST). The user gets one summary
            // dialog rather than two so dismissal is one keypress.
            // Order: non-ST POUs first (more impactful), then
            // members (a quieter heads-up).
            const skipNotices: string[] = [];
            if (result.skippedNonST.length > 0) {
              skipNotices.push(
                `Skipped ${result.skippedNonST.length} non-ST POU(s) ` +
                  `(LD/FBD/SFC are not supported): ` +
                  result.skippedNonST.join(', '),
              );
            }
            if (result.skippedMembers.length > 0) {
              skipNotices.push(
                `Skipped ${result.skippedMembers.length} non-ST ` +
                  `member(s) (methods / actions / property ` +
                  `accessors with LD/FBD/SFC bodies): ` +
                  result.skippedMembers.join(', '),
              );
            }
            if (skipNotices.length > 0) {
              window.alert(
                `Imported ${result.pous.length} POU(s).\n\n` +
                  skipNotices.join('\n\n'),
              );
            }
          } finally {
            cleanup();
          }
        });

        // Same focus-back cleanup pattern as the Image item: if the
        // user dismisses the picker without selecting anything, the
        // change event never fires, so we tear down the hidden
        // input a moment after the window regains focus.
        const onFocusBack = () => {
          window.removeEventListener('focus', onFocusBack);
          setTimeout(() => {
            if (!input.files || input.files.length === 0) {
              cleanup();
            }
          }, 300);
        };
        window.addEventListener('focus', onFocusBack);

        input.click();
      },
    },
    // TcPOU import from GitHub: fetches a `.TcPOU` file (single
    // POU) or a TcPOU folder (a POU with its method/action/
    // property files as siblings or in a same-named subfolder)
    // straight from a GitHub URL. Re-uses the SAME PlcopenPou
    // shape and the SAME insertPousAtSelection emitter as the
    // PLCOpen XML item, so once parsed the output is identical:
    // header + Structure (ASCII tree) + Declaration + Implementation
    // + per-member sections.
    //
    // Accepted URL shapes (resolved by tcpouImport.resolveGitHubUrl):
    //   - https://github.com/{o}/{r}/blob/{b}/path/Foo.TcPOU
    //   - https://raw.githubusercontent.com/{o}/{r}/{b}/path/Foo.TcPOU
    //   - https://github.com/{o}/{r}/tree/{b}/path/Foo  (folder)
    //
    // Other hosts are rejected with a clear error (CORS would block
    // them anyway from the browser side without a server proxy;
    // a server-proxy ship is a future option if/when needed).
    //
    // No allow-flag gate — works in both note and template editors,
    // same reasoning as PLCOpen XML.
    {
      title: 'TcPOU from GitHub',
      subtitle: 'Fetch a .TcPOU file or POU folder and import',
      icon: 'TC',
      keywords: ['tcpou', 'twincat', 'github', 'fetch', 'import', 'url', 'tcmethod', 'tcaction', 'tcproperty'],
      command: async ({ editor, range }) => {
        // Strip the "/" trigger immediately so a cancelled prompt
        // doesn't leave a stranded slash behind.
        editor.chain().focus().deleteRange(range).run();

        // Plain window.prompt for the URL — consistent with the
        // existing link-prompt pattern documented in notes.md.
        // A proper modal is a future UI polish (queue item).
        const url = window.prompt(
          'GitHub URL of a .TcPOU file or POU folder:\n\n' +
            '• blob URL:  https://github.com/owner/repo/blob/main/path/Foo.TcPOU\n' +
            '• tree URL:  https://github.com/owner/repo/tree/main/path/Foo  (folder)\n' +
            '• raw URL:   https://raw.githubusercontent.com/owner/repo/main/path/Foo.TcPOU',
        );
        if (!url) return;

        let result;
        try {
          result = await importFromGitHubUrl(url);
        } catch (e) {
          window.alert(
            `TcPOU import failed.\n\n${e instanceof Error ? e.message : String(e)}`,
          );
          return;
        }

        insertPousAtSelection(editor, result.pous);

        if (result.skippedMembers.length > 0) {
          // Folder mode can have per-file failures; we surface
          // them as a single summary the same way the PLCOpen
          // XML item handles skipped non-ST members.
          window.alert(
            `Imported ${result.pous.length} POU(s).\n\n` +
              `Skipped ${result.skippedMembers.length} member file(s): ` +
              result.skippedMembers.join(', '),
          );
        }
      },
    },

    // --- Callouts ----------------------------------------------------
    // Each callout variant gets its own slash item so users can type
    // /error, /warning etc. The variant attribute drives the colour.
    {
      title: 'Error callout',
      subtitle: 'Red box for errors / problems',
      icon: '🚨',
      keywords: ['error', 'callout', 'admonition', 'fejl'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertCallout('error')
          .run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Warning callout',
      subtitle: 'Yellow box for warnings / cautions',
      icon: '⚠️',
      keywords: ['warning', 'caution', 'callout', 'admonition'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertCallout('warning')
          .run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Info callout',
      subtitle: 'Blue box for informational content',
      icon: 'ℹ️',
      keywords: ['info', 'information', 'callout', 'admonition'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertCallout('info')
          .run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Tip callout',
      subtitle: 'Green box for tips / solutions',
      icon: '💡',
      keywords: ['tip', 'solution', 'l\u00f8sning', 'callout', 'admonition'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertCallout('tip')
          .run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Note callout',
      subtitle: 'Gray box for general notes',
      icon: '📝',
      keywords: ['note', 'callout', 'admonition'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertCallout('note')
          .run();
        insertTrailingParagraph(editor);
      },
    },

    // --- Headings ----------------------------------------------------
    {
      title: 'Heading 1',
      subtitle: 'Big section title',
      icon: 'H1',
      keywords: ['h1', 'heading', 'title'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode('heading', { level: 1 })
          .run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Heading 2',
      subtitle: 'Section heading',
      icon: 'H2',
      keywords: ['h2', 'heading'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode('heading', { level: 2 })
          .run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Heading 3',
      subtitle: 'Subsection heading',
      icon: 'H3',
      keywords: ['h3', 'heading'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode('heading', { level: 3 })
          .run();
        insertTrailingParagraph(editor);
      },
    },

    // --- Lists -------------------------------------------------------
    {
      title: 'Bullet list',
      subtitle: 'Unordered list',
      icon: '•',
      keywords: ['ul', 'unordered', 'list', 'bullets'],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleBulletList().run();
        // Lists naturally get an empty <li> as their first child;
        // adding a trailing paragraph here would put a blank line
        // between the list and whatever comes next which is what
        // the user expects when they type out of the list. We
        // leave the cursor in the first <li>.
      },
    },
    {
      title: 'Numbered list',
      subtitle: 'Ordered list',
      icon: '1.',
      keywords: ['ol', 'ordered', 'list', 'numbered'],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleOrderedList().run();
      },
    },

    // --- Quote & divider ---------------------------------------------
    {
      title: 'Quote',
      subtitle: 'Blockquote for citing or emphasising',
      icon: '❝',
      keywords: ['quote', 'blockquote', 'cite'],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleBlockquote().run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Divider',
      subtitle: 'Horizontal line separator',
      icon: '—',
      keywords: ['hr', 'horizontal', 'rule', 'separator', 'line'],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setHorizontalRule().run();
        insertTrailingParagraph(editor);
      },
    },

    // --- Math --------------------------------------------------------
    // Two flavours:
    //   - Block math   : centered display-style equation. Fresh insertion
    //                    starts empty; MathNodeView auto-opens the edit
    //                    popover on mount when it sees an empty `latex`.
    //   - Inline math  : an inline atom that sits in a paragraph.
    //
    // Both honour the same Pandoc/Obsidian on-disk syntax ($..$ / $$..$$),
    // and the editor also accepts \(..\) / \[..\] on paste and on load
    // — output is always normalized to dollars on save. See
    // editor/mathParser.ts for the rationale.
    {
      title: 'Math (block)',
      subtitle: 'Display-style LaTeX equation',
      icon: '∑',
      keywords: ['math', 'latex', 'equation', 'formula', 'katex', 'block'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertMathBlock('')
          .run();
        // No insertTrailingParagraph: insertMathBlock already
        // appends a paragraph after the math (see MathExtension).
      },
    },
    {
      title: 'Math (inline)',
      subtitle: 'Inline LaTeX expression',
      icon: '𝑥',
      keywords: ['math', 'latex', 'equation', 'inline', 'katex'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertMathInline('')
          .run();
      },
    },

    // --- Table -------------------------------------------------------
    {
      title: 'Table',
      // The subtitle no longer locks "3×3" because the host can pop a
      // dialog to pick dimensions. Keep it short and accurate either
      // way the host wires this up.
      subtitle: 'Insert a table',
      icon: '⊞',
      keywords: ['table', 'grid', 'rows', 'columns'],
      command: ({ editor, range }) => {
        // Two paths:
        //   - Host wired up onTableInsertRequest → delete the trigger
        //     range first (so the user's typed "/" + filter goes
        //     away), then hand off to the host. The host shows its
        //     TableInsertDialog and runs insertTable when the user
        //     confirms.
        //   - Host did not wire up the callback → fall back to the
        //     legacy immediate insert of a 3×3 with header row.
        //     Keeps headless callers (tests, or future contexts that
        //     don't want a dialog) working unchanged.
        if (ctx.onTableInsertRequest) {
          editor.chain().focus().deleteRange(range).run();
          ctx.onTableInsertRequest();
          return;
        }
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run();
        insertTrailingParagraph(editor);
      },
    },
  ];

  // --- Templates (dynamic submenu) -------------------------------
  //
  // We expose ONE "Templates" item which, when picked, swaps the
  // slash menu's UI into submenu mode showing the available
  // templates. Picking a template from the submenu inserts its
  // body at the original / position.
  //
  // This is added at the END of the items array here, but the
  // caller (buildSlashMenuItemsWithTemplatesFirst below) splices
  // it into position 0 so it sits at the top of the menu.
  //
  // Gated by allowTemplates — the template editor itself doesn't
  // offer this submenu (avoids template-of-template recursion).
  if (ctx.allowTemplates !== false) {
    const templates = getCachedTemplates(ctx.vaultId);
    if (templates.length > 0) {
      const submenuItems: () => SlashMenuItem[] = () => {
        // Build fresh on every open so the cache is current. The
        // back row sits at index 0; templates follow.
        const back: SlashMenuItem = {
          title: '← Back',
          subtitle: 'Return to the main menu',
          icon: '↩',
          keywords: ['back', 'return'],
          isBack: true,
        };
        const list: SlashMenuItem[] = [back];
        for (const tpl of templates) {
          list.push({
            title: tpl.name,
            subtitle: 'Template',
            icon: '📋',
            keywords: [tpl.name.toLowerCase()],
            command: async ({ editor, range }) => {
              // Ship 98c: route inserts through the server-side
              // render endpoint so any images referenced by the
              // template get copied into the target note's asset
              // folder and the markdown is rewritten to point at
              // the new location. This means an inserted template
              // survives the source template being later deleted
              // or renamed.
              //
              // We always go through render — even for text-only
              // templates. The roundtrip cost is negligible and the
              // alternative (branching on "does this template have
              // images") would add cache state we don't need.
              //
              // Asset paths are computed against the TARGET note's
              // location, so the slash-menu context's getNotePath
              // is required. If it returns empty (an editor that
              // somehow doesn't have a note path bound), we fall
              // back to the pre-Ship-98c behaviour: insert the raw
              // body. Any images in it will render broken — same
              // failure mode as before this ship — but at least the
              // user gets the text content.
              const notePath = ctx.getNotePath();
              try {
                let bodyToInsert: string;
                if (notePath) {
                  const rendered = await templatesApi.render(
                    ctx.vaultId,
                    tpl.name,
                    notePath,
                  );
                  bodyToInsert = rendered.body;
                } else {
                  const full = await templatesApi.get(ctx.vaultId, tpl.name);
                  bodyToInsert = full.body;
                }
                editor
                  .chain()
                  .focus()
                  .deleteRange(range)
                  .insertContent(bodyToInsert)
                  .run();
              } catch (e) {
                if (e instanceof ApiError) {
                  // Clean up the slash range so the editor isn't
                  // left with a stranded "/" — the original
                  // pre-Ship-98c behaviour.
                  editor.chain().focus().deleteRange(range).run();
                }
              }
            },
          });
        }
        return list;
      };

      // Stick the Templates entry at the TOP of the menu — it's
      // a frequent action and keeping it visible without
      // scrolling matters.
      items.unshift({
        title: 'Templates',
        subtitle: `${templates.length} available · click for list`,
        icon: '📋',
        keywords: ['template', 'templates'],
        submenuItems,
      });
    }
  }

  return items;
}

/**
 * Filter the items for a given query (the text after "/"). Matches
 * against title and keywords, case-insensitively. An empty query
 * returns the full list in original order.
 *
 * Scoring is simple: prefix match on title beats infix match beats
 * keyword match. Exact prefix is the strongest signal.
 */
export function filterSlashItems(
  items: SlashMenuItem[],
  query: string,
): SlashMenuItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;

  type Scored = { item: SlashMenuItem; score: number };
  const scored: Scored[] = [];

  for (const item of items) {
    const title = item.title.toLowerCase();
    let score = 0;
    if (title === q) score = 1000;
    else if (title.startsWith(q)) score = 500;
    else if (title.includes(q)) score = 200;
    else if (item.keywords?.some((k) => k.toLowerCase().startsWith(q))) score = 150;
    else if (item.keywords?.some((k) => k.toLowerCase().includes(q))) score = 100;

    if (score > 0) {
      scored.push({ item, score });
    }
  }

  // Stable sort by score descending. items.indexOf preserves
  // original order within a score band.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return items.indexOf(a.item) - items.indexOf(b.item);
  });

  return scored.map((s) => s.item);
}
