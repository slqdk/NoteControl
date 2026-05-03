import { useEffect, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';

import { CodeBlockWithTitle } from '../editor/CodeBlockWithTitle';
import { CalloutExtension } from '../editor/CalloutExtension';
import { MarkdownExtension } from '../markdown/markdownExtension';
import { SlashMenuExtension } from '../editor/SlashMenuExtension';
import { TableDeleteShortcut } from '../editor/TableDeleteShortcut';
import { TableToolbar } from './TableToolbar';
import { BubbleMenu } from './BubbleMenu';

/**
 * Rich editor surface for editing templates.
 *
 * This is a sibling to NoteEditor — same TipTap extensions for the
 * shared block types (headings, lists, code, callouts, tables) but
 * without the note-specific machinery:
 *
 *   - No autosave / debounce / ETag — parent owns saving via the
 *     onChange callback (called on every keystroke; parent decides
 *     when to commit).
 *   - No AssetPasteExtension or ImageWithControls — templates have
 *     no associated note path to upload assets into. Image paste
 *     is silently dropped (TipTap handles it as a no-op when the
 *     image extension isn't registered).
 *   - No frontmatter / locked state — templates are pure markdown.
 *
 * The slash menu is configured to skip the Image item (no upload
 * destination) and to skip the per-template items (so a template
 * editor doesn't list other templates as insertable — confusing
 * recursion). Tables, callouts, headings, code, lists all work.
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
   * Vault ID is needed by the slash menu's underlying context even
   * though we won't use the asset-upload item. Pass it through.
   */
  vaultId: string;
}

export function TemplateEditor({ initialBody, onChange, vaultId }: TemplateEditorProps) {
  // Hold the latest onChange in a ref so the editor's onUpdate
  // closure doesn't capture a stale callback. (Same pattern as
  // NoteEditor — React functional components recreate the handler
  // on every render, but TipTap's editor instance is set up once.)
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

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
      Placeholder.configure({
        placeholder: "Write the template body. Use '/' for commands.",
      }),
      // Tables — see styles.css for visuals. Tables stay inside
      // templates because there's no asset-path issue with them.
      Table.configure({
        resizable: true,
        handleWidth: 5,
        cellMinWidth: 40,
      }),
      TableRow,
      TableHeader,
      TableCell,
      TableDeleteShortcut,
      // Callouts — same in both note and template editors.
      CalloutExtension,
      // Slash menu, with the gates set for template editing.
      SlashMenuExtension.configure({
        context: {
          vaultId,
          getNotePath: () => '',     // unused when allowImages=false
          allowImages: false,
          allowTemplates: false,
        },
      }),
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

  return (
    <div className="nc-template-editor">
      <EditorContent editor={editor} />
      <TableToolbar editor={editor} />
      <BubbleMenu editor={editor} />
    </div>
  );
}
