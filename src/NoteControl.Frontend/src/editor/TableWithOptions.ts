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
 *        - any cell holds multi-block content (e.g. a list inside)
 *        - the table has a header column (header cells outside row 0)
 *
 *      The first two are NoteControl-specific. The last three match
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
        attrs?: { align?: string | null; colspan?: number; rowspan?: number };
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
    }

    // 7. Row 0 must be all-header for pipe syntax. If row 0 has any
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
 * multi-block cell content).
 *
 * Cell content is serialized as `textContent` plus a manual rebuild
 * for inline marks. Multi-block cell content (paragraphs, lists)
 * gets serialized with `state.render(cell)` to preserve the full
 * markdown of each block — this is what makes a list-inside-a-cell
 * round-trip correctly.
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
        attrs?: { align?: string | null; colspan?: number; rowspan?: number };
        textContent: string;
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
      const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';

      // Cell text — escape `<` so embedded < don't accidentally
      // open new tags. We deliberately don't escape `&` because
      // round-trip parsing through markdown-it handles `&amp;`
      // back to `&` in some cases but not all, and inconsistent
      // round-tripping is worse than leaving `&` alone.
      //
      // Limitation: we render only textContent, dropping inline
      // marks (bold, italic, etc.) inside HTML-fallback cells.
      // The user paid for this trade-off: tables with custom
      // height get HTML-flat content. Future ship could call into
      // a sub-state to render inline marks here. Acceptable for
      // now — most tables that need a custom height are tabular
      // data, not formatted prose.
      const text = cellNode.textContent.replace(/</g, '&lt;');
      s.write(`<${tag}${attrStr}>${text}</${tag}>`);
    });
    s.write('</tr>');
    s.ensureNewLine();
  });

  s.write('</tbody>');
  s.ensureNewLine();
  s.write('</table>');
  s.closeBlock(node);
}
