import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
// Table extensions: our extended versions add a per-table rowHeight
// attribute (TableWithOptions) and a per-cell align attribute
// (TableCellWithAlign / TableHeaderWithAlign). The upstream TableRow
// is unchanged — rows have no extra attributes in our model. See
// TableWithOptions.ts for the markdown round-trip rules.
import { TableWithOptions } from '../editor/TableWithOptions';
import TableRow from '@tiptap/extension-table-row';
import { TableCellWithAlign, TableHeaderWithAlign } from '../editor/TableCellWithAlign';

import { ImageWithControls } from '../editor/ImageWithControls';
import { VideoExtension } from '../editor/VideoExtension';
import { CodeBlockWithTitle } from '../editor/CodeBlockWithTitle';
import { CalloutExtension } from '../editor/CalloutExtension';
import { TableDeleteShortcut } from '../editor/TableDeleteShortcut';
import { tableAwareClipboardTextSerializer } from '../editor/tableClipboardSerializer';
import { TrailingParagraph } from '../editor/TrailingParagraph';
import { MarkdownExtension } from '../markdown/markdownExtension';
import { AssetPasteExtension, type UploadInfo } from '../editor/AssetPasteExtension';
import { SlashMenuExtension } from '../editor/SlashMenuExtension';
import { StAutocompleteExtension } from '../editor/StAutocompleteExtension';
import { UnderlineMark } from '../editor/UnderlineMark';
import { ColorMark } from '../editor/ColorMark';
import { FontFamilyMark } from '../editor/FontFamilyMark';
import { FontSizeMark } from '../editor/FontSizeMark';
import { PasteNormalizeExtension } from '../editor/PasteNormalizeExtension';
import { CodeBlockPlainPasteExtension } from '../editor/CodeBlockPlainPasteExtension';
import {
  MathPasteExtension,
  preprocessMarkdownForMath,
} from '../editor/MathPasteExtension';
import { MathExtension } from '../editor/MathExtension';
import { refreshTemplates } from '../editor/templateCache';
import { ApiError, assetsApi, notesApi } from '../api/client';
import { useNoteDefaults, resolveNoteAppearance } from '../settings/noteDefaults';
import { useIsMobile } from '../hooks/useIsMobile';
import { showToast } from '../utils/toast';
import type { NoteDto } from '../api/types';
import type { SaveState } from './SaveStatusIndicator';
import { TableToolbar } from './TableToolbar';
import { TableInsertDialog, type TableInsertOpts } from './TableInsertDialog';
import { BubbleMenu } from './BubbleMenu';
import { MobileNoteProperties } from './MobileNoteProperties';

// Coalesce rapid keystrokes into one PUT, but do it quickly enough
// that a typical pause-and-navigate gesture lets the save fire
// before the user moves on. 800ms is the Notion / Google Docs
// neighbourhood. The old 2000ms felt unresponsive and meant a
// quick edit + tree-click could leave the change unsaved.
//
// In addition to the debounce, the editor also flushes the pending
// save synchronously on:
//   - editor blur (clicking away from the editor surface)
//   - tab / window losing visibility
//   - component unmount (best-effort fire-and-forget; the request
//     races with the unmount but the server still receives it)
//   - Ctrl+S / Cmd+S keyboard shortcut
// so the debounce delay matters less for "I'm leaving the note"
// scenarios than it used to.
const AUTOSAVE_DEBOUNCE_MS = 800;

/** Public shape for an in-flight upload, surfaced to the host page. */
export interface EditorUpload {
  id: number;
  info: UploadInfo;
  error?: string;
}

/**
 * Outcome of a saveNow() call. Used by the navigation guard to
 * decide whether to show the "save failed" dialog before letting
 * a click-away navigation through.
 *
 *   'ok'       - saved successfully, or nothing to save.
 *   'failed'   - network/server error. Toast + red badge already
 *                shown; the dialog (if invoked from the guard) is
 *                in addition to those.
 *   'conflict' - 412 from the server. Treated the same as 'failed'
 *                by the guard (don't navigate without confirmation),
 *                but the Retry button is hidden because retrying
 *                wouldn't help.
 */
export type SaveNowOutcome = 'ok' | 'failed' | 'conflict';

interface NoteEditorProps {
  vaultId: string;
  initialNote: NoteDto;
  /**
   * Optional listeners that let the host page render the save status
   * and upload pills wherever it wants. We previously rendered both
   * inside an in-editor toolbar; that's gone now (the breadcrumb row
   * shows them instead). Callbacks are optional so the editor still
   * works headlessly in tests / future embeddings.
   */
  onSaveStateChange?: (state: SaveState) => void;
  onUploadsChange?: (uploads: EditorUpload[]) => void;
  /**
   * Reports a stable saveNow function up to the host so the host
   * can wire it to the Retry button in the SaveStatusIndicator
   * AND to the navigation guard. Called once per editor mount.
   * The function bypasses the debounce, awaits the current/next
   * save attempt, and resolves to 'ok' | 'failed' | 'conflict'.
   */
  onSaveNowReady?: (saveNow: () => Promise<SaveNowOutcome>) => void;
}

/**
 * The editing surface for one note.
 *
 * Save lifecycle: TipTap onUpdate → debounce 2 s → PUT with current
 * markdown + last-known etag. On 412 we surface a conflict the user
 * has to resolve by reloading.
 *
 * Save state and active uploads used to be rendered in an in-editor
 * toolbar at the top of this component. That toolbar is gone — both
 * are now reported via the optional callbacks so the host page can
 * render them next to the breadcrumb path. This keeps the editor
 * itself as just "the page" with no chrome above it.
 */
export function NoteEditor({
  vaultId,
  initialNote,
  onSaveStateChange,
  onUploadsChange,
  onSaveNowReady,
}: NoteEditorProps) {
  // Ship 84: drives whether we render the mobile properties section
  // below the editor's page area. Desktop never sees that block —
  // properties live in the right rail there.
  const isMobile = useIsMobile();

  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });

  /**
   * Active uploads (paste/drop in flight). The host page renders the
   * pills; we just keep the list and emit it on change.
   */
  const [uploads, setUploads] = useState<EditorUpload[]>([]);
  const uploadIdRef = useRef(0);

  // Bubble save state + uploads to the host page on change. We keep
  // the callbacks in refs so the effect below doesn't re-fire when
  // the parent re-renders with a new function identity (which would
  // cause a render loop if the parent's render also changes when we
  // tell it the save state changed).
  const onSaveStateChangeRef = useRef(onSaveStateChange);
  const onUploadsChangeRef = useRef(onUploadsChange);
  useEffect(() => {
    onSaveStateChangeRef.current = onSaveStateChange;
  }, [onSaveStateChange]);
  useEffect(() => {
    onUploadsChangeRef.current = onUploadsChange;
  }, [onUploadsChange]);

  useEffect(() => {
    onSaveStateChangeRef.current?.(saveState);
  }, [saveState]);
  useEffect(() => {
    onUploadsChangeRef.current?.(uploads);
  }, [uploads]);

  const noteForUploadRef = useRef(initialNote.path);
  useEffect(() => {
    noteForUploadRef.current = initialNote.path;
  }, [initialNote.path]);

  // Keep the slash menu's template list current. Templates are
  // fetched once per editor mount; the cache is shared across all
  // editor instances of the same vault. After the user creates or
  // edits a template via the manage-templates page, that page
  // calls refreshTemplates() too — so the list stays fresh.
  useEffect(() => {
    void refreshTemplates(vaultId);
  }, [vaultId]);

  const lastSavedMarkdownRef = useRef<string>(initialNote.body);
  const etagRef = useRef<string>(initialNote.etag);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<boolean>(false);
  const pendingMarkdownRef = useRef<string | null>(null);
  const editorRef = useRef<Editor | null>(null);

  // Table insert dialog — shown when the user picks Table from the
  // slash menu. The slash item calls onTableInsertRequest (passed via
  // SlashMenuExtension's context) which sets this state to true; the
  // dialog renders below the editor shell. On confirm we run the
  // editor's insertTable command with the chosen dimensions and
  // optional rowHeight; on cancel we just hide the dialog.
  //
  // The slash item runs deleteRange(range) on the user's "/" + filter
  // text BEFORE invoking the request, so by the time the dialog
  // confirms there's no stray "/" to clean up — we just insertTable
  // at the current selection.
  const [tableInsertDialogOpen, setTableInsertDialogOpen] = useState(false);

  // Tracks the currently-running performSave promise, if any. Lets
  // saveNow() wait for an in-flight debounced save to settle rather
  // than racing with it. Cleared in the finally block.
  const inFlightPromiseRef = useRef<Promise<SaveNowOutcome> | null>(null);

  const performSave = useCallback(async (): Promise<SaveNowOutcome> => {
    const editor = editorRef.current;
    if (!editor) return 'ok';

    const markdown = editor.storage.markdown.getMarkdown() as string;
    if (markdown === lastSavedMarkdownRef.current) {
      setSaveState({ kind: 'saved' });
      return 'ok';
    }

    // Re-entrant call while a save is already running: stash the
    // latest markdown and join the existing promise. The in-flight
    // save's finally block will pick up pendingMarkdownRef and
    // chain a follow-up; that follow-up returns to all awaiters
    // through the promise we hand back here.
    //
    // Note we explicitly return the in-flight promise so saveNow()
    // sees the FINAL outcome (after any chained follow-up), not
    // the intermediate one.
    if (inFlightRef.current && inFlightPromiseRef.current !== null) {
      pendingMarkdownRef.current = markdown;
      return inFlightPromiseRef.current;
    }

    inFlightRef.current = true;
    setSaveState({ kind: 'saving' });

    const promise = (async (): Promise<SaveNowOutcome> => {
      let outcome: SaveNowOutcome;
      try {
        const updated = await notesApi.update(vaultId, initialNote.path, {
          body: markdown,
          etag: etagRef.current,
        });
        etagRef.current = updated.etag;
        lastSavedMarkdownRef.current = markdown;
        setSaveState({ kind: 'saved' });
        // Notify the Properties panel that the body just changed on
        // disk. The panel listens so it can refetch the history count
        // and keep its "Revert to last save (N)" label fresh. Without
        // this, the count would only refresh on selection-change or
        // a property save, which leaves the button stale or even
        // wrongly-disabled on a brand-new note.
        window.dispatchEvent(
          new CustomEvent('nc:note-body-saved', {
            detail: { path: initialNote.path },
          }),
        );
        outcome = 'ok';
      } catch (e) {
        // Surface the failure loudly. The small badge in the breadcrumb
        // row was easy to miss - the user reported assuming the save
        // worked and losing work. A toast forces the failure into the
        // user's attention; the badge stays errored until either a
        // manual Retry, the next keystroke (which re-arms the debounce
        // and fires a fresh PUT), or a successful save.
        if (e instanceof ApiError && e.status === 412) {
          const message =
            'Another change was saved while you were editing. ' +
            'Reload the note to see the latest version (your unsaved changes will be lost).';
          setSaveState({ kind: 'conflict', message });
          showToast('Save conflict - reload the note', 6000);
          outcome = 'conflict';
        } else {
          const message = e instanceof Error ? e.message : 'Save failed.';
          setSaveState({ kind: 'error', message });
          // Slightly longer toast for save errors than the default
          // 3s - users need to register that "saved" never appeared.
          showToast(`Save failed: ${message}`, 6000);
          outcome = 'failed';
        }
      } finally {
        inFlightRef.current = false;
      }

      // Pending follow-up: a re-entrant call landed during the
      // network round-trip. Chain a fresh save (immediate, NOT
      // debounced - the user has already paused; no need to wait
      // another 800ms before the second save). The chained save's
      // outcome supersedes the one we just computed - that's the
      // value awaiters should see.
      //
      // The recursive call uses the `performSave` name from the
      // enclosing useCallback. By the time this async closure
      // runs, `performSave` is bound to the same callback we're
      // inside, so the recursion picks up the latest version
      // (and goes through the normal path, since inFlightRef is
      // false again at this point).
      if (pendingMarkdownRef.current !== null) {
        const next = pendingMarkdownRef.current;
        pendingMarkdownRef.current = null;
        if (next !== lastSavedMarkdownRef.current) {
          outcome = await performSave();
        }
      }
      return outcome;
    })();

    inFlightPromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      // Only clear if this was the most recent in-flight - a
      // chained recursion may have replaced it.
      if (inFlightPromiseRef.current === promise) {
        inFlightPromiseRef.current = null;
      }
    }
  }, [vaultId, initialNote.path]);

  const scheduleSave = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void performSave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [performSave]);

  /**
   * Bypass the debounce and save immediately. Used by:
   *   - editor blur (clicked away from the surface)
   *   - tab / window visibility change (going hidden)
   *   - component unmount (best-effort fire-and-forget)
   *   - Ctrl+S / Cmd+S
   *   - manual Retry button on the save-status indicator
   *   - the navigation guard (click another note while dirty)
   *
   * Returns 'ok' | 'failed' | 'conflict' so callers that care
   * (the navigation guard) can react. Most call sites ignore the
   * return value - the toast and badge tell the user enough on
   * their own.
   *
   * If a debounced save is already in flight, this awaits THAT
   * save (and any chained follow-up) rather than starting a fresh
   * one - the in-flight save already represents the latest text,
   * so duplicating it would double-PUT for no reason.
   */
  const saveNow = useCallback(async (): Promise<SaveNowOutcome> => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    return await performSave();
  }, [performSave]);

  // Hand saveNow up to the host once (and again if its identity
  // changes - it stays stable across renders unless performSave
  // itself rebinds, which only happens when initialNote.path or
  // vaultId change). The host wires this to the Retry button on
  // the SaveStatusIndicator.
  const onSaveNowReadyRef = useRef(onSaveNowReady);
  useEffect(() => {
    onSaveNowReadyRef.current = onSaveNowReady;
  }, [onSaveNowReady]);
  useEffect(() => {
    onSaveNowReadyRef.current?.(saveNow);
  }, [saveNow]);

  const editor = useEditor(
    {
      extensions: [
        // We disable StarterKit's codeBlock and use our custom
        // CodeBlockWithTitle instead. The rest of StarterKit
        // (paragraphs, headings, lists, code marks, etc.) stays
        // as-is.
        StarterKit.configure({
          codeBlock: false,
        }),
        CodeBlockWithTitle,
        // Tables — GFM-style. Resizable=true so users can drag
        // column widths via the right edge of any cell. Our extended
        // TableWithOptions adds a `rowHeight` attribute (driven by the
        // table popup's Row Height field) plus a markdown serializer
        // that emits raw HTML when rowHeight or per-cell alignment is
        // set, falling back to clean GFM pipe syntax otherwise.
        TableWithOptions.configure({
          // Column resize is built into @tiptap/extension-table.
          // Drag the right edge of any cell to resize that column.
          // handleWidth: the px-width of the drag-zone on the cell
          //   border. 5 is the upstream default; we leave it.
          // cellMinWidth: minimum column width in pixels — keeps
          //   users from accidentally collapsing a column to nothing.
          resizable: true,
          handleWidth: 5,
          cellMinWidth: 40,
        }),
        TableRow,
        TableHeaderWithAlign,
        TableCellWithAlign,
        // Del/Backspace deletes the whole table when the user has
        // drag-selected every cell. Replaces the toolbar's old ✕
        // button with a more deliberate keyboard gesture.
        TableDeleteShortcut,
        // Callouts (admonitions) — five colour-coded variants. See
        // CalloutExtension for the GitHub-style markdown round-trip.
        CalloutExtension,
        Link.configure({
          openOnClick: false,
          HTMLAttributes: {
            target: '_blank',
            rel: 'noopener noreferrer nofollow',
          },
        }),
        // Underline mark — Ctrl+U toggles. Local extension (not the
        // npm @tiptap/extension-underline package) since the mark
        // is small and adding a dependency for ~30 lines wasn't
        // worth it. Renders as <u>; round-trips through markdown
        // as raw HTML via tiptap-markdown's html-mark fallback,
        // which is the standard answer for non-CommonMark inline
        // marks.
        UnderlineMark,
        // Per-selection text colour. Renders as
        // <span style="color: …">…</span>. The colour palette in
        // the bubble menu sets / clears it.
        ColorMark,
        // Per-selection font family / size — applied via the
        // bubble menu's Font and Size dropdowns. Same render
        // shape as ColorMark (single-attribute span). The
        // surrounding text inherits the note default; only the
        // marked range overrides.
        FontFamilyMark,
        FontSizeMark,
        // Strip font-family / font-size / colour styling from
        // pasted HTML so pasted text inherits the note's defaults.
        // Bold / italic / underline / strike / code / link marks
        // are preserved by the schema as usual — the normalizer
        // only removes inline-style declarations and Word's
        // mso-* clutter, never the elements themselves. The
        // user's OWN clicks (font/size/colour from the popup)
        // come through chain commands, never the paste path,
        // so the normalizer has no effect on those.
        PasteNormalizeExtension,
        Placeholder.configure({
          placeholder: 'Start typing…',
        }),
        // Custom Image node with resize handles, border toggle, and
        // controls toolbar. Replaces the upstream @tiptap/extension-image.
        // Block-level only (matches Notion / Obsidian).
        ImageWithControls.configure({
          allowBase64: false,
        }),
        // Custom Video node — same shape as ImageWithControls but
        // for inline video. Renders a real <video> element with
        // browser-default controls (play/pause/scrub) plus our own
        // resize handle + delete button when active.
        VideoExtension,
        // Custom paste/drop interceptor: turns clipboard files into
        // uploaded assets + markdown references. See the extension
        // for the dispatch (image / video / file).
        AssetPasteExtension.configure({
          vaultId,
          getNotePath: () => noteForUploadRef.current,
          onUploadStart: (info) => {
            const id = ++uploadIdRef.current;
            setUploads((prev) => [...prev, { id, info }]);
          },
          onUploadComplete: (info) => {
            setUploads((prev) =>
              prev.filter((u) => u.info.fileName !== info.fileName),
            );
          },
          onUploadError: (info, error) => {
            const message =
              error instanceof Error ? error.message : 'Upload failed.';
            setUploads((prev) =>
              prev.map((u) =>
                u.info.fileName === info.fileName ? { ...u, error: message } : u,
              ),
            );
          },
        }),
        // When the cursor is inside a code block, force paste to
        // be plain-text only — bypass the HTML pipeline entirely.
        // This stops our own <pre data-title="..."><code>...</code></pre>
        // wrapper (which the browser puts on the clipboard alongside
        // text/plain when copying from a rendered code block) from
        // ending up as escaped literal HTML inside the destination
        // code block. Must sit AFTER AssetPasteExtension so file /
        // screenshot paste still wins; that path is unrelated to
        // this fix.
        CodeBlockPlainPasteExtension,
        // Math nodes (mathInline + mathBlock) plus the
        // MathPasteExtension that turns LaTeX delimiters in pasted
        // text/HTML into math nodes. Registered after the other
        // paste interceptors so file/image paste still wins on
        // their respective paths, and after PasteNormalizeExtension
        // so HTML normalization (Word/Excel cruft removal) is done
        // before we look for KaTeX MathML annotations on
        // text/html. The MathExtension nodes register parseHTML
        // for `[data-math-inline]` / `[data-math-block]` so the
        // placeholders produced by the paste path become real
        // math nodes during the slice import. See
        // editor/MathPasteExtension.ts and editor/MathExtension.ts.
        MathPasteExtension,
        ...MathExtension,
        // Slash menu (Notion-style insert popup). Triggered by
        // typing "/" — shows a filterable list of insertable
        // blocks (headings, lists, code, image, etc.).
        //
        // onTableInsertRequest opens our TableInsertDialog so the
        // user can pick rows/cols/header/rowHeight before insertion.
        // The slash item has already deleted the trigger range when
        // this fires — we only need to flip the dialog visible.
        // setTableInsertDialogOpen is a useState setter with stable
        // identity across renders, so it's safe to capture in the
        // useEditor closure (which only rebuilds when initialNote.path
        // changes — see the deps array at the bottom of useEditor).
        SlashMenuExtension.configure({
          context: {
            vaultId,
            getNotePath: () => noteForUploadRef.current,
            onTableInsertRequest: () => setTableInsertDialogOpen(true),
          },
        }),
        // F2 autocomplete inside Structured Text code blocks.
        // Declaration mode → built-in types + FB types (BOOL, INT,
        // TON, ...). Implementation mode → variables parsed from
        // the preceding Declaration block. See StAutocompleteExtension
        // for the mode-resolution rules.
        StAutocompleteExtension,
        MarkdownExtension,
        // Ensure the doc always ends in a paragraph so the cursor
        // can escape downward from a trailing callout / table /
        // code block / horizontal rule / image / video. See
        // TrailingParagraph for the rationale and why this doesn't
        // pollute markdown saves or undo history.
        TrailingParagraph,
      ],
      // The body string is pre-processed to inline math placeholders
      // BEFORE tiptap-markdown parses it. preprocessMarkdownForMath
      // converts `$..$`, `$$..$$`, `\(..\)`, `\[..\]` into the
      // `<span data-math-inline>` / `<div data-math-block>` HTML
      // markers that the MathExtension's parseHTML rules turn into
      // real math nodes. Without this step, math nodes would survive
      // a save (the serializer emits `$..$` / `$$..$$`) but would
      // NOT render on the next load — they'd come back as literal
      // dollar-delimited text. See editor/MathPasteExtension.ts and
      // editor/mathParser.ts for the scanner rules (Pandoc whitespace
      // protection, currency-safe `$5 and $10`, code-fence skipping).
      content: preprocessMarkdownForMath(initialNote.body),
      // When a note is marked locked in its frontmatter, the editor
      // becomes read-only. The user can still navigate to it, copy
      // text out, and inspect its properties, but typing has no
      // effect (TipTap discards keystrokes silently).
      //
      // Locked is a hint, not a security boundary — the API still
      // accepts updates from a locked note. The UI honours the
      // hint to avoid accidental edits. A future "unlock first"
      // affordance could be wired into the toolbar.
      editable: !initialNote.frontmatter.locked,
      editorProps: {
        attributes: {
          class: initialNote.frontmatter.locked
            ? 'nc-editor nc-editor-locked'
            : 'nc-editor',
          spellcheck: 'false',
        },
        // Override the text/plain channel of the clipboard. Default
        // prosemirror behaviour, when copying from inside a table
        // cell (especially via CellSelection — double-click,
        // drag-select with cell boundaries, etc.), can hand the
        // HTML serialization to the plain-text clipboard channel
        // too. Pasting into a plain-text target (Notepad, email
        // subject line, the browser address bar) then shows the
        // literal `<table>...<td>hello</td>...</table>` wrapper
        // instead of just "hello". The helper turns single-cell
        // copies into clean text, and multi-cell copies into
        // tab/newline-separated spreadsheet-style text. See
        // editor/tableClipboardSerializer.ts for the walk.
        clipboardTextSerializer: tableAwareClipboardTextSerializer,
      },
      onUpdate: ({ editor: ed }) => {
        const md = ed.storage.markdown.getMarkdown() as string;
        if (md !== lastSavedMarkdownRef.current) {
          setSaveState({ kind: 'dirty' });
          scheduleSave();
        } else {
          setSaveState({ kind: 'saved' });
          if (debounceTimerRef.current !== null) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
          }
        }
      },
      // When the editor loses focus (user clicks the properties
      // panel, the tree, the breadcrumb, anywhere outside the
      // ProseMirror surface), flush any pending save right away.
      // This is the "click away = save" gesture the user asked
      // for. It also covers tab-key escape and most non-keyboard
      // navigation gestures.
      //
      // Bubble menu / table toolbar clicks: ProseMirror keeps
      // focus on the editor for these (they use mousedown
      // preventDefault internally), so they don't trigger blur.
      // If they did, calling saveNow() here would still be safe -
      // performSave is idempotent when nothing has changed.
      onBlur: () => {
        if (debounceTimerRef.current !== null) {
          void saveNow();
        }
      },
    },
    [initialNote.path],
  );

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    lastSavedMarkdownRef.current = initialNote.body;
    etagRef.current = initialNote.etag;
    pendingMarkdownRef.current = null;
    setSaveState({ kind: 'idle' });
  }, [initialNote.path, initialNote.body, initialNote.etag]);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (saveState.kind === 'dirty' || saveState.kind === 'saving') {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveState.kind]);

  useEffect(() => {
    return () => {
      // On unmount (note switch, navigating away from the editor
      // route, full SPA tear-down), fire any pending save instead
      // of just cancelling the debounce timer. The previous
      // behaviour - clear the timer and walk away - was the source
      // of the bug where a quick edit + tree-click lost the change.
      //
      // This is fire-and-forget: by the time the cleanup runs the
      // component is gone, so there's nothing to await against.
      // The fetch lives on past unmount and reaches the server
      // regardless. If it fails, there's no UI here to surface
      // it - but the error already toasted via performSave's catch
      // (showToast lives on document.body, independent of React's
      // tree), and the next time the user opens the note they'll
      // see the unsaved version.
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        // Fire the save we were holding back. performSave reads
        // the editor via editorRef.current, which is still pointing
        // at the live editor at this moment in the cleanup phase
        // (it's nulled by the editor's own teardown shortly after).
        void performSave();
      }
    };
  }, [performSave]);

  // Save on tab/window visibility change. When the user switches
  // tabs, minimises, or otherwise hides this page, flush any
  // pending edits so they aren't lost if the browser is closed
  // from the OS task switcher.
  //
  // We use visibilitychange rather than blur on window because
  // window-blur fires for trivial focus shifts (clicking the
  // address bar) which doesn't justify a network call.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        if (debounceTimerRef.current !== null || saveState.kind === 'dirty') {
          void saveNow();
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [saveNow, saveState.kind]);

  // Ctrl+S / Cmd+S: force-save now. Documented behaviour in
  // notes.md ("Ctrl+S - force-save (debounced auto-save runs
  // anyway)") that wasn't actually wired up before this ship.
  // We listen on the window so the shortcut works even when
  // focus is in the bubble menu / table toolbar / properties
  // panel, not just the editor surface itself.
  //
  // preventDefault stops the browser's "save page as..." dialog,
  // which would otherwise pop up over the app.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isSave =
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === 's' || e.key === 'S');
      if (!isSave) return;
      e.preventDefault();
      void saveNow();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveNow]);

  /**
   * Rewrite the `src` of <img>, <video>, and <source> elements so a
   * relative markdown path resolves to the authenticated asset
   * endpoint.
   *
   * The naive approach (listen on editor.on('update')) misses two
   * cases that bit us in step 8a:
   *
   *   1. Initial render: the effect runs after React commits, but
   *      the editor.view.dom may not contain images yet (TipTap
   *      finishes rendering shortly after).
   *   2. Programmatic setImage: TipTap fires `update` AFTER the DOM
   *      is patched — but in some browser configurations the order
   *      is racy, and our rewriter runs on stale DOM.
   *
   * MutationObserver fixes both: it sees ANY DOM change inside the
   * editor and re-runs the rewrite. Cheap because it's idempotent
   * (we skip elements whose src has already been resolved).
   *
   * Also: prevent images from being selected as ProseMirror node-
   * selections by intercepting mousedown. A NodeSelection on a
   * block image makes any subsequent keystroke replace the image
   * (which is why the image was disappearing when clicked). The
   * editor stays interactive — you can still place a cursor before
   * or after the image to type.
   */
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;

    const idx = initialNote.path.lastIndexOf('/');
    const noteParent = idx === -1 ? '' : initialNote.path.slice(0, idx);

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

        // URL-decode each segment of the relative path. The server
        // emits markdown paths with %20 etc. for safety in the
        // markdown source; the actual filenames on disk and in the
        // canonical path stored server-side use literal spaces. So
        // before we hand off to assetsApi.serveUrl (which does its
        // own encodeURIComponent), we need to decode first to
        // avoid double-encoding.
        const decodedRelative = cleaned
          .split('/')
          .map((segment) => {
            try {
              return decodeURIComponent(segment);
            } catch {
              // Malformed escape — leave as-is rather than crash.
              return segment;
            }
          })
          .join('/');

        const canonical = noteParent
          ? `${noteParent}/${decodedRelative}`
          : decodedRelative;
        const absoluteUrl = assetsApi.serveUrl(vaultId, canonical);
        el.setAttribute('src', absoluteUrl);
      });
    }

    rewrite();

    // The ImageNodeView's NodeViewWrapper handles its own click
    // semantics — selection, controls, etc. — so we no longer need
    // a global mousedown defang on the editor DOM. Earlier versions
    // of this file caught img mousedowns to prevent ProseMirror from
    // creating a NodeSelection (which made images vanish on the
    // next keystroke); the node view sidesteps that entirely by
    // rendering its own React surface that intercepts clicks
    // before they reach PM.

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
  }, [editor, initialNote.path, vaultId]);

  /**
   * Per-note appearance: font / font-size / width.
   *
   * Values come from frontmatter at mount, then update live when the
   * user changes them in the properties panel. The panel saves via
   * the API and dispatches a window event ('nc:note-appearance-changed')
   * so we don't need to remount the editor or re-fetch the whole
   * note here.
   *
   * The values are written as CSS custom properties on the
   * .nc-editor-shell wrapper (see the effect further down). The
   * .nc-editor stylesheet rule reads them via var() with sensible
   * fallbacks. We use vars on a stable wrapper rather than inline
   * styles on view.dom because ProseMirror occasionally rebuilds
   * the contenteditable element.
   */
  const [appearance, setAppearance] = useState<{
    font: string | null;
    fontSize: number | null;
    width: number | null;
  }>(() => ({
    font: initialNote.frontmatter.font,
    fontSize: initialNote.frontmatter.fontSize,
    width: initialNote.frontmatter.width,
  }));

  // Reset on note swap. Without this, opening a different note
  // would briefly show the previous note's font until the new
  // initialNote.frontmatter trickled in.
  useEffect(() => {
    setAppearance({
      font: initialNote.frontmatter.font,
      fontSize: initialNote.frontmatter.fontSize,
      width: initialNote.frontmatter.width,
    });
  }, [
    initialNote.path,
    initialNote.frontmatter.font,
    initialNote.frontmatter.fontSize,
    initialNote.frontmatter.width,
  ]);

  // Listen for live updates from the properties panel.
  useEffect(() => {
    function onChange(e: Event) {
      const ce = e as CustomEvent<{
        path: string;
        field: 'font' | 'fontSize' | 'width';
        value: string | number;
      }>;
      // Ignore events for other notes — multi-tab safety, also lets
      // future per-note panels not stomp on each other.
      if (!ce.detail || ce.detail.path !== initialNote.path) return;

      setAppearance((prev) => {
        if (ce.detail.field === 'font') {
          const v = ce.detail.value as string;
          return { ...prev, font: v === '' ? null : v };
        }
        if (ce.detail.field === 'fontSize') {
          const v = ce.detail.value as number;
          return { ...prev, fontSize: v <= 0 ? null : v };
        }
        // width
        const v = ce.detail.value as number;
        return { ...prev, width: v <= 0 ? null : v };
      });
    }
    window.addEventListener('nc:note-appearance-changed', onChange);
    return () => {
      window.removeEventListener('nc:note-appearance-changed', onChange);
    };
  }, [initialNote.path]);

  // Undo/Redo bridge to the Properties panel.
  //
  // The panel and the editor are siblings in the React tree, with no
  // shared parent that holds an editor ref. To keep them decoupled we
  // use the same window-event pattern the appearance and view-mode
  // wiring uses:
  //
  //   - Panel → editor: nc:note-tiptap-undo / nc:note-tiptap-redo.
  //     Editor receives, calls editor.commands.undo()/redo().
  //   - Editor → panel: nc:note-undo-state with { canUndo, canRedo }.
  //     Dispatched on every transaction (so the panel's buttons
  //     enable/disable correctly) and once on mount (so the initial
  //     state is known before the user types).
  //
  // The path is included in every event detail so multi-tab and
  // multi-instance setups don't cross-fire. The path check is the
  // same idea as the appearance listener above.
  useEffect(() => {
    if (!editor) return;
    const dispatchState = () => {
      window.dispatchEvent(
        new CustomEvent('nc:note-undo-state', {
          detail: {
            path: initialNote.path,
            canUndo: editor.can().undo(),
            canRedo: editor.can().redo(),
          },
        }),
      );
    };
    // Initial state, so the panel knows where it stands before the
    // first transaction fires.
    dispatchState();
    editor.on('transaction', dispatchState);
    return () => {
      editor.off('transaction', dispatchState);
    };
  }, [editor, initialNote.path]);

  useEffect(() => {
    if (!editor) return;
    function onUndoRequest(e: Event) {
      const ce = e as CustomEvent<{ path: string }>;
      if (ce.detail?.path !== initialNote.path) return;
      editor!.commands.undo();
    }
    function onRedoRequest(e: Event) {
      const ce = e as CustomEvent<{ path: string }>;
      if (ce.detail?.path !== initialNote.path) return;
      editor!.commands.redo();
    }
    // "Revert to last save" handler: the panel has just POSTed to the
    // history/pop endpoint and got back a fresh NoteDto. It dispatches
    // this event so the open editor adopts the restored body.
    //
    // We deliberately let setContent go into TipTap's history stack
    // (i.e. don't suppress it) — so a user who clicks Revert by
    // mistake can press Ctrl+Z to bring back what they had. The body
    // we set is the body the server now has, so we also pre-set
    // lastSavedMarkdownRef + etagRef + saveState to 'saved' to keep
    // the autosave from immediately re-saving the same content.
    function onReload(e: Event) {
      const ce = e as CustomEvent<{ path: string; body: string; etag: string }>;
      if (ce.detail?.path !== initialNote.path) return;
      // Same math pre-processing as the initial-content path —
      // setContent feeds tiptap-markdown's parser, which doesn't
      // know `$..$` so we rewrite to HTML placeholders first.
      // lastSavedMarkdownRef stays the RAW (un-rewritten) body so
      // the dirty-check against the serializer output stays clean.
      editor!.commands.setContent(
        preprocessMarkdownForMath(ce.detail.body),
        false,
      );
      lastSavedMarkdownRef.current = ce.detail.body;
      etagRef.current = ce.detail.etag;
      setSaveState({ kind: 'saved' });
    }
    window.addEventListener('nc:note-tiptap-undo', onUndoRequest);
    window.addEventListener('nc:note-tiptap-redo', onRedoRequest);
    window.addEventListener('nc:note-reload-body', onReload);
    return () => {
      window.removeEventListener('nc:note-tiptap-undo', onUndoRequest);
      window.removeEventListener('nc:note-tiptap-redo', onRedoRequest);
      window.removeEventListener('nc:note-reload-body', onReload);
    };
  }, [editor, initialNote.path]);

  // Ship 54: global note defaults. Resolution order at render time:
  //   per-note frontmatter → global default → CSS baseline.
  // Notes with explicit Width/Font/FontSize keep behaving exactly as
  // before; notes without those fields pick up whatever the user
  // set globally in the ⚙️ popover.
  const noteDefaults = useNoteDefaults();

  // Apply the current appearance as CSS custom properties on the
  // editor shell wrapper. The .nc-editor rule (in styles.css)
  // consumes them via var(...) with sensible fallbacks.
  //
  // Why CSS variables on a stable wrapper instead of inline styles
  // on editor.view.dom: ProseMirror replaces or rewrites the
  // contenteditable element on certain transactions (extension
  // re-init, content-type swaps, locked/unlocked toggles), which
  // silently drops inline styles set on view.dom. The shell <div>
  // is a stable React-managed node, so the CSS vars survive any
  // editor-side DOM churn. The .nc-editor rule re-reads them on
  // every render via var(), so visible width/font/size always
  // tracks the latest setting.
  const shellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    // Resolve through global defaults so notes without per-note
    // values pick up whatever's in localStorage. Empty strings
    // clear the inline value and fall back to the CSS baseline,
    // which is what we want for the "no per-note + no global" case.
    const resolved = resolveNoteAppearance(
      {
        font: appearance.font,
        fontSize: appearance.fontSize,
        width: appearance.width,
      },
      noteDefaults.defaults,
    );
    // setProperty with empty string removes the custom property,
    // letting the CSS fallback (700px / 15px / system stack) win.
    if (resolved.width) {
      shell.style.setProperty('--nc-note-width', resolved.width);
    } else {
      shell.style.removeProperty('--nc-note-width');
    }
    if (resolved.fontSize) {
      shell.style.setProperty('--nc-note-font-size', resolved.fontSize);
    } else {
      shell.style.removeProperty('--nc-note-font-size');
    }
    if (resolved.font) {
      shell.style.setProperty('--nc-note-font', resolved.font);
    } else {
      shell.style.removeProperty('--nc-note-font');
    }
  }, [
    appearance.font,
    appearance.fontSize,
    appearance.width,
    noteDefaults.defaults.fontStack,
    noteDefaults.defaults.fontSize,
    noteDefaults.defaults.width,
  ]);

  return (
    <div className="nc-editor-shell" ref={shellRef}>
      {/*
        Page area: holds the white "page" centered. The page itself
        (.nc-editor) is fixed at 700px wide. Background here is the
        normal app surface — the gradient lives outside the app
        frame, on the body, not inside the editor.

        The previous in-editor toolbar (save status + upload pills)
        is gone. The host page renders both next to the breadcrumb
        instead — see EditorPage.tsx.
      */}
      <div className="nc-editor-page-area">
        {/*
          Locked-mode link click handler.

          TipTap's Link extension is configured with openOnClick:false
          so that clicks in EDIT mode don't navigate away when the
          user is just trying to position their cursor inside a link
          to edit its text. That's the right call for editing.

          But for locked notes — read-only mode — a click on a link
          should open the URL like any normal `<a>`. The link's
          `target="_blank"` is already set via Link's HTMLAttributes
          (so middle-click and Ctrl-click work), but plain clicks are
          still blocked by TipTap's internal preventDefault. We
          override that here, but ONLY when the editor is locked.

          We listen on the page-area wrapper (above EditorContent)
          and scope the match to anchors INSIDE .ProseMirror so the
          floating toolbars below (BubbleMenu, TableToolbar) are
          unaffected. The handler runs in the React onClick phase,
          which fires AFTER ProseMirror's mousedown/click handlers
          but is still in time to call window.open ourselves.

          Per the user's request, locked-mode link clicks always
          open in a new tab regardless of modifier keys. The
          inline comment on the click handler explains why we
          can't usefully delegate to the browser's native
          ctrl/middle-click behaviour here — TipTap has already
          preventDefault'd by the time we run.
        */}
        <div
          onClick={(e) => {
            // Only intercept in locked mode. In edit mode, do
            // nothing — TipTap's openOnClick:false stays in charge.
            // editor.isEditable is true when the note is being
            // edited; false when locked. The null guard lets the
            // first render before the editor is ready short-circuit
            // safely.
            if (!editor) return;
            if (editor.isEditable) return;

            const target = e.target as HTMLElement | null;
            const anchor = target?.closest('.ProseMirror a') as HTMLAnchorElement | null;
            if (!anchor) return;
            const href = anchor.getAttribute('href');
            if (!href) return;

            // Only handle plain left-click. Middle-click triggers
            // a different event (`auxclick`, button === 1) which
            // we don't get here. Right-click opens the context menu
            // and we don't want to fight that.
            if (e.button !== 0) return;

            // We always open in a new tab in locked mode — that's
            // the user's intent for read-only notes. Modifier keys
            // would normally let the browser pick the destination,
            // but TipTap's prosemirror-view click handler has
            // already preventDefault'd the navigation by the time
            // we run, so the modifiers wouldn't take effect anyway.
            // window.open with noopener gives us the new tab
            // unconditionally and matches the user's request:
            // "always open in a new tab".
            e.preventDefault();
            window.open(href, '_blank', 'noopener,noreferrer');
          }}
        >
          <EditorContent editor={editor} />
        </div>
        {/*
          Floating toolbar that appears above the active table when
          the cursor is inside a cell. Hidden otherwise. Self-manages
          its position via the editor's selection events.
        */}
        <TableToolbar editor={editor} />
        {/*
          Selection-driven formatting toolbar (bold / italic / inline
          code / link). Appears whenever the user has selected at
          least 2 characters outside a code block; hidden otherwise.
          Independent of TableToolbar — both can be visible at once
          when text is selected inside a table cell.
        */}
        <BubbleMenu
          editor={editor}
          vaultId={vaultId}
          getNotePath={() => noteForUploadRef.current}
          showAppearanceControls
        />
      </div>
      {/*
        Ship 84: mobile-only properties section. Rendered AFTER the
        page area but still inside the editor shell so it scrolls
        with the note content — the user scrolls past the last line
        of their note to reach it. Desktop never renders this; the
        properties rail covers the same job there. Gated on isMobile
        so the JSX tree stays lean on desktop (no hidden DOM, no
        unnecessary network fetch from MobileNoteProperties' own
        refresh effect).
      */}
      {isMobile && (
        <MobileNoteProperties
          vaultId={vaultId}
          notePath={initialNote.path}
          initialNote={initialNote}
        />
      )}
      {/*
        Table insert dialog. Triggered by picking "Table" from the
        slash menu (which calls onTableInsertRequest, set in our
        SlashMenuExtension config above). The slash item already
        deleted the user's "/" + filter text before opening the
        dialog, so on confirm we just run insertTable at the current
        selection.

        Why mount at the editor-shell root rather than the page area:
        the dialog is a centered overlay (backdrop + card) and it
        shouldn't be clipped by the page's own overflow / max-width.
        Rendering at the shell root keeps it visually centered on
        the viewport.

        The dialog is fully unmounted when closed so its internal
        state (rows/cols/etc.) resets between invocations — desired
        UX, otherwise the dialog would remember the previous run's
        choices in surprising ways.
      */}
      {tableInsertDialogOpen && (
        <TableInsertDialog
          onCancel={() => {
            setTableInsertDialogOpen(false);
            // Re-focus the editor so the user can continue typing
            // immediately after cancelling. Without this, focus is
            // left on document.body (the dialog's own focus released
            // on unmount) and Backspace / arrow keys would do
            // nothing visible.
            editor?.commands.focus();
          }}
          onInsert={(opts: TableInsertOpts) => {
            setTableInsertDialogOpen(false);
            if (!editor) return;
            // Two-step: insertTable with rows/cols/header, then if
            // a custom rowHeight was chosen, patch the freshly-
            // inserted table's attributes via updateAttributes.
            //
            // We do this in two chains so the rowHeight patch happens
            // AFTER insertTable's own selection placement (which puts
            // the cursor inside the new table's first cell) — that
            // way updateAttributes finds the table via the selection.
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
