import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';

import { ApiError, startpageApi } from '../api/client';
import type {
  LinkBlockDto,
  RssBlockDto,
  StartpageConfigDto,
  TaskAreaDto,
} from '../api/types';
import { LinksBlock } from '../components/LinksBlock';
import { RssBlock } from '../components/RssBlock';
import { TaskArea } from '../components/TaskArea';
import type { VaultLayoutContext } from '../components/VaultLayout';
import { useDebouncedSave } from '../hooks/useDebouncedSave';
import { newId } from '../util/id';

/**
 * Per-vault startpage with free-floating blocks.
 *
 * Ship 74 redesign:
 *   - Page-level header ("Startpage — VaultName" h1) removed. The
 *     canvas IS the content. No decoration, no chrome.
 *   - The two old "+ Add RSS" / "+ Add task area" buttons are
 *     replaced with a single "+" button anchored to the top-right
 *     of the canvas. Clicking it opens an inline add panel showing
 *     the three block types: RSS feed, Task area, Links.
 *   - New "Links" block type. Same drag/resize semantics as task
 *     areas; holds up to 10 link entries (title + optional
 *     description + URL), rendered as two-line stacked rows with a
 *     subtle hover background.
 *
 * Layout / save model unchanged from the previous shape:
 *   - Each block has absolute pixel x/y/width/height stored in
 *     {vault}/.notesapp/startpage.json. No grid.
 *   - useDebouncedSave fires 500ms after the user stops changing
 *     things; per-block edits flow through onChange callbacks.
 *
 * Failure model (unchanged):
 *   - Initial load failure → page-level error banner; user can't
 *     edit (we don't want to overwrite a config we didn't load).
 *   - Save failure → toast/banner; in-memory state still reflects
 *     the user's edits, and the next debounce tick retries.
 *   - Per-feed fetch failure is rendered inside the affected block
 *     by RssBlock; doesn't break sibling blocks.
 */
export function StartpagePage() {
  const { vaultId } = useParams<{ vaultId: string }>();
  // _vault is no longer used in render (no header to show its name)
  // but we still pull it from the outlet context so the type check
  // doesn't drift if the layout shape changes.
  useOutletContext<VaultLayoutContext>();

  const [config, setConfig] = useState<StartpageConfigDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [addPanelOpen, setAddPanelOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);

  // ------------------------------------------------- initial load
  useEffect(() => {
    if (!vaultId) return;
    let cancelled = false;
    setLoadError(null);
    setConfig(null);
    (async () => {
      try {
        const dto = await startpageApi.getConfig(vaultId);
        if (!cancelled) setConfig(dto);
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            e instanceof ApiError
              ? e.message
              : 'Could not load startpage configuration.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  // ------------------------------------------------- debounced save
  const doSave = useCallback(
    (cfg: StartpageConfigDto) => {
      if (!vaultId) return;
      void (async () => {
        try {
          await startpageApi.saveConfig(vaultId, cfg);
          setSaveError(null);
        } catch (e) {
          setSaveError(
            e instanceof ApiError
              ? e.message
              : 'Could not save startpage. Your changes are still in memory.',
          );
        }
      })();
    },
    [vaultId],
  );
  // Defaults shape includes the new `links` array, matching the
  // wire DTO. Server normalises null→[] so older config files load
  // cleanly and pick up the new field after the first save.
  useDebouncedSave(
    config ?? { blocks: [], taskAreas: [], links: [] },
    500,
    doSave,
  );

  // ------------------------------------------------- add-panel open/close
  // Click-outside / Escape close. Same pattern AccountMenu and the
  // RSS block menus use.
  useEffect(() => {
    if (!addPanelOpen) return;
    function onDocDown(e: MouseEvent) {
      if (addRef.current && !addRef.current.contains(e.target as Node)) {
        setAddPanelOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setAddPanelOpen(false);
    }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [addPanelOpen]);

  // ------------------------------------------------- mutations

  // ----- RSS blocks -----

  const updateBlock = useCallback(
    (id: string, patch: Partial<RssBlockDto>) => {
      setConfig((prev) => {
        if (!prev) return prev;
        const blocks = prev.blocks.map((b) =>
          b.id === id ? { ...b, ...patch } : b,
        );
        return { ...prev, blocks };
      });
    },
    [],
  );

  const deleteBlock = useCallback((id: string) => {
    setConfig((prev) =>
      prev ? { ...prev, blocks: prev.blocks.filter((b) => b.id !== id) } : prev,
    );
  }, []);

  const addBlock = useCallback(() => {
    setConfig((prev) => {
      if (!prev) return prev;
      const newBlock: RssBlockDto = {
        id: newId(),
        title: '',
        feedUrl: '',
        x: 24 + (prev.blocks.length % 5) * 32,
        y: 24 + (prev.blocks.length % 5) * 32,
        width: 360,
        height: 320,
        headlineSize: 14,
        previewWords: 30,
        maxItems: 10,
      };
      return { ...prev, blocks: [...prev.blocks, newBlock] };
    });
    setAddPanelOpen(false);
  }, []);

  // ----- Task areas -----

  const updateTaskArea = useCallback(
    (id: string, patch: Partial<TaskAreaDto>) => {
      setConfig((prev) => {
        if (!prev) return prev;
        const taskAreas = prev.taskAreas.map((a) =>
          a.id === id ? { ...a, ...patch } : a,
        );
        return { ...prev, taskAreas };
      });
    },
    [],
  );

  const deleteTaskArea = useCallback((id: string) => {
    setConfig((prev) =>
      prev
        ? { ...prev, taskAreas: prev.taskAreas.filter((a) => a.id !== id) }
        : prev,
    );
  }, []);

  const addTaskArea = useCallback(() => {
    setConfig((prev) => {
      if (!prev) return prev;
      const newArea: TaskAreaDto = {
        id: newId(),
        title: '',
        x: 224 + (prev.taskAreas.length % 5) * 32,
        y: 24 + (prev.taskAreas.length % 5) * 32,
        width: 320,
        height: 380,
        notes: [],
      };
      return { ...prev, taskAreas: [...prev.taskAreas, newArea] };
    });
    setAddPanelOpen(false);
  }, []);

  // ----- Link blocks (Ship 74) -----
  // Same shape as the task-area handlers; acts on the separate
  // `links` array. Cascade offset is 424px right of RSS blocks so
  // freshly-added links don't overlap freshly-added blocks of
  // other types.

  const updateLinkBlock = useCallback(
    (id: string, patch: Partial<LinkBlockDto>) => {
      setConfig((prev) => {
        if (!prev) return prev;
        const links = prev.links.map((l) =>
          l.id === id ? { ...l, ...patch } : l,
        );
        return { ...prev, links };
      });
    },
    [],
  );

  const deleteLinkBlock = useCallback((id: string) => {
    setConfig((prev) =>
      prev ? { ...prev, links: prev.links.filter((l) => l.id !== id) } : prev,
    );
  }, []);

  const addLinkBlock = useCallback(() => {
    setConfig((prev) => {
      if (!prev) return prev;
      const newBlock: LinkBlockDto = {
        id: newId(),
        title: '',
        x: 424 + (prev.links.length % 5) * 32,
        y: 24 + (prev.links.length % 5) * 32,
        width: 300,
        height: 320,
        items: [],
      };
      return { ...prev, links: [...prev.links, newBlock] };
    });
    setAddPanelOpen(false);
  }, []);

  if (!vaultId) return null;

  // Empty state detection: nothing of any type exists yet.
  const isEmpty =
    config !== null &&
    config.blocks.length === 0 &&
    config.taskAreas.length === 0 &&
    config.links.length === 0;

  return (
    <div className="nc-page nc-startpage">
      {saveError && (
        <div className="nc-form-error nc-startpage-save-error">{saveError}</div>
      )}

      {loadError ? (
        <div className="nc-form-error">{loadError}</div>
      ) : config === null ? (
        <p className="nc-empty">Loading…</p>
      ) : (
        /*
          Canvas hosts everything. Even when empty, we render the
          canvas so the floating + button has somewhere to anchor.
          The empty-state hint is overlaid; the canvas isn't
          padded around it because that would shift the + button.
        */
        <div className="nc-startpage-canvas">
          {isEmpty && (
            <div className="nc-empty nc-startpage-empty">
              <p>Nothing here yet.</p>
              <p>
                Click the <strong>+</strong> in the top-right corner to add a
                feed reader, task area, or link list.
              </p>
            </div>
          )}

          {/*
            Floating + button. Position: absolute top-right of the
            canvas. When clicked, expands an inline add panel with
            one button per block type. Single + is the user's
            chosen design; the panel is the simplest "menu"
            possible (three labelled buttons, no nesting).
          */}
          <div ref={addRef} className="nc-startpage-add-floating">
            <button
              type="button"
              className="nc-startpage-add-btn"
              onClick={() => setAddPanelOpen((v) => !v)}
              title="Add a block"
              aria-haspopup="menu"
              aria-expanded={addPanelOpen}
            >
              +
            </button>
            {addPanelOpen && (
              <div className="nc-startpage-add-panel" role="menu">
                <button
                  type="button"
                  className="nc-startpage-add-item"
                  role="menuitem"
                  onClick={addBlock}
                >
                  📡 RSS feed
                </button>
                <button
                  type="button"
                  className="nc-startpage-add-item"
                  role="menuitem"
                  onClick={addTaskArea}
                >
                  📌 Task area
                </button>
                <button
                  type="button"
                  className="nc-startpage-add-item"
                  role="menuitem"
                  onClick={addLinkBlock}
                >
                  🔗 Links
                </button>
              </div>
            )}
          </div>

          {config.blocks.map((block) => (
            <RssBlock
              key={block.id}
              vaultId={vaultId}
              block={block}
              onChange={(patch) => updateBlock(block.id, patch)}
              onDelete={() => deleteBlock(block.id)}
            />
          ))}
          {config.taskAreas.map((area) => (
            <TaskArea
              key={area.id}
              area={area}
              onChange={(patch) => updateTaskArea(area.id, patch)}
              onDelete={() => deleteTaskArea(area.id)}
            />
          ))}
          {config.links.map((linkBlock) => (
            <LinksBlock
              key={linkBlock.id}
              block={linkBlock}
              onChange={(patch) => updateLinkBlock(linkBlock.id, patch)}
              onDelete={() => deleteLinkBlock(linkBlock.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
