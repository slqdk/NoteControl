import type { Slice, Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * Build a clipboardTextSerializer that produces clean plain text
 * when copying from inside a table cell.
 *
 * Why this exists
 * ---------------
 * Without this, copying text from a SupportCall (or any) table cell
 * and pasting into a plain-text target (Notepad, an email subject
 * line, the browser address bar) lands the cell as literal HTML:
 *
 *   <table>
 *   <tbody>
 *   <tr><td colwidth="540">hello</td></tr>
 *   </tbody>
 *   </table>
 *
 * Two things contribute to that. First, when the user double-clicks
 * a cell or otherwise selects a whole cell node, prosemirror makes
 * a CellSelection (not a normal TextSelection); the resulting Slice
 * spans the cell node, not just its inline content. Second, some
 * paste targets fall back to reading text/html when text/plain is
 * empty or unhelpful — and our table's HTML serializer (see
 * TableWithOptions.ts) emits the wrapping `<table>...<td>...` for
 * even a single-cell slice. Together, plain-text targets end up
 * with the literal HTML string.
 *
 * The fix is to override prosemirror's default text/plain
 * serialization. When the slice contains table cells, we walk it
 * and emit just the cell text, joined by tabs within a row and
 * newlines between rows (the convention every spreadsheet uses —
 * pasting into Excel / Sheets gets the right cells). When the
 * slice contains no cells, we fall through to a generic text walk
 * that mirrors prosemirror's default.
 *
 * Scope
 * -----
 * This affects only the text/plain clipboard channel — text/html
 * (used by other rich-text editors as paste source) still goes
 * through TipTap's normal pipeline. Copy-paste between two notes
 * in NoteControl still preserves the table structure because that
 * path reads text/html.
 *
 * The serializer is shared by NoteEditor and TemplateEditor via
 * editorProps.clipboardTextSerializer.
 */
export function tableAwareClipboardTextSerializer(slice: Slice): string {
  // First pass: does the slice contain any tableCell or tableHeader
  // nodes? If not, fall through to the generic text walk — no need
  // to apply table-specific logic to non-table content.
  let hasCell = false;
  slice.content.descendants((node) => {
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      hasCell = true;
      return false;
    }
    return undefined;
  });

  if (!hasCell) {
    return genericTextWalk(slice);
  }

  // Table-aware walk: find each row (or pseudo-row when only a
  // single cell is selected), collect its cells' text, tab-join
  // within a row, newline-join between rows.
  //
  // Three shapes the slice can take:
  //
  //   1. A CellSelection of one cell  → slice is a single tableCell
  //      with paragraph(s) inside. We treat that as one row with
  //      one cell.
  //
  //   2. A CellSelection spanning multiple cells  → slice is a
  //      table with tableRow children, each containing tableCells.
  //      Standard "spreadsheet-style" walk.
  //
  //   3. Other slices that happen to contain cells (e.g. a whole-
  //      table selection)  → same as (2).
  //
  // We don't need to special-case (1) explicitly — the loop below
  // handles it by treating any top-level cell as its own row.
  const rows: string[] = [];

  slice.content.forEach((node) => {
    collectFromNode(node, rows);
  });

  return rows.join('\n');
}

/**
 * Walk a node looking for rows and cells. Appends one string per
 * row to `rows` (cells tab-separated). Recurses through tables;
 * treats a bare tableCell as a one-cell row.
 */
function collectFromNode(node: ProseMirrorNode, rows: string[]): void {
  const name = node.type.name;

  if (name === 'tableRow') {
    const cells: string[] = [];
    node.forEach((cell) => {
      // textBetween: walks inline content and emits text only —
      // strips marks (bold, italic, etc.) since they have no
      // representation in plain text. Newlines inside multi-block
      // cells (e.g. a Problem beskrivelse with multiple lines)
      // become " " spaces so the cell stays on one line in the
      // tab-separated row. If the user wants newlines preserved,
      // they should copy from inside the cell rather than from a
      // whole-cell selection — partial selections fall through to
      // genericTextWalk above.
      cells.push(cell.textBetween(0, cell.content.size, ' ', ' '));
    });
    rows.push(cells.join('\t'));
    return;
  }

  if (name === 'tableCell' || name === 'tableHeader') {
    // Bare cell at slice top-level: treat as a one-cell row. This
    // is the common single-cell-copy case the original bug
    // reported — pasting "hello" into Notepad now produces just
    // "hello", no wrapper.
    rows.push(node.textBetween(0, node.content.size, ' ', ' '));
    return;
  }

  if (name === 'table') {
    // Recurse into rows.
    node.forEach((child) => collectFromNode(child, rows));
    return;
  }

  // Anything else inside a table slice (paragraphs above / below a
  // selected table, etc.) — append its text as its own line.
  const text = node.textBetween(0, node.content.size, '\n', '\n');
  if (text.length > 0) rows.push(text);
}

/**
 * Default-style text walk for slices with no cells. Mirrors
 * prosemirror's built-in clipboardTextSerializer: walks the slice's
 * inline content emitting text-only, with newlines between blocks.
 */
function genericTextWalk(slice: Slice): string {
  return slice.content.textBetween(0, slice.content.size, '\n', '\n');
}
