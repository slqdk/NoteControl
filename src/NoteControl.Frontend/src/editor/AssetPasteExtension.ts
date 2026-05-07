import { Extension, type CommandProps } from '@tiptap/core';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';

import { ApiError, assetsApi } from '../api/client';
import { normalizePastedHtml } from './PasteNormalizeExtension';

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
            // Branch 1 (existing): direct file paste — screenshots
            // (Win+Shift+S clipboard), drag from Explorer pasted as
            // file, etc. dt.files / kind:'file' on dt.items has the
            // bytes ready to upload immediately.
            const files = filesFromClipboard(event);
            if (files.length > 0) {
              event.preventDefault();
              void uploadAndInsertMany(editor, files, opts);
              return true;
            }

            // Branch 2 (Ship 95): Office HTML paste with embedded
            // image references. Word/Outlook put `text/html` on the
            // clipboard with `<img src="file:///.../msohtmlclip1/...">`
            // placeholders; the actual image bytes are reachable via
            // navigator.clipboard.read() but NOT in dt.files. We
            // need to: parse the HTML, fetch the image blobs, upload
            // each, rewrite the HTML's img srcs in DOM order, and
            // insert the rewritten HTML.
            //
            // Requires a secure context for navigator.clipboard.read()
            // to work. Localhost counts as secure; external HTTP does
            // not — the user gets best-effort fallback (text only,
            // images dropped) over plain HTTP.
            if (hasOfficeHtmlWithImagePlaceholders(event)) {
              event.preventDefault();
              void uploadAndInsertOfficeHtml(editor, event, opts);
              return true;
            }

            // Otherwise: let TipTap handle the paste normally.
            return false;
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

// ============================================================
// Ship 95 — Office HTML paste (Word, Outlook)
// ============================================================
//
// Word's "copy text + image + text" puts a multi-layered payload
// on the clipboard:
//   - text/html: the visible content with `<img src="file:///...">`
//     placeholders pointing at Word's local clip cache (unreadable
//     from the browser).
//   - text/plain: text only, no image refs.
//   - dt.files: usually empty (Word uses a different mechanism).
//   - navigator.clipboard.read() ClipboardItems: include the actual
//     image bytes as `image/png` blobs alongside the HTML.
//
// Strategy: parse the HTML, find every `<img>` whose src is a
// non-fetchable scheme (file:, cid:, x-mso-...), get the same
// number of image blobs from clipboard.read(), upload each, and
// rewrite the srcs in DOM order. Then insert the rewritten HTML
// — TipTap parses it with its schema and renders properly.
//
// Order preservation: querySelectorAll('img') returns elements in
// document order, which IS the visual reading order. Mapping
// blob[i] → img[i] preserves whatever order Word emitted (which
// we trust matches the visual order — Word's HTML is rendered
// content, not arbitrary).
//
// Async timing: handlePaste is synchronous; this function fires
// after preventDefault, runs async, and inserts when ready. The
// editor's selection at insertion time may differ from the paste
// position if the user clicked elsewhere mid-upload; we capture
// the selection range before the async work to insert at the
// right place.

function hasOfficeHtmlWithImagePlaceholders(event: ClipboardEvent): boolean {
  const dt = event.clipboardData;
  if (!dt) return false;

  const html = dt.getData('text/html');
  if (!html) return false;

  // Quick check: does it look like Office HTML with at least one
  // unfetchable image reference? We don't fully parse here — just
  // scan for the telltale patterns. False positives are cheap (we
  // proceed to the full parse and decide to fall back if it's not
  // really Office content).
  //
  // Patterns we look for:
  //   - file:/// — Word's clip cache references
  //   - cid: — Outlook content-id references (some cases)
  //   - mso- — MSO conditional / VML markers anywhere in HTML
  //
  // We deliberately allow ANY of these to match; combining them
  // would miss some real Word docs that emit just one pattern.
  const looksOffice =
    html.includes('file:///') ||
    html.includes('cid:') ||
    html.includes('mso-') ||
    html.includes('xmlns:o="urn:schemas-microsoft-com:office:office"');
  return looksOffice;
}

async function uploadAndInsertOfficeHtml(
  editor: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  event: ClipboardEvent,
  opts: AssetPasteOptions,
): Promise<void> {
  const dt = event.clipboardData;
  if (!dt || !editor) return;

  const html = dt.getData('text/html');
  if (!html) return;

  const notePath = opts.getNotePath();
  if (!notePath) return;

  // Capture the selection range NOW — by the time async upload work
  // finishes (could be several seconds for multi-image pastes), the
  // user may have clicked elsewhere. Inserting at the captured
  // position keeps the paste where they expected. We capture both
  // `from` and `to` so a non-empty selection (paste-replaces-selection)
  // is honoured even if the user moved the cursor mid-upload.
  const insertPos = editor.state.selection.from;
  const insertEnd = editor.state.selection.to;

  // Parse the HTML into a Document so we can manipulate <img>s.
  // DOMParser is built into the browser and tolerant of malformed
  // markup — exactly what we need for Word's output.
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Find all <img> tags whose src is unfetchable (file:, cid:, etc).
  // querySelectorAll returns DOM order = visual reading order, which
  // is what we map blobs to.
  //
  // We DON'T strip <img>s with http(s) src — those are real URLs
  // (e.g. someone pasted a web page through Word), they'll render
  // fine, and we leave them alone.
  const allImgs = Array.from(doc.querySelectorAll('img'));
  const placeholderImgs = allImgs.filter((img) => {
    const src = img.getAttribute('src') ?? '';
    return (
      src.startsWith('file:') ||
      src.startsWith('cid:') ||
      src.startsWith('x-mso-') ||
      // Empty src happens when VML is the primary representation
      // and the <img> fallback is just a marker.
      src === ''
    );
  });

  // Try to get the actual image bytes from the async clipboard API.
  // This requires:
  //   1. A secure context (HTTPS or localhost) — silently denied
  //      otherwise.
  //   2. User permission — first call may show a permission prompt;
  //      subsequent calls in the same origin reuse the grant.
  //   3. The browser supports the API (Chrome 76+, Edge, Firefox 90+
  //      with flags, Safari 13.1+ with limitations).
  //
  // Failures here all funnel into the best-effort fallback below.
  let blobs: Blob[] = [];
  if (placeholderImgs.length > 0 && window.isSecureContext) {
    try {
      blobs = await readClipboardImages();
    } catch (err) {
      // Permission denied, API unavailable, or network/timing
      // issue. Fall through to best-effort.
      // eslint-disable-next-line no-console
      console.warn('[AssetPasteExtension] navigator.clipboard.read() failed:', err);
    }
  }

  // Now decide which strategy to apply:
  if (blobs.length === placeholderImgs.length && blobs.length > 0) {
    // Order-preserving path: counts match, we can map 1:1.
    await uploadAndRewriteInPlace(blobs, placeholderImgs, opts);
  } else {
    // Best-effort: drop the placeholder <img>s from the HTML so they
    // don't render as broken icons. Upload whatever blobs we DID
    // get (often the lead image only) and append at the end of the
    // pasted content. Better than silently losing both ordering
    // AND the images.
    for (const img of placeholderImgs) {
      img.remove();
    }
  }

  // Insert the rewritten HTML at the captured cursor position.
  // TipTap's schema-driven parser drops MSO clutter, VML, and
  // conditional comments automatically — we don't need to clean
  // them up first. The body's innerHTML has the visible content.
  //
  // Run our paste normalizer over the rewritten HTML so the same
  // font-family / font-size / colour / background-color stripping
  // applies as in the regular text-paste path. Without this, the
  // Office-image branch would slip a fully-styled Word paste
  // straight past the editor's normalisation rules.
  // PasteNormalizeExtension's transformPastedHTML hook doesn't fire
  // here because we're inserting via insertContentAt, not via the
  // browser's paste pipeline.
  //
  // If the user had a selection at paste time (insertPos < insertEnd),
  // .deleteRange replaces it — standard paste behaviour. Empty
  // selection is a no-op delete, then a regular insert.
  const cleanedHtml = normalizePastedHtml(doc.body.innerHTML);
  editor
    .chain()
    .focus()
    .deleteRange({ from: insertPos, to: insertEnd })
    .insertContentAt(insertPos, cleanedHtml)
    .run();

  // Best-effort: if there were leftover blobs we couldn't map,
  // upload + append them at the end. This handles the case where
  // navigator.clipboard.read() returned MORE blobs than we found
  // <img> placeholders for (rare, but happens with some Word
  // versions that include the screenshot of the entire selection).
  if (blobs.length > placeholderImgs.length) {
    const extras = blobs.slice(placeholderImgs.length);
    for (const blob of extras) {
      const file = blobToFile(blob, opts);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await uploadAndInsertOne(editor as any, file, opts);
    }
  } else if (blobs.length === 0 && placeholderImgs.length > 0) {
    // Best-effort tier 2: we had placeholders but couldn't get
    // ANY blobs (HTTP context, permission denied, no API). The
    // images are gone. Surface a one-line warning via the upload
    // error callback so the user knows what happened — using the
    // same error channel as failed uploads keeps the UX
    // consistent.
    opts.onUploadError?.(
      {
        fileName: '(Word images)',
        contentType: 'text/html',
        sizeBytes: html.length,
      },
      new Error(
        window.isSecureContext
          ? 'Could not read images from clipboard (permission denied or unsupported browser).'
          : 'Word image paste requires HTTPS — pasted text only.',
      ),
    );
  }
}

/**
 * Read all image/* blobs from navigator.clipboard.read(). Returns
 * blobs in clipboard order, which usually matches visual order in
 * the source document.
 *
 * Throws if the API is unavailable or denied. Caller decides how
 * to handle.
 */
async function readClipboardImages(): Promise<Blob[]> {
  // Type assertion: the spec is widely implemented but the TS lib
  // types lag in some configurations. Cast to silence + run.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clipboardApi = (navigator as any).clipboard;
  if (!clipboardApi || typeof clipboardApi.read !== 'function') {
    throw new Error('navigator.clipboard.read() not available');
  }

  const items = await clipboardApi.read();
  const out: Blob[] = [];
  for (const item of items) {
    for (const type of item.types as string[]) {
      if (type.startsWith('image/')) {
        out.push(await item.getType(type));
      }
    }
  }
  return out;
}

/**
 * Upload each blob and rewrite the corresponding <img>'s src to
 * the uploaded relative path. Mutates the imgs array in place.
 *
 * Sequential rather than parallel: server-side asset upload is
 * lightweight, but parallel uploads from the same note risk
 * filename collisions (e.g. paste-1.png written twice in the
 * same millisecond). Sequential keeps it boring and correct.
 */
async function uploadAndRewriteInPlace(
  blobs: Blob[],
  imgs: HTMLImageElement[],
  opts: AssetPasteOptions,
): Promise<void> {
  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i];
    const img = imgs[i];

    // Build a filename. Word doesn't expose original names; we use
    // the same paste-<timestamp>.<ext> pattern as the screenshot
    // handler, with an index suffix so multi-image pastes don't
    // collide on rapid uploads.
    const ext = (blob.type.split('/')[1] || 'png').split(';')[0];
    const fileName = `paste-${timestamp()}-${i}.${ext}`;
    const file = new File([blob], fileName, { type: blob.type });

    const info: UploadInfo = {
      fileName,
      contentType: blob.type || 'image/png',
      sizeBytes: blob.size,
    };
    opts.onUploadStart?.(info);

    try {
      const res = await assetsApi.upload(
        opts.vaultId,
        opts.getNotePath(),
        file,
        fileName,
      );
      // Rewrite the src to the relative markdown path. The note
      // editor's src-rewriter effect transforms it to the absolute
      // /api/.../asset URL for display.
      img.setAttribute('src', res.relativeMarkdownPath);
      // Strip any leftover Word-specific attributes that would
      // cause TipTap to reject or render oddly.
      img.removeAttribute('width');
      img.removeAttribute('height');
      img.removeAttribute('style');
      opts.onUploadComplete?.(info);
    } catch (err) {
      opts.onUploadError?.(info, err);
      // Mark the image as failed — remove it from the DOM so we
      // don't paste a broken-icon <img> with the local file: src.
      img.remove();
    }
  }
}

/**
 * Wrap a clipboard Blob into a File with a generated name for
 * upload. Used for the "extra blobs that didn't map to any img
 * placeholder" fallback path.
 */
function blobToFile(blob: Blob, _opts: AssetPasteOptions): File {
  const ext = (blob.type.split('/')[1] || 'png').split(';')[0];
  const fileName = `paste-${timestamp()}.${ext}`;
  return new File([blob], fileName, { type: blob.type });
}
