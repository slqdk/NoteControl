import { useCallback, useEffect, useMemo } from 'react';
import { Navigate, useOutletContext, useParams } from 'react-router-dom';

import type {
  DashboardDto,
  LinkBlockDto,
  RssBlockDto,
  TaskAreaDto,
} from '../api/types';
import { LinksBlock } from '../components/LinksBlock';
import { RssBlock } from '../components/RssBlock';
import { TaskArea } from '../components/TaskArea';
import type { VaultLayoutContext } from '../components/VaultLayout';
import { useIsMobile } from '../hooks/useIsMobile';
import { newId } from '../util/id';

/**
 * One dashboard's free-floating canvas.
 *
 * Multi-dashboard structure:
 *   - The route is /vaults/:vaultId/dashboards/:dashboardId. Legacy
 *     /vaults/:vaultId/startpage is a redirect (StartpagePage).
 *   - Data is owned by VaultLayout via useDashboards and reaches us
 *     through the outlet context. This page is a presenter: it
 *     locates the dashboard by id and renders its blocks. Mutations
 *     call ctx.patchDashboard, which threads back through the same
 *     useDashboards instance — so the dashboard rows in the tree and
 *     the canvas here stay in sync without a second fetch.
 *   - TopBar's Widgets+ dropdown still emits the
 *     nc:add-startpage-block window event; we listen and route to
 *     the right add-handler. Window event keeps top-bar UI decoupled
 *     from the page (no shared context for this, no prop drilling).
 *
 * Inherited block behaviour:
 *   - Three block types: RSS feed, Task area, Links.
 *   - Each block has absolute pixel x/y/width/height stored under
 *     its dashboard inside {vault}/.notesapp/startpage.json.
 *   - Save is debounced ~500ms inside useDashboards (one save per
 *     vault, holding the whole multi-dashboard config); per-block
 *     edits flow through onChange callbacks on each block component.
 *
 * Failure model:
 *   - VaultLayout's load failure is rendered by the layout itself
 *     (banner above the page) — we just show "loading…" until
 *     ctx.dashboards is non-null.
 *   - URL points at a dashboard id that's not in the config →
 *     render a small "dashboard not found" stub. Doesn't auto-
 *     redirect because the fix is for the user to pick a different
 *     row in the tree.
 *   - Per-feed fetch failure is rendered inside the affected block
 *     by RssBlock; doesn't break sibling blocks.
 *   - Mobile: redirected to /vaults/:vaultId — dashboards are a
 *     desktop-first canvas (drag/resize doesn't work on touch).
 */
export function DashboardPage() {
  const { vaultId, dashboardId } = useParams<{
    vaultId: string;
    dashboardId: string;
  }>();
  const ctx = useOutletContext<VaultLayoutContext>();

  // Mobile redirect: dashboards are a desktop-first canvas (free-
  // floating draggable blocks); they have no working interaction
  // model on touch and look visually broken in the narrow mobile
  // shell. The hook MUST be called unconditionally here so its
  // order is stable across renders; the conditional Navigate
  // happens at render time below.
  const isMobile = useIsMobile();

  // Locate the current dashboard. useMemo keeps the find() out of
  // every render's hot path.
  const current: DashboardDto | null = useMemo(() => {
    if (!ctx.dashboards || !dashboardId) return null;
    return ctx.dashboards.find((d) => d.id === dashboardId) ?? null;
  }, [ctx.dashboards, dashboardId]);

  // ------------------------------------------------- mutations
  //
  // All block-level mutations go through ctx.patchDashboard, which
  // re-creates the matching dashboard with the patch applied and
  // leaves siblings alone. Pulling this through the layout is what
  // lets the tree and canvas share state.
  const patchCurrent = useCallback(
    (patch: (d: DashboardDto) => DashboardDto) => {
      if (!dashboardId) return;
      ctx.patchDashboard(dashboardId, patch);
    },
    [ctx, dashboardId],
  );

  // ----- RSS blocks -----

  const updateBlock = useCallback(
    (id: string, patch: Partial<RssBlockDto>) => {
      patchCurrent((d) => ({
        ...d,
        blocks: d.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
      }));
    },
    [patchCurrent],
  );

  const deleteBlock = useCallback(
    (id: string) => {
      patchCurrent((d) => ({
        ...d,
        blocks: d.blocks.filter((b) => b.id !== id),
      }));
    },
    [patchCurrent],
  );

  const addBlock = useCallback(() => {
    patchCurrent((d) => {
      const newBlock: RssBlockDto = {
        id: newId(),
        title: '',
        feedUrl: '',
        x: 24 + (d.blocks.length % 5) * 32,
        y: 24 + (d.blocks.length % 5) * 32,
        width: 360,
        height: 320,
        headlineSize: 14,
        previewWords: 30,
        maxItems: 10,
      };
      return { ...d, blocks: [...d.blocks, newBlock] };
    });
  }, [patchCurrent]);

  // ----- Task areas -----

  const updateTaskArea = useCallback(
    (id: string, patch: Partial<TaskAreaDto>) => {
      patchCurrent((d) => ({
        ...d,
        taskAreas: d.taskAreas.map((a) =>
          a.id === id ? { ...a, ...patch } : a,
        ),
      }));
    },
    [patchCurrent],
  );

  const deleteTaskArea = useCallback(
    (id: string) => {
      patchCurrent((d) => ({
        ...d,
        taskAreas: d.taskAreas.filter((a) => a.id !== id),
      }));
    },
    [patchCurrent],
  );

  const addTaskArea = useCallback(() => {
    patchCurrent((d) => {
      const newArea: TaskAreaDto = {
        id: newId(),
        title: '',
        x: 224 + (d.taskAreas.length % 5) * 32,
        y: 24 + (d.taskAreas.length % 5) * 32,
        width: 320,
        height: 380,
        notes: [],
      };
      return { ...d, taskAreas: [...d.taskAreas, newArea] };
    });
  }, [patchCurrent]);

  // ----- Link blocks -----

  const updateLinkBlock = useCallback(
    (id: string, patch: Partial<LinkBlockDto>) => {
      patchCurrent((d) => ({
        ...d,
        links: d.links.map((l) => (l.id === id ? { ...l, ...patch } : l)),
      }));
    },
    [patchCurrent],
  );

  const deleteLinkBlock = useCallback(
    (id: string) => {
      patchCurrent((d) => ({
        ...d,
        links: d.links.filter((l) => l.id !== id),
      }));
    },
    [patchCurrent],
  );

  const addLinkBlock = useCallback(() => {
    patchCurrent((d) => {
      const newBlock: LinkBlockDto = {
        id: newId(),
        title: '',
        x: 424 + (d.links.length % 5) * 32,
        y: 24 + (d.links.length % 5) * 32,
        width: 300,
        height: 320,
        items: [],
      };
      return { ...d, links: [...d.links, newBlock] };
    });
  }, [patchCurrent]);

  // ------------------------------------------------- topbar event bridge
  // TopBar's Widgets+ dropdown dispatches this event; we listen and
  // route to the right add-handler. Window event keeps TopBar /
  // DashboardPage decoupled. Only one event name, three kinds.
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

  if (!vaultId || !dashboardId) return null;

  // Mobile guard. Same desktop-first reasoning as the legacy
  // startpage: dragging blocks doesn't work on touch, the canvas
  // doesn't fit a phone width. Send mobile users to the folder root.
  if (isMobile) {
    return <Navigate to={`/vaults/${vaultId}`} replace />;
  }

  // Empty-state detection: nothing of any type on THIS dashboard.
  const isEmpty =
    current !== null &&
    current.blocks.length === 0 &&
    current.taskAreas.length === 0 &&
    current.links.length === 0;

  return (
    <div className="nc-page nc-startpage">
      {ctx.dashboards === null ? (
        <p className="nc-empty">Loading…</p>
      ) : current === null ? (
        // The URL points at a dashboard id that's not in the config.
        // Most likely cause: the user deleted the dashboard in
        // another tab. Don't auto-redirect — let them pick the right
        // row in the tree. The tree shows what exists; the URL
        // doesn't.
        <p className="nc-empty">
          This dashboard no longer exists. Pick one from the tree on the left.
        </p>
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

          {current.blocks.map((block) => (
            <RssBlock
              key={block.id}
              vaultId={vaultId}
              block={block}
              onChange={(patch) => updateBlock(block.id, patch)}
              onDelete={() => deleteBlock(block.id)}
            />
          ))}
          {current.taskAreas.map((area) => (
            <TaskArea
              key={area.id}
              area={area}
              onChange={(patch) => updateTaskArea(area.id, patch)}
              onDelete={() => deleteTaskArea(area.id)}
            />
          ))}
          {current.links.map((linkBlock) => (
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
