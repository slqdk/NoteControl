import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
// Table extensions: same extended versions used by NoteEditor — see
// TableWithOptions.ts for the rowHeight attribute and markdown
// round-trip rules (custom attrs → HTML, plain → pipe syntax).
import { TableWithOptions } from '../editor/TableWithOptions';
import TableRow from '@tiptap/extension-table-row';
import { TableCellWithAlign, TableHeaderWithAlign } from '../editor/TableCellWithAlign';

import { CodeBlockWithTitle } from '../editor/CodeBlockWithTitle';
import { CalloutExtension } from '../editor/CalloutExtension';
import { ImageWithControls } from '../editor/ImageWithControls';
import { MarkdownExtension } from '../markdown/markdownExtension';
import { SlashMenuExtension } from '../editor/SlashMenuExtension';
import { StAutocompleteExtension } from '../editor/StAutocompleteExtension';
import { TableDeleteShortcut } from '../editor/TableDeleteShortcut';
import { UnderlineMark } from '../editor/UnderlineMark';
import { ColorMark } from '../editor/ColorMark';
import { FontFamilyMark } from '../editor/FontFamilyMark';
import { FontSizeMark } from '../editor/FontSizeMark';
import { PasteNormalizeExtension } from '../editor/PasteNormalizeExtension';
import { TableToolbar } from './TableToolbar';
import { TableInsertDialog, type TableInsertOpts } from './TableInsertDialog';
import { BubbleMenu } from './BubbleMenu';
import { assetsApi } from '../api/client';

/**
 * Rich editor surface for editing templates.
 *
 * This is a sibling to NoteEditor — same TipTap extensions for the
 * shared block types (headings, lists, code, callouts, tables) but
 * with a stripped-down note-specific machinery:
 *
 *   - No autosave / debounce / ETag — parent owns saving via the
 *     onChange callback (called on every keystroke; parent decides
 *     when to commit).
 *   - No frontmatter / locked state — templates are pure markdown.
 *   - No AssetPasteExtension — paste-image-into-template is not in
 *     scope for Ship 98; the slash-menu Image item is the explicit
 *     upload trigger. Drag-and-drop and clipboard paste are silently
 *     no-ops here. Will likely be added later if the workflow proves
 *     valuable.
 *
 * Ship 98: image SUPPORT is now wired in — ImageWithControls is
 * registered and the slash menu's Image item uploads to the
 * template's own asset folder under
 * `{vault}/.notesapp/templates/<name>.assets/`. The `templateName`
 * prop is required when `enableImages` is true, since the slash-
 * menu command needs to know which template's asset folder to
 * upload into. (For an unsaved-new draft the parent passes
 * `enableImages={false}` until after the first save creates a
 * template name on disk.)
 *
 * The slash menu still skips the per-template items (allowTemplates
 * = false) so a template editor doesn't list other templates as
 * insertable — confusing recursion in the picker.
 */

export interface TemplateEditorProps {
  /** Initial markdown to populate the editor with. */
  initialBody: string;
  /**
   * Called on every change — parent typically debounces or just
   * tracks "dirty" and saves on explicit click. The string is the
   * latest serialised markdown.
   */
  onChange: (markdown: string) => void;
  /**
   * Vault ID is needed by the slash menu's underlying context for
   * image-upload routing.
   */
  vaultId: string;
  /**
   * Ship 98: the template's name on disk (without .md). Required
   * when `enableImages` is true — the slash-menu Image command
   * uploads into `<vault>/.notesapp/templates/<templateName>.assets/`,
   * so it must know which folder to write to.
   *
   * For an unsaved-new draft this is the empty string and the
   * parent passes `enableImages={false}` until after the first save
   * gives the template a name. After save, the parent re-mounts the
   * editor with the new `templateName` and `enableImages={true}`.
   */
  templateName?: string;
  /**
   * Ship 98: gate for image upload via the slash menu. Defaults to
   * false to preserve pre-Ship-98 behaviour for any caller that
   * hasn't been updated. Set to true once the parent has a saved
   * template (i.e. `templateName` is non-empty).
   */
  enableImages?: boolean;
}

export function TemplateEditor({
  initialBody,
  onChange,
  vaultId,
  templateName,
  enableImages,
}: TemplateEditorProps) {
  // Hold the latest onChange in a ref so the editor's onUpdate
  // closure doesn't capture a stale callback. (Same pattern as
  // NoteEditor — React functional components recreate the handler
  // on every render, but TipTap's editor instance is set up once.)
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Table insert dialog state — same pattern as NoteEditor. The
  // slash menu's Table item calls onTableInsertRequest (passed via
  // SlashMenuExtension's context below) which sets this true; the
  // dialog renders below the editor at the shell root. On confirm
  // we run insertTable with the chosen dimensions and (optionally)
  // patch rowHeight onto the freshly inserted table.
  const [tableInsertDialogOpen, setTableInsertDialogOpen] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Disable codeBlock so our CodeBlockWithTitle takes over.
        codeBlock: false,
      }),
      CodeBlockWithTitle,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          rel: 'noopener noreferrer',
          target: '_blank',
        },
      }),
      // Same set of paste-/format-related extensions the NoteEditor
      // registers. Bold / italic / underline / strike / code /
      // link toggles still apply via row 1 of the bubble menu.
      // FontFamilyMark / FontSizeMark / ColorMark are registered
      // so any pasted-from-NoteControl content round-trips
      // correctly, but the bubble menu's row 2 (Font/Size/colour/
      // Defaults) stays hidden in templates because we pass
      // showAppearanceControls={false} below — keeps the
      // template editor's surface unchanged.
      UnderlineMark,
      ColorMark,
      FontFamilyMark,
      FontSizeMark,
      PasteNormalizeExtension,
      Placeholder.configure({
        placeholder: "Write the template body. Use '/' for commands.",
      }),
      // Tables — see styles.css for visuals. Tables stay inside
      // templates because there's no asset-path issue with them.
      // Our extended TableWithOptions adds a per-table rowHeight
      // attribute and a markdown serializer that emits raw HTML
      // when rowHeight or per-cell alignment is set, falling back
      // to clean GFM pipe syntax otherwise.
      TableWithOptions.configure({
        resizable: true,
        handleWidth: 5,
        cellMinWidth: 40,
      }),
      TableRow,
      TableHeaderWithAlign,
      TableCellWithAlign,
      TableDeleteShortcut,
      // Callouts — same in both note and template editors.
      CalloutExtension,
      // Ship 98: Image node, registered for templates as well.
      // ImageWithControls provides resize / border / delete UI and
      // the .setImage() command the slash-menu Image item dispatches.
      // Without this the slash-menu insertion would be a no-op
      // (TipTap silently ignores commands for unregistered nodes).
      ImageWithControls.configure({
        allowBase64: false,
      }),
      // Slash menu, with the gates set for template editing.
      // Ship 98: when `enableImages` is true the Image item is
      // included, and the upload routes via templatesApi (using
      // ctx.templateName) instead of assetsApi.
      //
      // onTableInsertRequest opens our TableInsertDialog so the
      // user can pick dimensions + row height before insertion.
      // setTableInsertDialogOpen has stable identity across renders,
      // so capturing it in useEditor's closure is safe.
      SlashMenuExtension.configure({
        context: {
          vaultId,
          getNotePath: () => '',                  // unused for templates
          allowImages: enableImages === true,
          allowTemplates: false,
          templateName: enableImages === true ? templateName : undefined,
          onTableInsertRequest: () => setTableInsertDialogOpen(true),
        },
      }),
      // F2 autocomplete inside Structured Text code blocks. See
      // StAutocompleteExtension for the mode-resolution rules
      // (Declaration → types/FBs, Implementation → declared vars).
      StAutocompleteExtension,
      MarkdownExtension,
    ],
    content: initialBody,
    // Templates are always editable. There's no locked-mode
    // concept like notes have.
    editable: true,
    onUpdate: ({ editor: ed }) => {
      const md = ed.storage.markdown.getMarkdown();
      onChangeRef.current(md);
    },
  });
  // NOTE: useEditor is intentionally called WITHOUT a dep array.
  //
  // An earlier version passed [initialBody] as deps so the editor
  // would re-mount when switching to a different template — but
  // `initialBody` ALSO changes on every keystroke (parent stores
  // the latest markdown in `draft.body` for save-on-click), which
  // caused TipTap to destroy + recreate the editor instance after
  // each keystroke. Result: focus blinked away and the user had to
  // re-click to keep typing.
  //
  // We rely on the parent passing a stable React `key` to force a
  // full remount when switching to a different template. Within a
  // single template-editing session, the editor is mounted once
  // and lives until the component unmounts.

  /*
   * Ship 98: rewrite relative <img src> values to absolute
   * /api/vaults/{id}/asset?path=... URLs so the browser can
   * actually fetch them. Mirrors the rewriter in NoteEditor —
   * see that file for the full rationale (initial render race,
   * programmatic setImage timing, MutationObserver coverage).
   *
   * The only difference here is the canonical-path prefix: a
   * template body references "<TemplateName>.assets/<file>" and
   * the file lives at ".notesapp/templates/<TemplateName>.assets/<file>"
   * on disk, so the rewriter prepends that prefix before handing
   * to assetsApi.serveUrl.
   *
   * If `templateName` isn't yet set (unsaved-new draft), we don't
   * have an asset folder name to point at — just skip the
   * rewrite. A new draft can't have images anyway since uploads
   * require a saved template name.
   */
  useEffect(() => {
    if (!editor) return;
    if (!templateName) return;
    const dom = editor.view.dom as HTMLElement;

    const assetsParent = `.notesapp/templates`;

    function isAlreadyResolved(src: string): boolean {
      return (
        src.startsWith('http://') ||
        src.startsWith('https://') ||
        src.startsWith('/api/') ||
        src.startsWith('data:') ||
        src.startsWith('blob:')
      );
    }

    function rewrite() {
      const candidates = dom.querySelectorAll('img, video, source');
      candidates.forEach((el) => {
        const src = el.getAttribute('src');
        if (!src || isAlreadyResolved(src)) return;
        const cleaned = src.replace(/^\.\//, '');

        // URL-decode each segment — the markdown emits %20-encoded
        // spaces, but assetsApi.serveUrl re-encodes via
        // encodeURIComponent. Without decoding first we'd
        // double-encode and the GET would 404.
        const decodedRelative = cleaned
          .split('/')
          .map((segment) => {
            try {
              return decodeURIComponent(segment);
            } catch {
              return segment;
            }
          })
          .join('/');

        const canonical = `${assetsParent}/${decodedRelative}`;
        const absoluteUrl = assetsApi.serveUrl(vaultId, canonical);
        el.setAttribute('src', absoluteUrl);
      });
    }

    rewrite();

    const observer = new MutationObserver(() => {
      rewrite();
    });
    observer.observe(dom, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src'],
    });

    return () => {
      observer.disconnect();
    };
  }, [editor, templateName, vaultId]);

  return (
    <div className="nc-template-editor">
      <EditorContent editor={editor} />
      <TableToolbar editor={editor} />
      <BubbleMenu editor={editor} />
      {/*
        Table insert dialog. Same pattern as NoteEditor — the slash
        menu's Table item flips this open after deleting the trigger
        range. On confirm we run insertTable + (optionally) patch
        rowHeight onto the new table. Fully unmounted when closed
        so its internal state resets between invocations.
      */}
      {tableInsertDialogOpen && (
        <TableInsertDialog
          onCancel={() => {
            setTableInsertDialogOpen(false);
            // Re-focus so the user can keep typing immediately.
            editor?.commands.focus();
          }}
          onInsert={(opts: TableInsertOpts) => {
            setTableInsertDialogOpen(false);
            if (!editor) return;
            editor
              .chain()
              .focus()
              .insertTable({
                rows: opts.rows,
                cols: opts.cols,
                withHeaderRow: opts.withHeaderRow,
              })
              .run();
            if (opts.rowHeight != null) {
              editor
                .chain()
                .focus()
                .updateAttributes('table', { rowHeight: opts.rowHeight })
                .run();
            }
          }}
        />
      )}
    </div>
  );
}
