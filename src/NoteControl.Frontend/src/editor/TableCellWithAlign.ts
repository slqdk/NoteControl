import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';

/**
 * TableCell + TableHeader extended with an `align` attribute
 * (left | center | right | null).
 *
 * The attribute is read/written via `data-align` on the rendered
 * <td>/<th>. CSS in styles.css maps it to `text-align`.
 *
 * Markdown round-trip: cells with a non-null `align` push the whole
 * containing table into HTML serialization (see TableWithOptions's
 * `needsHtmlSerialization` decision). The attribute survives via
 * the data-align on the <td>/<th> in the saved .md file.
 *
 * Why not GFM's `:---` / `:---:` / `---:` delimiter syntax? It's a
 * column-level setting (alignment for the whole column, set in the
 * delimiter row), not a per-cell setting. The user asked for cell
 * alignment, which is more flexible — different cells in the same
 * column can have different alignment. HTML supports that; pipe
 * syntax doesn't. Keeping the attribute on the cell preserves the
 * flexibility; the trade-off is that any aligned table becomes HTML
 * on disk (acceptable, matches callouts).
 */

const ALIGN_VALUES = ['left', 'center', 'right'] as const;
type AlignValue = (typeof ALIGN_VALUES)[number];

function parseAlign(element: HTMLElement): AlignValue | null {
  // Prefer data-align (our own emission). Fall back to the legacy
  // HTML `align` attribute and `text-align` style for paste-from-Word
  // and similar inbound HTML — these are mostly relevant for the
  // OfficePaste flow, but keeping the parse generous costs nothing.
  const da = element.getAttribute('data-align');
  if (da && (ALIGN_VALUES as readonly string[]).includes(da)) {
    return da as AlignValue;
  }
  const legacy = element.getAttribute('align');
  if (legacy && (ALIGN_VALUES as readonly string[]).includes(legacy)) {
    return legacy as AlignValue;
  }
  const style = element.style?.textAlign;
  if (style && (ALIGN_VALUES as readonly string[]).includes(style)) {
    return style as AlignValue;
  }
  return null;
}

function renderAlign(attributes: { align?: AlignValue | null }) {
  const a = attributes.align;
  if (!a) return {};
  // We emit BOTH data-align (for our own parseHTML on reload) and
  // a style (so plain HTML viewers / GitHub render the alignment
  // visually without our stylesheet).
  return {
    'data-align': a,
    style: `text-align: ${a}`,
  };
}

/**
 * Extended TableCell. Drop-in replacement for the upstream
 * @tiptap/extension-table-cell. Used in NoteEditor and
 * TemplateEditor in place of the upstream TableCell.
 */
export const TableCellWithAlign = TableCell.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      align: {
        default: null as AlignValue | null,
        parseHTML: parseAlign,
        renderHTML: renderAlign,
      },
    };
  },
});

/**
 * Extended TableHeader. Same align attribute as the body cell so
 * header cells in row 0 can also be aligned (common for "Number"
 * style header columns where the data below is right-aligned).
 */
export const TableHeaderWithAlign = TableHeader.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      align: {
        default: null as AlignValue | null,
        parseHTML: parseAlign,
        renderHTML: renderAlign,
      },
    };
  },
});
