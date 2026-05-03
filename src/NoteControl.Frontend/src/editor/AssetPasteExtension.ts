import { Extension, type CommandProps } from '@tiptap/core';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';

import { ApiError, assetsApi } from '../api/client';

/**
 * TipTap extension that intercepts pasted / dropped files and turns
 * them into uploaded assets. The inserted node depends on MIME:
 *
 *   - image/*  → `setImage({ src })` (the Image node renders inline
 *                immediately; on save the Markdown serialiser writes
 *                `![alt](src)`)
 *   - video/*  → markdown text `<video ...>...</video>` (HTML in
 *                markdown round-trips through tiptap-markdown; the
 *                editor will render it after save+reload, and as
 *                plain text in between — acceptable trade-off
 *                without a custom Video node, which is its own
 *                step)
 *   - other    → markdown link, but inserted via the Link mark so
 *                it shows as a clickable link immediately
 *
 * Why this dispatch instead of just inserting markdown text?
 * Because `tiptap-markdown` parses markdown only at document load
 * + save boundaries. Mid-edit `insertText("![](...)") puts those
 * literal characters into the doc — the user sees raw markdown
 * until they reload. Using the proper TipTap commands (setImage,
 * setLink) makes the asset render immediately.
 *
 * Concurrent paste safety: uploads serialise per editor (one at a
 * time). See README.
 */

export interface AssetPasteOptions {
  vaultId: string;
  getNotePath: () => string;
  onUploadStart?: (info: UploadInfo) => void;
  onUploadComplete?: (info: UploadInfo) => void;
  onUploadError?: (info: UploadInfo, error: unknown) => void;
}

export interface UploadInfo {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

const PLUGIN_KEY = new PluginKey('assetPaste');

export const AssetPasteExtension = Extension.create<AssetPasteOptions>({
  name: 'assetPaste',

  addOptions() {
    return {
      vaultId: '',
      getNotePath: () => '',
    } as AssetPasteOptions;
  },

  addProseMirrorPlugins() {
    const opts = this.options;
    const editor = this.editor;

    return [
      new Plugin({
        key: PLUGIN_KEY,
        props: {
          handlePaste: (_view, event) => {
            const files = filesFromClipboard(event);
            if (files.length === 0) {
              return false;
            }
            event.preventDefault();
            void uploadAndInsertMany(editor, files, opts);
            return true;
          },

          handleDrop: (_view, event) => {
            const dt = event.dataTransfer;
            if (!dt || dt.files.length === 0) {
              return false;
            }
            const files = Array.from(dt.files);
            event.preventDefault();
            void uploadAndInsertMany(editor, files, opts);
            return true;
          },
        },
      }),
    ];
  },
});

// ----------------------------------------------------------- helpers

function filesFromClipboard(event: ClipboardEvent): File[] {
  const dt = event.clipboardData;
  if (!dt) return [];
  const out: File[] = [];

  for (const f of Array.from(dt.files)) {
    out.push(f);
  }
  if (out.length === 0) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

async function uploadAndInsertMany(
  editor: { chain: () => any; commands: any } | null, // eslint-disable-line @typescript-eslint/no-explicit-any
  files: File[],
  opts: AssetPasteOptions,
): Promise<void> {
  if (!editor) return;
  for (const file of files) {
    await uploadAndInsertOne(editor, file, opts);
  }
}

async function uploadAndInsertOne(
  editor: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  file: File,
  opts: AssetPasteOptions,
): Promise<void> {
  const notePath = opts.getNotePath();
  if (!notePath) {
    return;
  }

  const fileName = file.name || guessNameForBlob(file);
  const info: UploadInfo = {
    fileName,
    contentType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
  };

  opts.onUploadStart?.(info);

  try {
    const res = await assetsApi.upload(opts.vaultId, notePath, file, fileName);
    insertAssetIntoEditor(editor, res, info);
    opts.onUploadComplete?.(info);
  } catch (e) {
    opts.onUploadError?.(info, e);
    if (e instanceof ApiError) {
      return;
    }
  }
}

function guessNameForBlob(file: File | Blob): string {
  const type = (file as File).type || 'application/octet-stream';
  if (type.startsWith('image/')) {
    const sub = type.slice(6).split(';')[0] || 'png';
    return `paste-${timestamp()}.${sub}`;
  }
  if (type.startsWith('video/')) {
    const sub = type.slice(6).split(';')[0] || 'mp4';
    return `paste-${timestamp()}.${sub}`;
  }
  return `paste-${timestamp()}.bin`;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Insert the right node / mark for the asset's content type using
 * proper TipTap commands. This is the fix that makes images render
 * immediately instead of showing as raw markdown text.
 */
function insertAssetIntoEditor(
  editor: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  res: { relativeMarkdownPath: string; originalFileName: string },
  info: UploadInfo,
): void {
  const rel = res.relativeMarkdownPath;
  const name = res.originalFileName;
  const ct = info.contentType;

  if (ct.startsWith('image/')) {
    // The Image extension is registered in NoteEditor.tsx. setImage
    // inserts an <img> node at the current selection. The src stays
    // as the relative markdown path; the NoteEditor's src-rewriter
    // effect transforms it to the absolute /api/.../asset URL for
    // display.
    //
    // After insertion we add an empty paragraph below the image and
    // place the cursor inside it. createParagraphNear() alone wasn't
    // landing the cursor reliably — sometimes it dropped focus right
    // back into the (just-selected) image node. Doing it as two
    // explicit steps with insertContentAt + setTextSelection is
    // boring but correct: image goes in, paragraph after it, cursor
    // in paragraph, ready to type.
    editor
      .chain()
      .focus()
      .setImage({ src: rel, alt: name, title: name })
      .command(({ tr, dispatch }: CommandProps) => {
        // After setImage, the cursor sits adjacent to the image.
        // Insert an empty paragraph after the image's end position
        // and move the cursor into it.
        const insertAt = tr.selection.to;
        if (dispatch) {
          tr.insert(insertAt, editor.schema.nodes.paragraph.create());
          // +1 to land INSIDE the new paragraph (past its opening
          // boundary) rather than just before it.
          tr.setSelection(Selection.near(tr.doc.resolve(insertAt + 1)));
        }
        return true;
      })
      .run();
    return;
  }

  if (ct.startsWith('video/')) {
    // Use the custom Video node (registered in NoteEditor.tsx) so
    // the player renders immediately, not after save+reload. The
    // node's markdown serializer emits raw <video> HTML so the
    // round-trip through markdown is unchanged.
    editor
      .chain()
      .focus()
      .setVideo({ src: rel })
      .run();
    return;
  }

  // Other files: insert a hyperlink to the asset. The Link mark is
  // already configured in NoteEditor.tsx, so we use it directly.
  editor
    .chain()
    .focus()
    .insertContent({
      type: 'text',
      text: name,
      marks: [
        {
          type: 'link',
          attrs: {
            href: rel,
            target: '_blank',
            rel: 'noopener noreferrer nofollow',
          },
        },
      ],
    })
    .run();
}
