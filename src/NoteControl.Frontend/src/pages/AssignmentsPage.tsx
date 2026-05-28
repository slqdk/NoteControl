import type React from 'react';
import { useMemo, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';

import type { VaultLayoutContext } from '../components/VaultLayout';
import { useAssignments } from '../hooks/useAssignments';
import { useIsMobile } from '../hooks/useIsMobile';
import type { AssignmentCategory, AssignmentDto } from '../api/types';

/**
 * Per-vault Assignments page. Rendered inside VaultLayout's
 * <Outlet/> so the tree + topbar stay visible on the left.
 *
 * Three pinned category buckets, in this fixed order:
 *   1. Short Term (red)
 *   2. Long Term  (yellow)
 *   3. Development (blue)
 *
 * On desktop each bucket is a 2-column responsive grid of cards
 * (1 column on narrow desktop, 2 on wide — handled by CSS
 * grid-template-columns auto-fill). On mobile (viewport ≤ 768px)
 * every bucket collapses to a single-column stack and the whole
 * page is one long scrollable list.
 *
 * There's no "done" checkbox — the user asked for a delete-only
 * lifecycle. The pencil-edit interaction is inline: clicking a
 * card flips its subject + details to editable inputs; clicking
 * outside / pressing Esc commits + collapses.
 *
 * A persistent "+ Add assignment" button sits at the bottom of
 * the page. It opens an inline composer with all three category
 * options selectable as pills, plus subject + details inputs.
 *
 * Persistence: every change goes through useAssignments, which
 * debounces a full-config PUT 500ms after the last edit (same
 * cadence as the startpage config). The page itself is stateless
 * apart from "which row is being edited" + "is the composer open".
 */

// ----- category ordering + display -----

// Wire keys, in the pinned display order. The UI never sorts these
// at runtime — the order is the contract with the user.
const CATEGORY_ORDER: AssignmentCategory[] = ['short', 'long', 'dev'];

const CATEGORY_LABEL: Record<AssignmentCategory, string> = {
  short: 'Short Term',
  long: 'Long Term',
  dev: 'Development',
};

/**
 * Normalise an unknown stored category to one of the known
 * values. Hand-edits or DTOs from a future schema with extra
 * categories fall back to 'short' rather than vanishing from
 * the page entirely.
 */
function normaliseCategory(value: string): AssignmentCategory {
  if (value === 'short' || value === 'long' || value === 'dev') return value;
  return 'short';
}

// ============================================================ AssignmentsPage

export function AssignmentsPage() {
  const { vaultId } = useParams<{ vaultId: string }>();
  // Pull the outlet context so the type check stays honest if the
  // layout shape changes. We don't use any field directly today.
  useOutletContext<VaultLayoutContext>();

  const assignments = useAssignments(vaultId);
  const isMobile = useIsMobile();

  // Which row is currently in edit mode. Only one at a time —
  // a second edit-click commits the first via the input's blur
  // handler before swapping in.
  const [editingId, setEditingId] = useState<string | null>(null);

  // ----- drag-and-drop reordering state -----
  // The id of the card currently being dragged (null when no drag
  // is in flight). Native HTML5 DnD; only the grip handle is the
  // drag source, so click-to-edit on the card body is untouched.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // The id of the card the pointer is currently hovering over as a
  // drop-before target, or a `cat:<category>` sentinel when hovering
  // the empty tail of a bucket (drop = append to that bucket). Drives
  // the insertion-line / bucket-highlight affordance.
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Composer state. Lives at page level so opening / closing it
  // doesn't fight with React's input focus management.
  const [composerOpen, setComposerOpen] = useState(false);

  // Group the flat list into buckets keyed by category, preserving
  // the stored order within each bucket.
  const grouped = useMemo(() => {
    const out: Record<AssignmentCategory, AssignmentDto[]> = {
      short: [],
      long: [],
      dev: [],
    };
    if (!assignments.config) return out;
    for (const a of assignments.config.assignments) {
      out[normaliseCategory(a.category)].push(a);
    }
    return out;
  }, [assignments.config]);

  // ---------- early states ----------

  if (!vaultId) return null;

  if (assignments.loadError) {
    // Mirror VaultLayout's startpage save-error banner styling —
    // .nc-form-error is the existing red banner class. The layout
    // ALSO renders the dashboards loadError near here; the two
    // banners can stack if a vault has both failing, which is
    // fine (rare edge case + both errors are relevant).
    return (
      <div className="nc-page nc-assignments-page">
        <div className="nc-form-error">{assignments.loadError}</div>
      </div>
    );
  }

  if (!assignments.config) {
    // Same empty-shell pattern StartpagePage uses while waiting.
    return (
      <div className="nc-page nc-assignments-page">
        <p className="nc-empty">Loading…</p>
      </div>
    );
  }

  // ---------- drag-and-drop handlers ----------
  // Defined here (not per-card) so all cards share one set of stable
  // handlers and the page owns the drag/drop state. Mobile skips DnD
  // entirely — touch drag is fiddly and the page is a single scroll
  // column there; reordering on mobile is out of scope for now.

  function handleDragStart(id: string) {
    setDraggingId(id);
  }

  function handleDragEnd() {
    setDraggingId(null);
    setDropTarget(null);
  }

  // Drop BEFORE a specific card (same-bucket reorder, or cross-bucket
  // insert at a precise spot). beforeId is the hovered card's id.
  function handleDropBefore(beforeId: string, category: AssignmentCategory) {
    if (draggingId && draggingId !== beforeId) {
      assignments.moveAssignment(draggingId, category, beforeId);
    }
    handleDragEnd();
  }

  // Drop onto the bucket itself (empty space / tail) → append to the
  // end of that bucket. This is also the cross-bucket landing spot:
  // dropping Short→Long anywhere but on a specific Long card appends.
  function handleDropInBucket(category: AssignmentCategory) {
    if (draggingId) {
      assignments.moveAssignment(draggingId, category, null);
    }
    handleDragEnd();
  }

  // ---------- main render ----------

  return (
    <div
      className={[
        'nc-page',
        'nc-assignments-page',
        isMobile ? 'nc-assignments-page-mobile' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {assignments.saveError && (
        <div className="nc-form-error nc-assignments-save-error">
          {assignments.saveError}
        </div>
      )}

      <h1 className="nc-assignments-title">Assignments</h1>

      {CATEGORY_ORDER.map((cat) => (
        <AssignmentCategorySection
          key={cat}
          category={cat}
          items={grouped[cat]}
          editingId={editingId}
          // Drag-and-drop is desktop-only (see handlers above).
          dragEnabled={!isMobile}
          draggingId={draggingId}
          dropTarget={dropTarget}
          onSetDropTarget={setDropTarget}
          onDragStartCard={handleDragStart}
          onDragEndCard={handleDragEnd}
          onDropBefore={handleDropBefore}
          onDropInBucket={handleDropInBucket}
          onStartEdit={(id) => setEditingId(id)}
          onStopEdit={() => setEditingId(null)}
          onPatch={assignments.updateAssignment}
          onDelete={(id) => {
            // Confirm deletes so a stray click on the trash icon
            // doesn't silently nuke a detailed assignment. Matches
            // the TaskArea delete-area confirm pattern.
            // eslint-disable-next-line no-alert
            if (
              window.confirm('Delete this assignment? This cannot be undone.')
            ) {
              if (editingId === id) setEditingId(null);
              assignments.deleteAssignment(id);
            }
          }}
        />
      ))}

      {/*
        Composer / Add button. The button toggles the inline
        composer; the composer has its own internal state for
        the in-progress draft so users can cancel without
        polluting the saved list.
      */}
      <div className="nc-assignments-add-row">
        {composerOpen ? (
          <AssignmentComposer
            onCancel={() => setComposerOpen(false)}
            onCreate={(draft) => {
              assignments.addAssignment(draft);
              setComposerOpen(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="nc-btn nc-assignments-add-btn"
            onClick={() => setComposerOpen(true)}
          >
            + Add assignment
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================ Category section

interface AssignmentCategorySectionProps {
  category: AssignmentCategory;
  items: AssignmentDto[];
  editingId: string | null;
  dragEnabled: boolean;
  draggingId: string | null;
  dropTarget: string | null;
  onSetDropTarget: (target: string | null) => void;
  onDragStartCard: (id: string) => void;
  onDragEndCard: () => void;
  onDropBefore: (beforeId: string, category: AssignmentCategory) => void;
  onDropInBucket: (category: AssignmentCategory) => void;
  onStartEdit: (id: string) => void;
  onStopEdit: () => void;
  onPatch: (id: string, patch: Partial<Omit<AssignmentDto, 'id'>>) => void;
  onDelete: (id: string) => void;
}

function AssignmentCategorySection({
  category,
  items,
  editingId,
  dragEnabled,
  draggingId,
  dropTarget,
  onSetDropTarget,
  onDragStartCard,
  onDragEndCard,
  onDropBefore,
  onDropInBucket,
  onStartEdit,
  onStopEdit,
  onPatch,
  onDelete,
}: AssignmentCategorySectionProps) {
  // Sentinel target id for "append to this bucket's tail" — used to
  // highlight the bucket when the pointer is over empty space rather
  // than over a specific card.
  const bucketTarget = `cat:${category}`;
  const bucketActive = dragEnabled && dropTarget === bucketTarget;

  // Bucket-level drop: fires when the pointer is over the section but
  // NOT over a specific card (card handlers stopPropagation). Appends
  // the dragged card to the end of this bucket.
  const bucketDropProps = dragEnabled
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (!draggingId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          onSetDropTarget(bucketTarget);
        },
        onDrop: (e: React.DragEvent) => {
          if (!draggingId) return;
          e.preventDefault();
          onDropInBucket(category);
        },
      }
    : {};

  // Empty bucket: render the header anyway so the page structure
  // is consistent. The empty state is a tiny muted hint; we don't
  // collapse the whole section because that would visually hide
  // the category and the user's mental model is "three pinned
  // buckets, always there".
  return (
    <section
      className={[
        'nc-assignments-section',
        `nc-assignments-section-${category}`,
        bucketActive ? 'nc-assignments-section-drop-active' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-category={category}
      {...bucketDropProps}
    >
      <h2 className="nc-assignments-section-title">{CATEGORY_LABEL[category]}</h2>
      {items.length === 0 ? (
        <p className="nc-empty nc-assignments-empty">No assignments here yet.</p>
      ) : (
        <div className="nc-assignments-grid">
          {items.map((a) => (
            <AssignmentCard
              key={a.id}
              assignment={a}
              isEditing={editingId === a.id}
              dragEnabled={dragEnabled}
              isDragging={draggingId === a.id}
              isDropBefore={dragEnabled && dropTarget === a.id}
              onDragStart={() => onDragStartCard(a.id)}
              onDragEnd={onDragEndCard}
              onDragOverCard={() => {
                if (draggingId && draggingId !== a.id) {
                  onSetDropTarget(a.id);
                }
              }}
              onDropOnCard={() => onDropBefore(a.id, category)}
              onStartEdit={() => onStartEdit(a.id)}
              onStopEdit={onStopEdit}
              onPatch={(patch) => onPatch(a.id, patch)}
              onDelete={() => onDelete(a.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ============================================================ Card

interface AssignmentCardProps {
  assignment: AssignmentDto;
  isEditing: boolean;
  dragEnabled: boolean;
  isDragging: boolean;
  isDropBefore: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverCard: () => void;
  onDropOnCard: () => void;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onPatch: (patch: Partial<Omit<AssignmentDto, 'id'>>) => void;
  onDelete: () => void;
}

/**
 * One assignment row inside its category bucket. The category
 * color comes from the parent section's `data-category` (CSS
 * descendant selectors), not from a per-card class — that way
 * changing a card's category at edit time is one onPatch call
 * with no re-render of the surrounding section.
 */
function AssignmentCard({
  assignment,
  isEditing,
  dragEnabled,
  isDragging,
  isDropBefore,
  onDragStart,
  onDragEnd,
  onDragOverCard,
  onDropOnCard,
  onStartEdit,
  onStopEdit,
  onPatch,
  onDelete,
}: AssignmentCardProps) {
  const subject = assignment.subject.trim();
  const details = assignment.details.trim();

  // Drop-target wiring shared by both card states. A card is a drop
  // target whenever DnD is enabled; the grip is the only drag SOURCE
  // (so dragging never starts from the body and never collides with
  // click-to-edit). onDragOver must preventDefault to allow a drop.
  const cardDropProps = dragEnabled
    ? {
        onDragOver: (e: React.DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          onDragOverCard();
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          onDropOnCard();
        },
      }
    : {};

  // The grip is a tiny drag-only handle. draggable lives HERE, not on
  // the card, so the card body stays clickable for edit. dataTransfer
  // is set to a harmless payload so Firefox actually initiates a drag.
  const grip = dragEnabled ? (
    <button
      type="button"
      className="nc-assignments-card-grip"
      title="Drag to reorder or move between buckets"
      aria-label="Drag to reorder"
      data-no-edit="true"
      draggable
      onClick={(e) => e.stopPropagation()}
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', assignment.id);
        onDragStart();
      }}
      onDragEnd={(e) => {
        e.stopPropagation();
        onDragEnd();
      }}
    >
      ⠿
    </button>
  ) : null;

  if (!isEditing) {
    return (
      <div
        className={[
          'nc-assignments-card',
          isDragging ? 'nc-assignments-card-dragging' : '',
          isDropBefore ? 'nc-assignments-card-drop-before' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        {...cardDropProps}
        onClick={(e) => {
          // Ignore clicks on the action buttons / category select —
          // those have their own handlers. Without this guard, the
          // delete button's click would bubble and re-open edit mode
          // on the card the user just asked to delete.
          const t = e.target as HTMLElement;
          if (t.closest('button, select, [data-no-edit]')) return;
          onStartEdit();
        }}
        // Single-tap to edit on touch too; the click handler above
        // handles both. The role/tabIndex make it keyboard-reachable.
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onStartEdit();
          }
        }}
      >
        <div className="nc-assignments-card-body">
          <div className="nc-assignments-card-subject">
            {subject || (
              <span className="nc-assignments-card-placeholder">
                (no subject)
              </span>
            )}
          </div>
          {details && (
            <div className="nc-assignments-card-details">{details}</div>
          )}
        </div>
        {grip}
        <button
          type="button"
          className="nc-assignments-card-delete"
          title="Delete this assignment"
          aria-label="Delete this assignment"
          data-no-edit="true"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          🗑
        </button>
      </div>
    );
  }

  // -------- editing --------
  // The category select sits at the top of the editing form (the
  // user explicitly asked for category to be selectable at first
  // sight). Subject below it (single line), details below that
  // (textarea).
  return (
    <div
      className={[
        'nc-assignments-card',
        'nc-assignments-card-editing',
        isDropBefore ? 'nc-assignments-card-drop-before' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...cardDropProps}
    >
      <div className="nc-assignments-card-edit-fields">
        <label className="nc-assignments-edit-label">
          Category
          <select
            className="nc-assignments-edit-category"
            value={normaliseCategory(assignment.category)}
            onChange={(e) =>
              onPatch({ category: e.target.value as AssignmentCategory })
            }
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>

        <label className="nc-assignments-edit-label">
          Subject
          <input
            type="text"
            className="nc-assignments-edit-subject"
            value={assignment.subject}
            placeholder="Subject"
            autoFocus
            onChange={(e) => onPatch({ subject: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onStopEdit();
              }
            }}
          />
        </label>

        <label className="nc-assignments-edit-label">
          Details
          <textarea
            className="nc-assignments-edit-details"
            value={assignment.details}
            placeholder="Details (optional)"
            rows={3}
            onChange={(e) => onPatch({ details: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onStopEdit();
              }
            }}
          />
        </label>
      </div>

      <div className="nc-assignments-card-edit-actions">
        <button
          type="button"
          className="nc-btn"
          onClick={onStopEdit}
        >
          Done
        </button>
        <button
          type="button"
          className="nc-btn nc-btn-danger"
          onClick={onDelete}
        >
          🗑 Delete
        </button>
      </div>
    </div>
  );
}

// ============================================================ Composer

interface AssignmentComposerProps {
  onCancel: () => void;
  onCreate: (draft: Omit<AssignmentDto, 'id'>) => void;
}

/**
 * Inline composer rendered in place of the + Add button when
 * the user opens it. Keeps its own draft state so cancelling
 * doesn't litter the saved list. Defaults to category 'short'
 * because that's the top bucket the user lands on visually.
 */
function AssignmentComposer({ onCancel, onCreate }: AssignmentComposerProps) {
  const [category, setCategory] = useState<AssignmentCategory>('short');
  const [subject, setSubject] = useState('');
  const [details, setDetails] = useState('');

  const canSave = subject.trim().length > 0;

  function commit() {
    if (!canSave) return;
    onCreate({
      category,
      subject: subject.trim(),
      details: details.trim(),
    });
  }

  return (
    <div className="nc-assignments-composer">
      {/*
        Category pills first — the user asked for the three
        categories to be selectable "at first sight". Rendering
        them as a row of buttons makes the choice obvious and
        keeps the colour cues visible at compose time.
      */}
      <div
        className="nc-assignments-composer-pills"
        role="radiogroup"
        aria-label="Category"
      >
        {CATEGORY_ORDER.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={category === c}
            className={[
              'nc-assignments-pill',
              `nc-assignments-pill-${c}`,
              category === c ? 'nc-assignments-pill-active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => setCategory(c)}
          >
            {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      <input
        type="text"
        className="nc-assignments-composer-subject"
        value={subject}
        placeholder="Subject"
        autoFocus
        onChange={(e) => setSubject(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />

      <textarea
        className="nc-assignments-composer-details"
        value={details}
        placeholder="Details (optional)"
        rows={3}
        onChange={(e) => setDetails(e.target.value)}
        onKeyDown={(e) => {
          // Ctrl+Enter to save from textarea — plain Enter inserts
          // a newline (textareas always do that, which is the right
          // behaviour for a multi-line field).
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />

      <div className="nc-assignments-composer-actions">
        <button
          type="button"
          className="nc-btn"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="nc-btn nc-btn-primary"
          onClick={commit}
          disabled={!canSave}
          title={canSave ? undefined : 'Subject is required'}
        >
          Add
        </button>
      </div>
    </div>
  );
}
