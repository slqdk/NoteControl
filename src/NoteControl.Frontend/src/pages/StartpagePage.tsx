import { useCallback, useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';

import { ApiError, startpageApi } from '../api/client';
import type { RssBlockDto, StartpageConfigDto, TaskAreaDto } from '../api/types';
import { RssBlock } from '../components/RssBlock';
import { TaskArea } from '../components/TaskArea';
import type { VaultLayoutContext } from '../components/VaultLayout';
import { useDebouncedSave } from '../hooks/useDebouncedSave';
import { newId } from '../util/id';

/**
 * Per-vault startpage with free-floating RSS blocks.
 *
 * Layout model:
 *   - Each block has absolute pixel x/y/width/height stored in
 *     {vault}/.notesapp/startpage.json. No grid.
 *   - The page area is `position: relative`; blocks are
 *     `position: absolute`. Blocks live inside an inner
 *     "canvas" div sized large enough to contain them — we let
 *     the canvas grow as you drag blocks beyond the current
 *     viewport, so dragging right or down expands the scrollable
 *     area rather than clipping.
 *   - The properties panel is auto-suppressed by VaultLayout
 *     while we're here (Ship 39 plumbing).
 *
 * Save model:
 *   - Initial config loaded once on mount. Empty-config new
 *     vaults render the empty state.
 *   - Every block edit (drag, resize, popup) updates a single
 *     `config` state object. useDebouncedSave PUTs to the server
 *     500ms after the user stops changing things.
 *   - There is intentionally no "Save" button. Live updates with
 *     debounced persistence give the smoothest feel.
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
  const { vault } = useOutletContext<VaultLayoutContext>();

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
  //
  // useDebouncedSave fires only when `config` actually changes
  // (it tracks JSON-stringified equality), and waits 500ms after
  // the last change. Save errors don't block further editing —
  // the user keeps working in memory and the next change will
  // retry. We surface the error inline so it doesn't go silent.
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
  // The hook handles "skip save on initial load" via its first-render
  // guard, so we can pass `config ?? <empty>` without spurious POSTs.
  useDebouncedSave(
    config ?? { blocks: [], taskAreas: [] },
    500,
    doSave,
  );

  // ------------------------------------------------- mutations

  /**
   * Update a single block in the config by id. Returns a new
   * config object so React re-renders. No-op if the id isn't
   * found (defensive — shouldn't happen given how RssBlock
   * receives its own id).
   */
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
        // Ship 51: was crypto.randomUUID() directly. That throws on
        // plain-HTTP LAN access (browsers gate randomUUID on secure
        // contexts only). newId() falls back to crypto.getRandomValues
        // when randomUUID isn't available — works on any protocol.
        id: newId(),
        title: '',
        feedUrl: '',
        // Cascade new blocks down-and-right so they don't all
        // pile on top of each other. Arithmetic by block count
        // is fine for small N (we expect <= 16 typically).
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

  // ----- Task areas (step 42) -----
  // Same shape as the block handlers above but acting on the
  // separate `taskAreas` array. Per the design lock, RSS blocks
  // and task areas are siblings on the page, persisted side by
  // side in startpage.json, but with no cross-references.

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
        // Same cascade pattern as RSS blocks, but offset 200px
        // to the right so freshly-added areas don't pile onto
        // freshly-added blocks at the same coords. The user can
        // drag from there.
        x: 224 + (prev.taskAreas.length % 5) * 32,
        y: 24 + (prev.taskAreas.length % 5) * 32,
        width: 320,
        height: 380,
        notes: [],
      };
      return { ...prev, taskAreas: [...prev.taskAreas, newArea] };
    });
  }, []);

  if (!vaultId) return null;

  return (
    <div className="nc-page nc-startpage">
      <div className="nc-startpage-header">
        <h1 className="nc-page-title">
          🏠 Startpage — {vault?.name ?? '…'}
        </h1>
        {config && (
          <span className="nc-startpage-add-actions">
            <button
              type="button"
              className="nc-btn"
              onClick={addBlock}
              title="Add a new RSS block"
            >
              + Add RSS block
            </button>
            <button
              type="button"
              className="nc-btn"
              onClick={addTaskArea}
              title="Add a new task area"
            >
              + Add task area
            </button>
          </span>
        )}
      </div>

      {saveError && (
        <div className="nc-form-error nc-startpage-save-error">
          {saveError}
        </div>
      )}

      {loadError ? (
        <div className="nc-form-error">{loadError}</div>
      ) : config === null ? (
        <p className="nc-empty">Loading…</p>
      ) : config.blocks.length === 0 && config.taskAreas.length === 0 ? (
        <div className="nc-empty nc-startpage-empty">
          <p>Nothing here yet.</p>
          <p>
            Click <strong>+ Add RSS block</strong> for a feed reader, or{' '}
            <strong>+ Add task area</strong> for a sticky-note board. Each
            item is positionable and resizable.
          </p>
        </div>
      ) : (
        /*
          Both arrays render inside the same canvas. Render order
          (and therefore z-order) is: RSS blocks first, then task
          areas. The two use disjoint id namespaces (UUIDs) so the
          React keys never collide. If we ever care about a unified
          z-order across the two, we'd merge into a single sorted
          array — for now the design choice is "rss reads, tasks
          act," which suggests tasks on top reads sensibly.
        */
        <div className="nc-startpage-canvas">
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
        </div>
      )}
    </div>
  );
}
