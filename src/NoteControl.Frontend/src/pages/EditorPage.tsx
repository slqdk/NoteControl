import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';

import { ApiError, notesApi, noteWidgetsApi } from '../api/client';
import type {
  ArchivedRelease,
  NoteDto,
  NoteWidgetDto,
  NoteWidgetsConfigDto,
} from '../api/types';
import {
  NoteEditor,
  type EditorUpload,
  type SaveNowOutcome,
} from '../components/NoteEditor';
import { MarkdownSourceView } from '../components/MarkdownSourceView';
import { NoteWidgetStack } from '../components/NoteWidgetStack';
import { SaveStatusIndicator, type SaveState } from '../components/SaveStatusIndicator';
import { SaveFailedDialog } from '../components/SaveFailedDialog';
import {
  registerNavigationGuard,
  requestNavigation,
  type NavigationGuardVerdict,
} from '../hooks/navigationGuard';
import { useDebouncedSave } from '../hooks/useDebouncedSave';
import {
  NOTE_WIDGET_ADD_EVENT,
  buildNoteWidget,
  type NoteWidgetAddDetail,
} from '../util/noteWidgets';
import type { VaultLayoutContext } from '../components/VaultLayout';

/**
 * Note editor page.
 *
 *   /vaults/:vaultId/note?path=...
 *
 * Layout-route note: this page used to wrap itself in <VaultLayout>.
 * After the layout-route refactor, the surrounding shell is mounted
 * once by the parent route and we render only the inner content
 * here. Vault metadata for the breadcrumb is shared via outlet
 * context so the layout's single fetch suffices.
 *
 * Navigation guard: while this page is mounted, it registers a
 * guard with the navigationGuard registry. Components that handle
 * navigation away (currently TreeView's row click handlers, plus
 * the breadcrumb's "back to vault" link) consult that guard before
 * actually navigating. If the editor is dirty, the guard tries to
 * save; if the save fails, it shows the SaveFailedDialog and asks
 * the user to choose stay-and-retry vs discard-and-leave.
 *
 * Browser back/forward buttons and tab close are NOT covered by
 * this guard - they fall through to the existing beforeunload
 * handler in NoteEditor (which prompts the browser's generic
 * "Leave site?" dialog when there are unsaved changes).
 *
 * View mode: the page can render one of three surfaces — the live
 * TipTap editor ('rendered'), a read-only markdown source viewer
 * ('source'), or a read-only archive viewer that mounts the live
 * editor in forceReadOnly mode against a synthesized NoteDto built
 * from one of the note's archived released versions ('archive').
 *
 * 'rendered' ↔ 'source' is driven by the properties panel via
 * nc:note-view-mode-changed. 'archive' is entered when the panel
 * dispatches nc:note-open-archived-release with a version pair; we
 * fetch the archive content and swap. The user exits via the "Back
 * to live" button in the banner, or by navigating to a different
 * note (the load effect resets us to 'rendered').
 *
 * Whenever the URL note path changes the view mode resets to
 * 'rendered' and viewingArchive clears — opening a different note
 * always lands in the rendered editor. When swapping into source
 * mode we first flush any pending save (so the source we display is
 * what's on disk) and refetch the note (so freshly-saved body is
 * what gets shown). If the flush fails or the refetch fails, we
 * still swap but log a warning — the existing save-state badge
 * surfaces the real failure to the user.
 */
type ViewMode = 'rendered' | 'source' | 'archive';

export function EditorPage() {
  const { vaultId } = useParams<{ vaultId: string }>();
  const [searchParams] = useSearchParams();
  const notePath = searchParams.get('path') ?? '';
  const { vault, canEdit } = useOutletContext<VaultLayoutContext>();
  const navigate = useNavigate();

  const [note, setNote] = useState<NoteDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // The current rendering mode of the editor surface. Starts in
  // 'rendered' for every note, including this initial mount —
  // see also the load effect below where we reset it on note
  // change. The properties panel mirrors this state locally and
  // also resets per selection; we don't try to keep them in lock-
  // step beyond "both reset on note change" because the only
  // cross-component signal that matters is the user clicking the
  // toggle (which fires the event we listen for here).
  const [viewMode, setViewMode] = useState<ViewMode>('rendered');

  // The archived release currently being viewed, or null when not in
  // archive mode. Holds the full body + frontmatter + savedAt for the
  // archived version. We mount NoteEditor against a synthesized
  // NoteDto built from this (forceReadOnly true) so all editor
  // chrome — TipTap rendering, math, code blocks, links — works
  // exactly as on the live note. The synthesized note's etag is a
  // sentinel ("archive"); the editor never PUTs in forceReadOnly so
  // the value is unused, but having it non-empty keeps the existing
  // editor invariants happy without a NoteDto type change.
  const [viewingArchive, setViewingArchive] = useState<ArchivedRelease | null>(null);

  // Save status + uploads live here so the breadcrumb row can show
  // them. NoteEditor reports them via callbacks; we don't try to
  // re-derive anything from inside the editor.
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [uploads, setUploads] = useState<EditorUpload[]>([]);
  // The editor hands a stable saveNow() up here so the breadcrumb's
  // SaveStatusIndicator can offer a manual Retry button AND the
  // navigation guard can call saveNow before letting a click-away
  // through. Lives in a ref because it changes per editor mount
  // and we don't want re-renders just because the function
  // identity shifted.
  const saveNowRef = useRef<(() => Promise<SaveNowOutcome>) | null>(null);

  // Save-failed dialog state. When the navigation guard catches a
  // failed click-away save, it sets these and then awaits the
  // user's choice via the resolver ref. The resolver lives outside
  // React state because it's a one-shot callback the dialog wires
  // back into the guard's promise.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogReason, setDialogReason] = useState<string>('');
  const dialogResolverRef = useRef<((v: NavigationGuardVerdict) => void) | null>(null);

  // Tracks the latest saveState in a ref so the guard callback
  // (which is created once via useCallback below and registered
  // for the lifetime of the page) can read the CURRENT state
  // without being re-created on every state change. Re-creating
  // the guard would mean re-registering it constantly, which is
  // fine in principle but noisy.
  const saveStateRef = useRef(saveState);
  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);

  // ----------------------------------------------------------------
  // Note widgets (the band above the editor).
  //
  // We load the WHOLE per-vault note-widgets map once per vault, keep
  // it in state, and debounce-save it back — same shape and cadence
  // the dashboard uses for its blocks. The map is keyed by note path;
  // this page only renders the open note's slice but holds the whole
  // map so add/edit/delete can write back without a read-modify-write
  // round trip per change.
  //
  // Why the whole map and not a per-note GET: the sidecar is one file
  // (note-widgets.json). A per-note endpoint would still have to load
  // and rewrite that one file, so the single-user assumption makes the
  // whole-map approach simpler and avoids cross-note write races.
  const [widgetsConfig, setWidgetsConfig] = useState<NoteWidgetsConfigDto | null>(null);

  // Load the map when the vault changes. Note changes don't refetch —
  // the map covers every note in the vault, so switching notes just
  // re-slices what we already have.
  useEffect(() => {
    if (!vaultId) return;
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await noteWidgetsApi.getConfig(vaultId);
        if (!cancelled) setWidgetsConfig(cfg);
      } catch {
        // Non-fatal: a vault with no widgets yet, or a transient
        // error. Fall back to an empty map so add still works (the
        // first save creates the file). We deliberately don't surface
        // this in the editor's save badge — widgets are auxiliary.
        if (!cancelled) setWidgetsConfig({ version: 1, byNote: {} });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  // Debounced save of the whole map, same 500ms cadence as the
  // startpage/assignments. First render (initial load) doesn't save —
  // the hook skips the first value it sees.
  useDebouncedSave(widgetsConfig, 500, (cfg) => {
    if (!vaultId || !cfg) return;
    void noteWidgetsApi.saveConfig(vaultId, cfg).catch(() => {
      // Swallow — widgets are auxiliary and the next edit retries.
      // A hard failure here shouldn't block note editing.
    });
  });

  // This note's widget slice. Empty array when the note has none.
  const noteWidgets: NoteWidgetDto[] =
    (notePath && widgetsConfig?.byNote[notePath]) || [];

  // Replace this note's widget list inside the map immutably.
  const setNoteWidgets = useCallback(
    (next: NoteWidgetDto[]) => {
      if (!notePath) return;
      setWidgetsConfig((prev) => {
        const base: NoteWidgetsConfigDto = prev ?? { version: 1, byNote: {} };
        const byNote = { ...base.byNote };
        if (next.length === 0) {
          delete byNote[notePath];
        } else {
          byNote[notePath] = next;
        }
        return { ...base, byNote };
      });
    },
    [notePath],
  );

  const updateNoteWidget = useCallback(
    (widgetId: string, patch: Partial<NoteWidgetDto>) => {
      const current = (notePath && widgetsConfig?.byNote[notePath]) || [];
      const next = current.map((w) => {
        if (w.id !== widgetId) return w;
        // Merge the payload field that the patch carries. The stack
        // sends a full replacement payload for the active kind, so a
        // shallow spread of the patch onto the widget is correct —
        // patch.rss / patch.task / etc. fully replace the field.
        return { ...w, ...patch };
      });
      setNoteWidgets(next);
    },
    [notePath, widgetsConfig, setNoteWidgets],
  );

  const deleteNoteWidget = useCallback(
    (widgetId: string) => {
      const current = (notePath && widgetsConfig?.byNote[notePath]) || [];
      setNoteWidgets(current.filter((w) => w.id !== widgetId));
    },
    [notePath, widgetsConfig, setNoteWidgets],
  );

  // Listen for the Properties panel's "Add Note Widget" event. Ignore
  // events whose notePath doesn't match the open note (a stale panel
  // selection mustn't drop a widget on the wrong note).
  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<NoteWidgetAddDetail>).detail;
      if (!detail || detail.notePath !== notePath) return;
      const widget = buildNoteWidget(detail);
      const current = (notePath && widgetsConfig?.byNote[notePath]) || [];
      setNoteWidgets([...current, widget]);
    };
    window.addEventListener(NOTE_WIDGET_ADD_EVENT, onAdd);
    return () => window.removeEventListener(NOTE_WIDGET_ADD_EVENT, onAdd);
  }, [notePath, widgetsConfig, setNoteWidgets]);

  /**
   * The navigation guard. Returns:
   *   'allow' - safe to navigate (editor is clean, or save just
   *             succeeded, or user picked Discard)
   *   'block' - DON'T navigate; the dialog is up and the user is
   *             interacting with it (or picked Stay)
   */
  const navigationGuardCallback = useCallback(async (): Promise<NavigationGuardVerdict> => {
    const saveNow = saveNowRef.current;
    const state = saveStateRef.current;

    // Editor isn't mounted, or the note is in a state that doesn't
    // need a save (idle / saved). Allow immediately.
    if (!saveNow) return 'allow';
    if (state.kind === 'idle' || state.kind === 'saved') return 'allow';

    // Conflict state is unrecoverable without a reload. The user
    // already saw the loud red chip + toast; the dialog would just
    // ask them to retry something that won't work. Show the dialog
    // anyway so they have a deliberate choice between staying
    // (and reloading the note) or walking away.
    if (state.kind === 'conflict') {
      return await openDialog(state.message);
    }

    // dirty / saving / error: try a save and see what happens.
    let outcome: SaveNowOutcome;
    try {
      outcome = await saveNow();
    } catch {
      // saveNow shouldn't throw - performSave catches its own
      // errors - but defend against future bugs by treating an
      // unexpected throw the same as 'failed'.
      outcome = 'failed';
    }

    if (outcome === 'ok') return 'allow';

    const reason =
      outcome === 'conflict'
        ? 'The note was changed by someone else (or another device) since you opened it. ' +
          'Reload to see the latest version.'
        : pickFailureReason(saveStateRef.current);
    return await openDialog(reason);

    function openDialog(message: string): Promise<NavigationGuardVerdict> {
      return new Promise<NavigationGuardVerdict>((resolve) => {
        dialogResolverRef.current = resolve;
        setDialogReason(message);
        setDialogOpen(true);
      });
    }

    function pickFailureReason(s: SaveState): string {
      if (s.kind === 'error' || s.kind === 'conflict') return s.message;
      return 'Save failed.';
    }
  }, []);

  // Register the guard for the lifetime of this page.
  useEffect(() => {
    return registerNavigationGuard(navigationGuardCallback);
  }, [navigationGuardCallback]);

  function onDialogStay() {
    setDialogOpen(false);
    const resolve = dialogResolverRef.current;
    dialogResolverRef.current = null;
    resolve?.('block');
  }

  function onDialogDiscard() {
    setDialogOpen(false);
    const resolve = dialogResolverRef.current;
    dialogResolverRef.current = null;
    resolve?.('allow');
  }

  useEffect(() => {
    if (!vaultId || !notePath) return;
    let cancelled = false;
    setError(null);
    setNotFound(false);
    setNote(null);
    // Reset transient editor reporting when the note changes —
    // otherwise a "Saved" from the previous note flickers briefly
    // on the next breadcrumb.
    setSaveState({ kind: 'idle' });
    setUploads([]);
    // Always start a freshly-loaded note in rendered mode. This
    // is the "toggle back when the note loads" behaviour the user
    // asked for: the source view never persists across notes. The
    // archive viewer also clears: opening a different note can't
    // leave us staring at an unrelated note's archive.
    setViewMode('rendered');
    setViewingArchive(null);
    // Drop the saveNow handle from the previous editor mount so a
    // stray Retry click on a stale error chip can't fire a save
    // against the new note's editor (it'll just no-op until the
    // new editor reports its own saveNow).
    saveNowRef.current = null;
    (async () => {
      try {
        const n = await notesApi.get(vaultId, notePath);
        if (cancelled) return;
        if (n === null) {
          setNotFound(true);
        } else {
          setNote(n);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : 'Could not load note.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId, notePath]);

  // Listen for view-mode toggle requests from the properties panel.
  // The panel is the single source of intent — we just react.
  // Behaviours:
  //   - Ignore events for other notes (multi-tab safety, also
  //     handles the brief window where the URL has changed but
  //     the panel's old selection is still firing).
  //   - On 'source', flush any pending save and refetch the note
  //     so the source we render reflects what's actually on disk.
  //     This matters because the autosave debounce means the body
  //     in `note.body` could be up to 800ms behind the editor's
  //     contenteditable. If the flush or refetch fails we still
  //     swap (showing the slightly-stale body) — the existing save
  //     badge already tells the user what's wrong.
  //   - On 'rendered' the editor remounts fresh and re-reads
  //     `note.body` as its initial content; no extra work needed.
  useEffect(() => {
    if (!vaultId || !notePath) return;

    let cancelled = false;

    async function onChange(e: Event) {
      const ce = e as CustomEvent<{ path: string; mode: ViewMode }>;
      if (!ce.detail || ce.detail.path !== notePath) return;
      const next = ce.detail.mode;

      if (next === 'source') {
        // Flush + refetch so the source view shows what's on disk.
        // saveNow's outcome is 'ok' / 'failed' / 'conflict'; we
        // treat anything non-ok the same: log, fall through, swap.
        const saveNow = saveNowRef.current;
        if (saveNow) {
          try {
            await saveNow();
          } catch {
            // Swallow: the editor's own error reporting handles
            // surfacing this to the user. We just want the latest
            // body if we can get it.
          }
        }
        try {
          const fresh = await notesApi.get(vaultId!, notePath);
          if (cancelled) return;
          if (fresh) setNote(fresh);
        } catch {
          // Refetch failed — fall back to the existing in-memory
          // body. The user will see at most an autosave-debounce
          // worth of staleness (~800ms).
        }
        if (!cancelled) {
          setViewingArchive(null);
          setViewMode('source');
        }
      } else {
        if (!cancelled) {
          setViewingArchive(null);
          setViewMode('rendered');
        }
      }
    }

    // We have to wrap in a synchronous function because the event
    // listener API doesn't await the handler. The async work above
    // runs detached; cancelled guard prevents stale state writes.
    function onChangeSync(e: Event) {
      void onChange(e);
    }

    window.addEventListener('nc:note-view-mode-changed', onChangeSync);
    return () => {
      cancelled = true;
      window.removeEventListener('nc:note-view-mode-changed', onChangeSync);
    };
  }, [vaultId, notePath]);

  // Listen for "open archived release" requests from the properties
  // panel. The panel emits with { path, versionMajor, versionMinor };
  // we filter by note path, fetch the archive content, and switch to
  // 'archive' view mode. Errors set the page-level error banner —
  // a missing archive (404) is rare in practice but possible if the
  // archive was deleted between the panel listing the entry and the
  // user clicking it; surfacing it lets the user click another entry
  // rather than silently doing nothing.
  useEffect(() => {
    if (!vaultId || !notePath) return;

    let cancelled = false;

    async function onOpen(e: Event) {
      const ce = e as CustomEvent<{
        path: string;
        versionMajor: number;
        versionMinor: number;
      }>;
      if (!ce.detail || ce.detail.path !== notePath) return;
      // Flush any pending save on the live editor before swapping
      // the surface — otherwise the archive viewer would mount, the
      // live editor would unmount, and an in-flight autosave timer
      // would silently drop. Same idea as the source-view flush.
      const saveNow = saveNowRef.current;
      if (saveNow) {
        try {
          await saveNow();
        } catch {
          // Editor surfaces its own error; we just want to land
          // in archive mode with the on-disk state as the next
          // "Back to live" target.
        }
      }
      // Refetch the live note so EditorPage's `note` state reflects
      // the post-flush on-disk body. The live editor maintains its
      // own lastSavedMarkdownRef / etagRef internally and never
      // pushes those back to `note`, so without this, `note.body`
      // is whatever the last load-effect GET returned — typically
      // stale by every autosave the user has done since opening the
      // surface. When the user clicks "Back to live" later, the
      // live editor will remount with `initialNote={note}`; if
      // `note.body` is stale, the editor shows the old content
      // until the user navigates away and back. Refetching here
      // keeps that remount canonical. Best-effort — a failure
      // leaves the pre-bug behaviour in place, no worse than
      // before.
      try {
        const fresh = await notesApi.get(vaultId!, ce.detail.path);
        if (cancelled) return;
        if (fresh !== null) setNote(fresh);
      } catch {
        // Best-effort.
      }
      try {
        const archive = await notesApi.getReleaseContent(
          vaultId!,
          ce.detail.path,
          ce.detail.versionMajor,
          ce.detail.versionMinor,
        );
        if (cancelled) return;
        setViewingArchive(archive);
        setViewMode('archive');
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.message
              : 'Could not load archived release.',
          );
        }
      }
    }

    function onOpenSync(e: Event) {
      void onOpen(e);
    }

    window.addEventListener('nc:note-open-archived-release', onOpenSync);
    return () => {
      cancelled = true;
      window.removeEventListener('nc:note-open-archived-release', onOpenSync);
    };
  }, [vaultId, notePath]);

  // Broadcast which archived release (if any) is currently being
  // viewed. The Properties panel + mobile properties listen so they
  // can mark the matching entry in the "Previous releases" list as
  // active (filled background). Detail is null when not in archive
  // mode so listeners can clear their highlight on exit. Fires on
  // entering archive mode, on switching between archives, on
  // "Back to live", and on note-path navigation (which clears
  // viewingArchive in its own effect).
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('nc:note-archive-view-changed', {
        detail:
          notePath && viewingArchive
            ? {
                path: notePath,
                versionMajor: viewingArchive.versionMajor,
                versionMinor: viewingArchive.versionMinor,
              }
            : null,
      }),
    );
  }, [notePath, viewingArchive]);

  /**
   * Delete the archive currently being viewed. Wired into the
   * banner's Delete button (only rendered when viewingArchive is
   * non-null, so the closure capture is always defined). Confirms
   * because the operation is irreversible — once a frozen
   * v{maj}.{min}.md file is removed it's gone for good (the live
   * note's body / frontmatter are not touched).
   *
   * After a successful delete we:
   *   1. Exit archive mode (clear viewingArchive + flip to rendered).
   *   2. Dispatch nc:note-archive-deleted so the panel + mobile
   *      properties refresh their archive lists without us having
   *      to lift their refresh-tick state up here.
   */
  async function deleteCurrentArchive() {
    if (!vaultId || !notePath || !viewingArchive) return;
    const label = `v${viewingArchive.versionMajor}.${viewingArchive.versionMinor}`;
    const ok = window.confirm(
      `Permanently delete the archived ${label} of this note?\n\n` +
        `This removes the frozen ${label} archive only — the live note's ` +
        `current content is untouched. The deletion cannot be undone.`,
    );
    if (!ok) return;
    try {
      await notesApi.deleteRelease(
        vaultId,
        notePath,
        viewingArchive.versionMajor,
        viewingArchive.versionMinor,
      );
      // Tell the properties surfaces to re-fetch their archive lists.
      window.dispatchEvent(
        new CustomEvent('nc:note-archive-deleted', {
          detail: {
            path: notePath,
            versionMajor: viewingArchive.versionMajor,
            versionMinor: viewingArchive.versionMinor,
          },
        }),
      );
      // Back to live. The view-state dispatcher above will also
      // fire (viewingArchive → null) so the active-row highlight
      // clears on the panel.
      setViewingArchive(null);
      setViewMode('rendered');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not delete archived release.',
      );
    }
  }

  if (!vaultId || !notePath) {
    return (
      <div className="nc-page">
        <p className="nc-empty">No note specified.</p>
      </div>
    );
  }

  return (
    <div className="nc-page nc-page-editor">
      {/*
        Breadcrumb row: path on the left, save status + in-flight
        upload pills on the right. This replaces the old in-editor
        toolbar that lived above the page. Putting it here keeps
        the editor surface free of chrome and gives the user a
        stable place to glance at "is my work saved?".
      */}
      <div className="nc-breadcrumb-row">
        <div className="nc-breadcrumb">
          {/*
            Guarded breadcrumb link. The default <Link> click would
            navigate immediately and bypass the guard - we have to
            preventDefault, consult the guard, and only call
            navigate() on 'allow'. This handles the case where the
            user clicks the vault name in the breadcrumb to go back
            to the folder view while a save is dirty/failing.
          */}
          <Link
            to={`/vaults/${vaultId}`}
            onClick={(e) => {
              // Honour modifier-click semantics (open in new tab,
              // etc.) - those bypass the SPA navigation entirely
              // and we don't need to guard them, since the current
              // tab stays put with the editor still mounted.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              void (async () => {
                const verdict = await requestNavigation();
                if (verdict === 'block') return;
                navigate(`/vaults/${vaultId}`);
              })();
            }}
          >
            {vault?.name ?? 'Vault'}
          </Link>
          <span className="nc-topbar-sep">/</span>
          <span>{notePath}</span>
          {/*
            Subtle indicator that the editor is in source mode. The
            toggle itself lives in the properties panel, but a user
            who has the panel hidden could otherwise be confused
            why their note suddenly looks like text. Render-only;
            no interaction.
          */}
          {viewMode === 'source' && (
            <span className="nc-source-mode-pill" title="Source view — read-only markdown">
              source
            </span>
          )}
          {viewMode === 'archive' && viewingArchive && (
            <span
              className="nc-source-mode-pill"
              title={`Archived v${viewingArchive.versionMajor}.${viewingArchive.versionMinor} — read-only`}
            >
              archive v{viewingArchive.versionMajor}.{viewingArchive.versionMinor}
            </span>
          )}
        </div>
        <div className="nc-breadcrumb-status">
          {uploads.length > 0 && (
            <div className="nc-editor-uploads">
              {uploads.map((u) => (
                <span
                  key={u.id}
                  className={
                    u.error
                      ? 'nc-editor-upload nc-editor-upload-error'
                      : 'nc-editor-upload'
                  }
                  title={u.error ? u.error : `Uploading ${u.info.fileName}…`}
                >
                  {u.error ? '⚠' : '⬆'} {u.info.fileName}
                </span>
              ))}
            </div>
          )}
          <SaveStatusIndicator
            state={saveState}
            onRetry={() => {
              void saveNowRef.current?.();
            }}
          />
        </div>
      </div>

      {error && <div className="nc-form-error">{error}</div>}

      {/*
        Note widgets. Rendered in the band above the note's top rule,
        for the open note only. Edits/deletes flow into the per-vault
        map and debounce-save. Only shown in rendered mode — the source
        view is a faithful markdown dump and widgets aren't part of the
        markdown (they live in the .notesapp sidecar), so showing them
        over raw source would be misleading.
      */}
      {note && vaultId && viewMode === 'rendered' && noteWidgets.length > 0 && (
        <NoteWidgetStack
          vaultId={vaultId}
          widgets={noteWidgets}
          onChange={updateNoteWidget}
          onDelete={deleteNoteWidget}
        />
      )}

      {notFound && (
        <div className="nc-empty">
          That note doesn&apos;t exist.{' '}
          <Link to={`/vaults/${vaultId}`}>Back to vault</Link>
        </div>
      )}

      {/*
        Surface swap. Rendered mode mounts the live TipTap editor;
        source mode mounts a read-only markdown viewer; archive mode
        mounts the editor again against a synthesized NoteDto built
        from the archived release (forceReadOnly true). We use the
        viewMode in the key for the editor so swapping back to
        rendered remounts it fresh — an editor that was just
        unmounted into source mode shouldn't carry stale handlers
        across the swap. The note path remains in the key as well
        so navigating to a different note also forces a remount,
        same as before. In archive mode the version pair joins the
        key so clicking a different archived entry remounts the
        editor with the new content.
      */}
      {note && viewMode === 'rendered' && (
        <NoteEditor
          key={`${note.path}::rendered`}
          vaultId={vaultId}
          initialNote={note}
          /* Viewer-role users get the editor in read-only mode even
             on development notes. NoteEditor ORs this with the
             state===released check so the locked-note path (TipTap
             editable: false + .nc-editor-locked styling + link
             click-through) handles both cases uniformly. */
          forceReadOnly={!canEdit}
          onSaveStateChange={setSaveState}
          onUploadsChange={setUploads}
          onSaveNowReady={(fn) => {
            saveNowRef.current = fn;
          }}
        />
      )}
      {note && viewMode === 'source' && (
        <MarkdownSourceView note={note} />
      )}
      {note && viewMode === 'archive' && viewingArchive && (
        <>
          {/*
            Archive viewer banner. Tells the user what they're
            looking at and gives them a clear way out. Sits above
            the editor surface, same place a save-error banner
            would sit. "Back to live" returns to rendered mode
            against the LIVE note (which we've kept in `note`
            state the whole time — the archive doesn't replace
            it).
          */}
          <div className="nc-archive-banner" role="status">
            <span className="nc-archive-banner-text">
              Viewing archived v{viewingArchive.versionMajor}
              .{viewingArchive.versionMinor} · saved{' '}
              {new Date(viewingArchive.savedAt).toLocaleString()}
            </span>
            <div className="nc-archive-banner-actions">
              <button
                type="button"
                className="nc-btn nc-archive-banner-back"
                onClick={() => {
                  setViewingArchive(null);
                  setViewMode('rendered');
                }}
                title="Return to the live editor"
              >
                ← Back to live
              </button>
              <button
                type="button"
                className="nc-btn nc-btn-danger nc-archive-banner-delete"
                onClick={() => void deleteCurrentArchive()}
                title={`Permanently delete the archived v${viewingArchive.versionMajor}.${viewingArchive.versionMinor} — the live note is not affected`}
              >
                🗑 Delete release v{viewingArchive.versionMajor}.{viewingArchive.versionMinor}
              </button>
            </div>
          </div>
          <NoteEditor
            /*
              Key includes the archive version so switching from one
              archived entry to another forces a remount. Without
              the version in the key, React would reuse the same
              NoteEditor instance and the new body wouldn't be
              picked up (NoteEditor reads initialNote.body only on
              mount).
            */
            key={`${note.path}::archive::${viewingArchive.versionMajor}.${viewingArchive.versionMinor}`}
            vaultId={vaultId}
            initialNote={{
              path: viewingArchive.path,
              body: viewingArchive.body,
              frontmatter: viewingArchive.frontmatter,
              // Sentinel etag. The editor never PUTs in
              // forceReadOnly mode, so this value is unused, but a
              // non-empty string keeps the NoteDto shape intact
              // without a type relaxation.
              etag: 'archive',
              lastModified: viewingArchive.savedAt,
            }}
            forceReadOnly={true}
            /*
              We don't wire save callbacks for the archive viewer.
              No save will fire (editable: false → no transactions
              → no body change → performSave returns 'ok' early
              without PUT-ing), so save state stays at whatever the
              live editor last reported. We also deliberately don't
              overwrite saveNowRef — leaving it pointing at the
              previously-unmounted live editor's saveNow is fine
              because we already flushed before swapping, and the
              live editor will re-register on the way back.
            */
          />
        </>
      )}

      {dialogOpen && (
        <SaveFailedDialog
          notePath={notePath}
          reason={dialogReason}
          onStay={onDialogStay}
          onDiscard={onDialogDiscard}
        />
      )}
    </div>
  );
}
