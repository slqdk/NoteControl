import { useEffect, useRef, useState } from 'react';

import type { DashboardDto } from '../api/types';

/**
 * Renders the dashboards section at the top of the tree — one row
 * per dashboard plus a small "+" affordance to add a new one.
 *
 * Replaces the single synthetic "Startpage" row that used to live
 * here. Same rendering shape (plain divs, not TreeNode) for the
 * same reason: the dashboard rows live outside the folder/note
 * selection model, so reusing TreeNode would mean threading a
 * third selection kind through every selection-aware codepath.
 *
 * Identity / selection:
 *   - The active dashboard is the one whose id is in the URL
 *     (computed by VaultLayout from useParams + useLocation).
 *   - Clicking a row navigates; doesn't toggle expansion (the rows
 *     have no children).
 *   - Right-click opens a small context menu (Rename / Delete).
 *   - F2-style inline rename is started from the context menu;
 *     the row swaps to an editable input until Enter / Esc / blur.
 *
 * Mutations are NOT done here — this component is a presenter. It
 * gets handlers from VaultLayout (which owns the dashboards data
 * via useDashboards) and calls them. Doing the actual config
 * mutation up at the layout means the DashboardPage canvas sees
 * the same state the tree sees, with no second source of truth.
 */
export interface DashboardListProps {
  dashboards: DashboardDto[];
  activeDashboardId: string | null;
  /** Allow delete? False when there's only one dashboard left. */
  canDelete: boolean;

  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, newName: string) => void;
  onDelete: (id: string) => void;
}

export function DashboardList({
  dashboards,
  activeDashboardId,
  canDelete,
  onSelect,
  onAdd,
  onRename,
  onDelete,
}: DashboardListProps) {
  // Inline-rename state. Only one row is editable at a time;
  // null = no row is currently being renamed. The kebab/right-
  // click menu sets this; Enter/Esc/blur clear it.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Context-menu position + target. We use a small inline implementation
  // rather than the shared ContextMenu component because it would mean
  // round-tripping a synthetic TreeSelection through TreeView/VaultLayout —
  // dashboards aren't TreeSelections (different kind), and the menu has
  // only two items.
  const [menu, setMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);

  // Close the menu on outside click / Escape. pointerdown matches
  // the pattern used by AccountMenu / TopBar's Widgets+ dropdown
  // (iOS Safari + tap-then-scroll friendliness).
  useEffect(() => {
    if (!menu) return;
    function onDown() {
      setMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenu(null);
    }
    // Defer attaching the handler until the next frame — without
    // this, the same pointerdown that opened the menu would
    // immediately close it.
    const t = window.setTimeout(() => {
      document.addEventListener('pointerdown', onDown);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  return (
    <>
      {dashboards.map((d) =>
        renamingId === d.id ? (
          <DashboardRenameRow
            key={d.id}
            initialName={d.name}
            siblingNames={dashboards
              .filter((other) => other.id !== d.id)
              .map((other) => other.name)}
            onSubmit={(name) => {
              onRename(d.id, name);
              setRenamingId(null);
            }}
            onCancel={() => setRenamingId(null)}
          />
        ) : (
          <div
            key={d.id}
            className={[
              'nc-tree-row',
              'nc-tree-row-startpage',
              activeDashboardId === d.id ? 'nc-tree-row-selected' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="treeitem"
            aria-selected={activeDashboardId === d.id}
            tabIndex={activeDashboardId === d.id ? 0 : -1}
            onClick={() => onSelect(d.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ id: d.id, x: e.clientX, y: e.clientY });
            }}
            title={d.name || '(unnamed dashboard)'}
          >
            <span
              className="nc-tree-chevron nc-tree-chevron-empty"
              aria-hidden="true"
            />
            <span className="nc-tree-icon" aria-hidden="true">
              🏠
            </span>
            <span className="nc-tree-label">
              {d.name || <em>(unnamed)</em>}
            </span>
          </div>
        ),
      )}

      {/*
        "+ New dashboard" affordance. Sits below the list, before
        the regular folder rows. Same row shape as the dashboard
        rows themselves so the indent geometry matches; the icon
        is "+" and the label tells the user what it does. We
        don't use a proper <button> here because the row needs to
        match the tree's row layout (chevron cell + icon cell +
        label cell); a button would force a different baseline.
      */}
      <div
        className="nc-tree-row nc-tree-row-startpage nc-tree-row-add-dashboard"
        role="button"
        tabIndex={0}
        onClick={onAdd}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onAdd();
          }
        }}
        title="Add a new dashboard"
      >
        <span
          className="nc-tree-chevron nc-tree-chevron-empty"
          aria-hidden="true"
        />
        <span className="nc-tree-icon" aria-hidden="true">
          ＋
        </span>
        <span className="nc-tree-label">New dashboard</span>
      </div>

      {menu && (
        <div
          className="nc-context-menu"
          style={{
            // Same positioning approach as ContextMenu.tsx — fixed
            // to viewport coords from the right-click event.
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            zIndex: 1000,
          }}
          role="menu"
          // Stop the pointerdown from bubbling to the document handler,
          // which would otherwise close the menu before the click that
          // selects an item registers.
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="nc-context-item"
            role="menuitem"
            onClick={() => {
              setRenamingId(menu.id);
              setMenu(null);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            className="nc-context-item"
            role="menuitem"
            disabled={!canDelete}
            title={
              canDelete
                ? undefined
                : "Can't delete the only dashboard. Add another first."
            }
            onClick={() => {
              if (!canDelete) return;
              const target = dashboards.find((d) => d.id === menu.id);
              const label = target?.name || 'this dashboard';
              if (
                window.confirm(
                  `Delete dashboard "${label}"?\n\nWidgets on this dashboard will be removed. Other dashboards are unaffected.`,
                )
              ) {
                onDelete(menu.id);
              }
              setMenu(null);
            }}
          >
            Delete
          </button>
        </div>
      )}
    </>
  );
}

// ----------------------------------------------------------- inline rename

interface DashboardRenameRowProps {
  initialName: string;
  /** Names already in use by sibling dashboards; used for dup check. */
  siblingNames: string[];
  onSubmit: (newName: string) => void;
  onCancel: () => void;
}

/**
 * Inline editable row for renaming a dashboard. Visually mirrors a
 * dashboard row (same icon cell, same className) so the geometry
 * doesn't shift when entering/leaving rename mode. Validation is
 * intentionally light: empty rejected, whitespace-only rejected,
 * dups rejected — but the original name is allowed (so hitting
 * Enter without typing is a clean no-op cancel).
 *
 * We don't reuse RenameInputRow because it's tied to the folder/
 * note rename flow (different validation rules: rejects "/"
 * because that would mean "move folder", which is meaningless for
 * a dashboard).
 */
function DashboardRenameRow({
  initialName,
  siblingNames,
  onSubmit,
  onCancel,
}: DashboardRenameRowProps) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select-all on mount. Selecting all matches the
  // Win Explorer F2 rename behaviour (immediate replace if the
  // user just starts typing).
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  function validate(value: string): string | null {
    const trimmed = value.trim();
    if (trimmed.length === 0) return 'Name cannot be empty.';
    if (trimmed === initialName.trim()) return null; // unchanged is fine
    const lower = trimmed.toLowerCase();
    if (siblingNames.some((n) => n.trim().toLowerCase() === lower)) {
      return 'Another dashboard already has this name.';
    }
    return null;
  }

  function commit() {
    const trimmed = name.trim();
    const err = validate(name);
    if (err) {
      setError(err);
      return;
    }
    if (trimmed === initialName.trim()) {
      // No change. Treat as cancel — saves a write round-trip.
      onCancel();
      return;
    }
    onSubmit(trimmed);
  }

  return (
    <div
      className="nc-tree-row nc-tree-row-startpage nc-tree-renaming"
      // No onClick — this row is editable, not clickable. We swallow
      // pointerdown so the document-level "close menu / close popover"
      // handlers don't fire while the user is interacting with the
      // input field.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span
        className="nc-tree-chevron nc-tree-chevron-empty"
        aria-hidden="true"
      />
      <span className="nc-tree-icon" aria-hidden="true">
        🏠
      </span>
      <input
        ref={inputRef}
        className="nc-tree-newfolder-input"
        type="text"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        // Commit on blur too — clicking elsewhere is a natural
        // "I'm done" gesture. If validation fails we re-focus and
        // keep editing rather than silently dropping the change.
        onBlur={() => {
          const err = validate(name);
          if (err) {
            setError(err);
            // Re-focus so the user sees the error and can fix it.
            inputRef.current?.focus();
            return;
          }
          commit();
        }}
        title={error ?? undefined}
        aria-invalid={error !== null}
      />
    </div>
  );
}
