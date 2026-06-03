import Table from '@tiptap/extension-table';

/**
 * Extends the upstream @tiptap/extension-table with two things:
 *
 *   1. A `rowHeight` node attribute (number, in pixels). Drives a
 *      `--nc-table-row-h` CSS variable on the rendered <table>; the
 *      stylesheet uses that var to set min-height on every cell so
 *      every row in the table snaps to the same height.
 *
 *   2. A custom markdown serializer that emits raw HTML when any
 *      of the following are true, and clean GFM pipe syntax
 *      otherwise:
 *
 *        - `rowHeight` is set on the table
 *        - any cell has a non-default `align` attribute
 *        - any cell has colspan/rowspan > 1 (merged cells)
 *        - any cell has user-set column widths (colwidth array,
 *          set by dragging the column resize handle)
 *        - any cell holds multi-block content (e.g. a list inside)
 *        - the table has a header column (header cells outside row 0)
 *
 *      The first three are NoteControl-specific. The last three match
 *      what the upstream tiptap-markdown serializer also falls back
 *      to HTML for — we re-implement the pipe path here so we have
 *      one place that decides which form to emit.
 *
 * Why the rowHeight attribute lives on the TABLE node (not the row
 * or cell): the user wants ONE knob per table — "the global cell
 * height for this table". Putting it on the table node makes that
 * exactly representable. Per-row heights would be a different,
 * heavier feature.
 *
 * Markdown round-trip note: tables with custom attributes get saved
 * as raw HTML inside the .md file, the same way callouts do. The
 * data-* attributes on the <table>/<td> elements are read back via
 * parseHTML on load. Plain tables stay as clean pipe syntax.
 *
 * The pipe serializer here is intentionally a faithful re-write of
 * tiptap-markdown's bundled `nodes/table.js`, just rebuilt in our
 * own code so we own the dispatch (pipe-vs-HTML) logic without
 * reaching into tiptap-markdown's package internals.
 */
export const TableWithOptions = Table.extend({
  addAttributes() {
    // Spread the parent's attributes so any future upstream attrs
    // come along automatically. Then add our own.
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      rowHeight: {
        default: null as number | null,
        // Read the attribute back from the DOM on load. We accept
        // `data-row-height` (our own emission) and gracefully ignore
        // anything else. Returning `null` for missing/invalid values
        // keeps "no custom height" the default state.
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute('data-row-height');
          if (!raw) return null;
          const n = parseInt(raw, 10);
          if (Number.isNaN(n) || n <= 0) return null;
          // Guard against silly values that would break layout. The
          // toolbar input clamps too, but a hand-edited markdown
          // file could carry anything.
          return Math.min(Math.max(n, 16), 400);
        },
        // Render onto the DOM <table>. We emit BOTH:
        //   - `data-row-height`  : machine-readable, what we parse
        //                          back from disk on load
        //   - `style`            : the CSS custom property used by
        //                          the stylesheet to size cells
        // Returning {} for null leaves both off entirely.
        renderHTML: (attributes: { rowHeight?: number | null }) => {
          const h = attributes.rowHeight;
          if (h == null) return {};
          return {
            'data-row-height': String(h),
            style: `--nc-table-row-h: ${h}px`,
          };
        },
      },
    };
  },

  /**
   * Markdown storage — see top-of-file comment for the dispatch
   * logic. tiptap-markdown's MarkdownSerializer reads serializers
   * via `getMarkdownSpec(extension)` which spreads the bundled
   * default UNDER our markdownSpec, so we deliberately DO NOT
   * include `parse` here (that would clobber the bundled parse
   * via JS spread; bundled `parse` is what lets markdown-it pick
   * up `<table>` blocks during load).
   */
  addStorage() {
    const parentStorage = (this.parent?.() ?? {}) as Record<string, unknown>;

    return {
      ...parentStorage,
      markdown: {
        // Decide pipe-vs-HTML and emit. Types are `unknown` because
        // prosemirror-markdown's MarkdownSerializerState isn't
        // re-exported with usable types from tiptap-markdown.
        serialize(state: unknown, node: unknown, _parent: unknown) {
          if (needsHtmlSerialization(node)) {
            serializeTableAsHtml(state, node);
          } else {
            serializeTableAsPipe(state, node);
          }
        },
      },
    };
  },
});

// ---- Decision -------------------------------------------------------

/**
 * Should this table be emitted as raw HTML rather than pipe syntax?
 * Returns true when the table carries information that pipe syntax
 * cannot represent.
 */
function needsHtmlSerialization(node: unknown): boolean {
  const tableNode = node as {
    attrs?: { rowHeight?: number | null };
    childCount: number;
    child: (i: number) => {
      childCount: number;
      child: (j: number) => {
        type: { name: string };
        attrs?: {
          align?: string | null;
          colspan?: number;
          rowspan?: number;
          colwidth?: number[] | null;
        };
        childCount: number;
      };
    };
  };

  // 1. Custom row height? → HTML (the whole reason this extension exists)
  if (tableNode.attrs?.rowHeight != null) return true;

  const rows = tableNode.childCount;
  if (rows === 0) return false;

  for (let r = 0; r < rows; r++) {
    const row = tableNode.child(r);
    for (let c = 0; c < row.childCount; c++) {
      const cell = row.child(c);

      // 2. Cell alignment set? → HTML
      if (cell.attrs?.align) return true;

      // 3. Merged cells? → HTML (pipe syntax has no colspan/rowspan)
      if ((cell.attrs?.colspan ?? 1) > 1) return true;
      if ((cell.attrs?.rowspan ?? 1) > 1) return true;

      // 4. Multi-block cell content (e.g. a list inside a cell)? → HTML
      if (cell.childCount > 1) return true;

      // 5. Header column (header cell outside row 0)? → HTML
      //    Header cells in row 0 are normal "header row" tables and
      //    fit pipe syntax fine. Header cells anywhere else mean a
      //    header column, which pipe syntax can't express.
      if (r > 0 && cell.type.name === 'tableHeader') return true;

      // 6. Body-row containing a header cell mixed with body cells:
      //    the rule above already catches this case (any tableHeader
      //    in r > 0 forces HTML).

      // 7. Custom column widths? → HTML.
      //    The user resized columns via the resize handle. Upstream
      //    @tiptap/extension-table-cell stores the widths as a number
      //    array on the cell's `colwidth` attribute (one number per
      //    column the cell spans). Pipe syntax can't represent this;
      //    HTML can via `colwidth="120,80"`. We treat any non-null,
      //    non-empty colwidth array as "user has set widths". A cell
      //    with all-zero widths shouldn't happen but is treated as
      //    "no widths" defensively.
      const cw = cell.attrs?.colwidth;
      if (cw && cw.length > 0 && cw.some((w) => typeof w === 'number' && w > 0)) {
        return true;
      }
    }

    // 8. Row 0 must be all-header for pipe syntax. If row 0 has any
    //    body cells (rare but possible), force HTML.
    if (r === 0) {
      for (let c = 0; c < row.childCount; c++) {
        if (row.child(c).type.name !== 'tableHeader') return true;
      }
    }
  }

  return false;
}

// ---- Pipe serialization (clean GFM) --------------------------------

/**
 * Faithful re-implementation of tiptap-markdown's pipe-syntax table
 * serializer. We re-implement rather than delegate because:
 *
 *   - tiptap-markdown's serializer lives at a non-exported package
 *     path (`tiptap-markdown/src/extensions/nodes/table`) and Vite
 *     refuses to import paths outside the package's exports map.
 *   - The dispatch (when to use pipe vs HTML) is now ours to make,
 *     and it's clearer if the pipe path lives next to the HTML path.
 *
 * Output shape:
 *
 *   | header1 | header2 |
 *   | --- | --- |
 *   | cell1   | cell2   |
 *
 * Cells are rendered with `state.renderInline(cellContent)` so any
 * inline marks (bold, italic, links, code) round-trip naturally.
 * Cell-internal block markup is NOT supported in pipe syntax — but
 * we only reach this path when `needsHtmlSerialization` confirmed
 * the table is plain enough.
 */
function serializeTableAsPipe(state: unknown, node: unknown): void {
  const s = state as {
    write: (text: string) => void;
    closeBlock: (node: unknown) => void;
    ensureNewLine: () => void;
    renderInline: (node: unknown) => void;
    inTable?: boolean;
  };
  const tableNode = node as {
    forEach: (fn: (row: unknown, p: number, i: number) => void) => void;
  };

  s.inTable = true;
  tableNode.forEach((row, _p, i) => {
    const rowNode = row as {
      childCount: number;
      forEach: (fn: (cell: unknown, p: number, j: number) => void) => void;
    };

    s.write('| ');
    rowNode.forEach((col, _q, j) => {
      if (j) s.write(' | ');
      const cellContent = (col as { firstChild: { textContent: string } }).firstChild;
      // Empty cells: skip the renderInline call so we don't emit
      // a stray space/marker. Matches upstream behaviour.
      if (cellContent && cellContent.textContent.trim()) {
        s.renderInline(cellContent);
      }
    });
    s.write(' |');
    s.ensureNewLine();

    // After row 0, write the GFM delimiter row. (`---` per column.)
    if (!i) {
      const delimiterRow = Array.from({ length: rowNode.childCount })
        .map(() => '---')
        .join(' | ');
      s.write(`| ${delimiterRow} |`);
      s.ensureNewLine();
    }
  });
  s.closeBlock(node);
  s.inTable = false;
}

// ---- HTML serialization (round-trips custom attrs) ------------------

/**
 * Serialize a prosemirror table node as a raw HTML <table> block.
 * Used when the table has attributes that pipe syntax cannot express
 * (custom rowHeight, cell alignment, merged cells, header column,
 * column widths, multi-block cell content).
 *
 * Cell content is rendered by `renderCellContents` (see below): the
 * supported block nodes (paragraph, heading, bulletList, orderedList,
 * listItem, hardBreak) emit their proper HTML tags, and inline marks
 * (bold, italic, strike, code, underline, link, color, font-family,
 * font-size) wrap their text in the corresponding open/close tags.
 * Unknown block nodes fall through to escaped textContent — code
 * blocks, callouts, images etc. inside a cell are exotic enough that
 * we don't try to round-trip their full structure (they'll come back
 * as plain text on next load).
 *
 * The shape we emit:
 *
 *   <table data-row-height="32" style="...">
 *   <tbody>
 *   <tr><th data-align="center">…</th><td>…</td></tr>
 *   ...
 *   </tbody>
 *   </table>
 *
 * Why no `<thead>`/`<tbody>` split: GFM viewers and re-parsers
 * (markdown-it, GitHub) handle a flat <tbody>-only table just fine,
 * including treating row 0 with <th> as a header. Adding <thead>
 * would require us to figure out where the header row ends, and the
 * pipe-syntax serializer doesn't bother with it either.
 */
function serializeTableAsHtml(state: unknown, node: unknown): void {
  const s = state as {
    write: (text: string) => void;
    closeBlock: (node: unknown) => void;
    ensureNewLine: () => void;
  };
  const tableNode = node as {
    attrs?: { rowHeight?: number | null };
    forEach: (fn: (row: unknown, p: number, i: number) => void) => void;
  };

  // Build the <table> opening tag with our custom attrs inline.
  const rowHeight = tableNode.attrs?.rowHeight;
  let tableAttrs = '';
  if (rowHeight != null) {
    // Style is duplicated as a CSS custom property so renderers that
    // read style attributes (browsers, GitHub) get the visible
    // height; data-* is what our own parseHTML reads back on load.
    tableAttrs = ` data-row-height="${rowHeight}" style="--nc-table-row-h: ${rowHeight}px"`;
  }

  s.write(`<table${tableAttrs}>`);
  s.ensureNewLine();
  s.write('<tbody>');
  s.ensureNewLine();

  tableNode.forEach((row) => {
    const rowNode = row as {
      forEach: (fn: (cell: unknown) => void) => void;
    };
    s.write('<tr>');
    rowNode.forEach((cell) => {
      const cellNode = cell as {
        type: { name: string };
        attrs?: {
          align?: string | null;
          colspan?: number;
          rowspan?: number;
          colwidth?: number[] | null;
        };
        // Also has childCount/child(i)/textContent at runtime — see
        // the narrower CellChildNode interface used by the helpers
        // below. We assert into it when passing to renderCellContents.
      };
      const tag = cellNode.type.name === 'tableHeader' ? 'th' : 'td';
      const attrs: string[] = [];
      if (cellNode.attrs?.align) attrs.push(`data-align="${cellNode.attrs.align}"`);
      if (cellNode.attrs?.colspan && cellNode.attrs.colspan > 1) {
        attrs.push(`colspan="${cellNode.attrs.colspan}"`);
      }
      if (cellNode.attrs?.rowspan && cellNode.attrs.rowspan > 1) {
        attrs.push(`rowspan="${cellNode.attrs.rowspan}"`);
      }
      // Column widths set by the user dragging the column resize
      // handle. Upstream @tiptap/extension-table-cell stores them
      // as a number-array on the cell, one number per column the
      // cell spans. Its parseHTML reads them back from a literal
      // `colwidth="120,80"` attribute (CSV of integers). We round
      // each value to an integer (the resize plugin sometimes
      // writes fractional pixels) and skip the attribute entirely
      // if the array is null / empty / all-zero, so a fresh table
      // without any user-driven resize doesn't accumulate a no-op
      // attribute.
      const cw = cellNode.attrs?.colwidth;
      if (cw && cw.length > 0 && cw.some((w) => typeof w === 'number' && w > 0)) {
        const rounded = cw.map((w) => Math.max(0, Math.round(w))).join(',');
        attrs.push(`colwidth="${rounded}"`);
      }
      const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';

      // Cell content. We render supported block nodes (paragraphs,
      // headings, bullet/ordered lists, list items, hard breaks) with
      // their proper HTML tags, and supported inline marks (bold,
      // italic, strike, code, underline, link, color, font-family,
      // font-size) with their wrapping tags. See `renderCellContents`
      // below.
      //
      // Why not just `state.renderInline` like the pipe path does?
      // renderInline only handles inline content (text + marks); it
      // doesn't know what to do with multi-block cell content like
      // a paragraph followed by a bullet list. Hand-rolling the cell
      // emitter lets us own exactly what shows up inside <td> on
      // disk, and matches what TipTap's own parseHTML rules expect
      // on the way back in.
      //
      // Limitation (documented honestly): nodes outside the supported
      // set — code blocks, callouts, images, math, embedded videos —
      // fall back to escaped textContent inside cells. They're rare
      // enough inside tables that fixing them isn't worth carrying
      // a per-mark/per-node case for each one; the user would notice
      // if they tried, at which point we'd extend the emitter.
      const inner = renderCellContents(cellNode as unknown as CellChildNode);
      s.write(`<${tag}${attrStr}>${inner}</${tag}>`);
    });
    s.write('</tr>');
    s.ensureNewLine();
  });

  s.write('</tbody>');
  s.ensureNewLine();
  s.write('</table>');
  s.closeBlock(node);
}
// ---- Cell HTML content emitter -------------------------------------

/**
 * Build the inner HTML of a single <td> / <th> in the HTML fallback
 * path. Walks the cell's block children and the inline content of
 * each, emitting tags for the supported set of block nodes and
 * inline marks. Unknown nodes fall through to escaped textContent
 * (the previous file-wide behaviour, now localised to one block).
 *
 * Supported blocks: paragraph, heading, bulletList, orderedList,
 *                   listItem, hardBreak.
 * Supported marks:  bold, italic, strike, code, underline, link,
 *                   nccolor, ncfont, ncsize.
 *
 * Round-trip: TipTap's standard parseHTML for each node/mark reads
 * exactly what we emit, so reload reconstructs the same prosemirror
 * tree. tiptap-markdown is configured with `html: true`, so the raw
 * HTML inside the <table> block is preserved verbatim through the
 * markdown layer in both directions.
 *
 * Why these as the supported set and not more: every block/mark
 * that ships on the NoteEditor today is covered EXCEPT exotic
 * block kinds (callout, code block, image, math, video) which
 * almost nobody puts inside a table cell. If someone does, the
 * fallback emits the textContent and we'd extend the emitter on
 * demand. Keeping the set small keeps the diff small and the
 * round-trip predictable.
 */

// Inline marks rendered in a deterministic outer→inner nesting so
// that two saves of the same content produce byte-identical output.
// The order itself doesn't affect rendering — HTML mark nesting is
// commutative in the browser — it just stabilises the .md on disk.
const MARK_ORDER: readonly string[] = [
  'link',
  'nccolor',
  'ncfont',
  'ncsize',
  'underline',
  'bold',
  'italic',
  'strike',
  'code',
];

// Escape only `<` in inline text. We deliberately don't escape `&`,
// matching the file's existing convention for HTML-fallback cells
// (see serializeTableAsHtml's docblock and the old textContent path
// it replaces): inconsistent `&` ↔ `&amp;` round-tripping through
// markdown-it is worse than leaving `&` alone.
function escapeHtmlText(s: string): string {
  return s.replace(/</g, '&lt;');
}

// Attribute values DO get full escaping. Unlike inline text these go
// inside `"..."`, so `"` and `&` must be entity-encoded; without that
// a stray `&` in a URL would silently start a (probably-invalid)
// entity reference on parse-back.
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

interface MarkLike {
  type: { name: string };
  attrs?: Record<string, unknown>;
}

interface InlineChild {
  isText?: boolean;
  text?: string;
  type: { name: string };
  marks?: MarkLike[];
  textContent?: string;
}

interface CellChildNode {
  type: { name: string };
  attrs?: Record<string, unknown>;
  childCount: number;
  child: (i: number) => CellChildNode & InlineChild;
  textContent: string;
}

// Return the open/close tag pair for a mark, or null if the mark
// is unknown or its required attribute is missing (in which case the
// caller silently skips the mark and emits the bare text).
function markTags(mark: MarkLike): { open: string; close: string } | null {
  const name = mark.type.name;
  const attrs = mark.attrs ?? {};
  switch (name) {
    case 'bold':
      return { open: '<strong>', close: '</strong>' };
    case 'italic':
      return { open: '<em>', close: '</em>' };
    case 'strike':
      return { open: '<s>', close: '</s>' };
    case 'code':
      return { open: '<code>', close: '</code>' };
    case 'underline':
      return { open: '<u>', close: '</u>' };
    case 'link': {
      const href = attrs.href;
      if (typeof href !== 'string' || !href) return null;
      const target = attrs.target;
      const rel = attrs.rel;
      const t =
        typeof target === 'string' && target
          ? ` target="${escapeAttr(target)}"`
          : '';
      const r =
        typeof rel === 'string' && rel ? ` rel="${escapeAttr(rel)}"` : '';
      return {
        open: `<a href="${escapeAttr(href)}"${t}${r}>`,
        close: '</a>',
      };
    }
    case 'nccolor': {
      const color = attrs.color;
      if (typeof color !== 'string' || !color) return null;
      return {
        open: `<span style="color: ${escapeAttr(color)}">`,
        close: '</span>',
      };
    }
    case 'ncfont': {
      const font = attrs.font;
      if (typeof font !== 'string' || !font) return null;
      return {
        open: `<span style="font-family: ${escapeAttr(font)}">`,
        close: '</span>',
      };
    }
    case 'ncsize': {
      const size = attrs.size;
      if (typeof size !== 'number' || !Number.isFinite(size)) return null;
      return {
        open: `<span style="font-size: ${Math.round(size)}px">`,
        close: '</span>',
      };
    }
    default:
      return null;
  }
}

// Render the inline content of a block (paragraph, heading, etc).
// For each text child, sort its marks by MARK_ORDER and wrap. For
// hard-break children, emit `<br>`. For any other inline node type
// (unexpected in practice), fall back to its escaped textContent.
function renderInlineHtml(block: CellChildNode): string {
  let out = '';
  for (let i = 0; i < block.childCount; i++) {
    const child = block.child(i);
    if (child.type.name === 'hardBreak') {
      out += '<br>';
      continue;
    }
    if (!child.isText || typeof child.text !== 'string') {
      out += escapeHtmlText(child.textContent ?? '');
      continue;
    }
    const text = escapeHtmlText(child.text);
    const marks = (child.marks ?? []).slice().sort((a, b) => {
      const ai = MARK_ORDER.indexOf(a.type.name);
      const bi = MARK_ORDER.indexOf(b.type.name);
      // Unknown marks sort to the end. They render to no tags
      // anyway (markTags returns null), so their relative order
      // doesn't matter — keeping the sort stable is what counts.
      const aRank = ai === -1 ? MARK_ORDER.length : ai;
      const bRank = bi === -1 ? MARK_ORDER.length : bi;
      return aRank - bRank;
    });
    let opens = '';
    let closes = '';
    for (const m of marks) {
      const tags = markTags(m);
      if (!tags) continue;
      opens += tags.open;
      closes = tags.close + closes;
    }
    out += opens + text + closes;
  }
  return out;
}

// Render a single block node found inside a cell or a list item.
// Returns the full HTML string for the node, opening and closing
// tags included. Unsupported block types fall back to their
// escaped textContent (no surrounding tags), the same degraded
// behaviour the file used file-wide before this ship.
function renderBlockHtml(block: CellChildNode): string {
  const name = block.type.name;
  switch (name) {
    case 'paragraph':
      return `<p>${renderInlineHtml(block)}</p>`;
    case 'heading': {
      // Heading level lives on the node attrs. Default to 1 if it's
      // missing or out of bounds — defensive only; the schema won't
      // produce that, but a hand-edited .md file might.
      const raw = (block.attrs ?? {}).level;
      const level =
        typeof raw === 'number' && raw >= 1 && raw <= 6 ? Math.floor(raw) : 1;
      return `<h${level}>${renderInlineHtml(block)}</h${level}>`;
    }
    case 'bulletList':
      return `<ul>${renderListItemsHtml(block)}</ul>`;
    case 'orderedList': {
      // Ordered lists may carry a `start` attribute (the first
      // item's index). Only emit the attribute when it's not the
      // default 1, to keep the .md tidy.
      const raw = (block.attrs ?? {}).start;
      const start =
        typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 1;
      const startAttr = start === 1 ? '' : ` start="${start}"`;
      return `<ol${startAttr}>${renderListItemsHtml(block)}</ol>`;
    }
    default:
      // Unknown block — code block, callout, image, math, etc.
      // Fall back to escaped textContent. See the docblock above
      // renderCellContents for the rationale.
      return escapeHtmlText(block.textContent ?? '');
  }
}

// Render the `<li>...</li>` items of a bulletList / orderedList.
// Defensive: if a non-listItem child sneaks in (shouldn't happen
// with the default schema), wrap its textContent in `<li>...</li>`
// rather than emit a bare block — keeps the HTML valid.
function renderListItemsHtml(listNode: CellChildNode): string {
  let out = '';
  for (let i = 0; i < listNode.childCount; i++) {
    const li = listNode.child(i);
    if (li.type.name !== 'listItem') {
      out += `<li>${escapeHtmlText(li.textContent ?? '')}</li>`;
      continue;
    }
    out += `<li>${renderListItemContents(li)}</li>`;
  }
  return out;
}

// Render the contents of a `<li>`. A listItem's schema is
// `paragraph block*`. The common case is exactly one paragraph
// child, which we emit as bare inline content (no `<p>` wrap) for
// the cleaner `<li>text</li>` shape — matches typical hand-written
// HTML lists, and parses back as a listItem-with-one-paragraph
// just the same. With nested lists or multiple paragraphs, each
// child renders with its own tag.
function renderListItemContents(li: CellChildNode): string {
  if (li.childCount === 1) {
    const only = li.child(0);
    if (only.type.name === 'paragraph') {
      return renderInlineHtml(only);
    }
  }
  let out = '';
  for (let i = 0; i < li.childCount; i++) {
    out += renderBlockHtml(li.child(i));
  }
  return out;
}

// Render the contents of a `<td>` / `<th>`. Same shape simplification
// as a listItem: a cell with exactly one paragraph child emits just
// the inline content (no `<p>` wrap), matching the cleaner shape the
// previous textContent path used for simple cells. With any extra
// children (a list, a heading, multiple paragraphs), each child
// renders with its own block tag.
function renderCellContents(cell: CellChildNode): string {
  if (cell.childCount === 1) {
    const only = cell.child(0);
    if (only.type.name === 'paragraph') {
      return renderInlineHtml(only);
    }
  }
  let out = '';
  for (let i = 0; i < cell.childCount; i++) {
    out += renderBlockHtml(cell.child(i));
  }
  return out;
}
