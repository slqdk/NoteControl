import { useCallback, useEffect, useState } from 'react';
import { Navigate, useOutletContext, useParams } from 'react-router-dom';

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
import { useIsMobile } from '../hooks/useIsMobile';
import { newId } from '../util/id';

/**
 * Per-vault startpage with free-floating blocks.
 *
 * Ship 78 update:
 *   - The in-canvas "+" button + add panel from Ship 74 is GONE.
 *     The user kept hitting it accidentally because it sat over
 *     content. The "Widgets+" dropdown lives in the topbar now.
 *   - StartpagePage listens for `nc:add-startpage-block` window
 *     events; when one fires, the right add-handler runs. Decouples
 *     topbar UI from this page's state — no shared context, no
 *     prop drilling, just a one-way event.
 *
 * Ship 74 baseline (still applies):
 *   - Page-level header is gone. The canvas IS the content.
 *   - Three block types: RSS feed, Task area, Links (Ship 74).
 *   - Each block has absolute pixel x/y/width/height stored in
 *     {vault}/.notesapp/startpage.json. No grid.
 *   - useDebouncedSave fires 500ms after the user stops changing
 *     things; per-block edits flow through onChange callbacks.
 *
 * Failure model:
 *   - Initial load failure → page-level error banner; user can't
 *     edit (we don't want to overwrite a config we didn't load).
 *   - Save failure → toast/banner; in-memory state still reflects
 *     the user's edits, and the next debounce tick retries.
 *   - Per-feed fetch failure is rendered inside the affected block
 *     by RssBlock; doesn't break sibling blocks.
 */
export function StartpagePage() {
  const { vaultId } = useParams<{ vaultId: string }>();
  // Pull the outlet context so the type check doesn't drift if the
  // layout shape changes; the value isn't used in render directly.
  useOutletContext<VaultLayoutContext>();

  // Ship 86: redirect mobile users away from the startpage. The
  // startpage is a desktop-first canvas (free-floating draggable
  // blocks); it has no working interaction model on touch and looks
  // visually broken in the narrow mobile shell. We send mobile
  // users to the vault's folder root instead — that's the layout
  // they'll actually use on a phone (tree strip + folder/note
  // editing).
  //
  // The hook MUST be called unconditionally here so its order is
  // stable across renders; the conditional Navigate happens at
  // render time below, after every other hook has also run.
  // Resizing back to desktop in the same tab won't auto-navigate
  // back to the startpage — the user simply re-clicks the
  // startpage row in the tree (or reloads the page that brought
  // them in via Ship 47's vault-list link).
  const isMobile = useIsMobile();

  const [config, setConfig] = useState<StartpageConfigDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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
  }, []);

  // ----- Link blocks -----

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
  }, []);

  // ------------------------------------------------- topbar event bridge
  // Ship 78: TopBar's Widgets+ dropdown dispatches this event. We
  // listen and route to the right add-handler. Window event keeps
  // TopBar/StartpagePage decoupled (no shared context, no prop
  // drilling). Only one event name, three kinds.
  useEffect(() => {
    function onAdd(e: Event) {
      const detail = (e as CustomEvent<{ kind: string }>).detail;
      switch (detail?.kind) {
        case 'rss':
          addBlock();
          break;
        case 'task':
          addTaskArea();
          break;
        case 'links':
          addLinkBlock();
          break;
        default:
          // Unknown kind — ignore. Defensive in case a future
          // topbar version emits something we don't recognise.
          break;
      }
    }
    window.addEventListener('nc:add-startpage-block', onAdd);
    return () => window.removeEventListener('nc:add-startpage-block', onAdd);
  }, [addBlock, addTaskArea, addLinkBlock]);

  if (!vaultId) return null;

  // Ship 86: render-time redirect on mobile. Placed AFTER every
  // hook call so the hook order stays consistent (Rules of Hooks).
  // Side effect: a mobile render does fire the initial GET in the
  // load effect above before this Navigate unmounts the page —
  // wasted round-trip but harmless (the cancelled flag prevents
  // setState calls into an unmounted component). If this becomes
  // hot, lift the redirect into a route-level guard.
  if (isMobile) {
    return <Navigate to={`/vaults/${vaultId}`} replace />;
  }

  // Empty-state detection: nothing of any type exists yet.
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
        <div className="nc-startpage-canvas">
          {isEmpty && (
            <div className="nc-empty nc-startpage-empty">
              <p>Nothing here yet.</p>
              <p>
                Click <strong>Widgets+</strong> in the topbar to add a feed
                reader, task area, or link list.
              </p>
            </div>
          )}

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
