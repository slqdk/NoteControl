import type {
  LinkBlockDto,
  MotionBlockDto,
  MotorBlockDto,
  NoteWidgetDto,
  RssBlockDto,
  TaskAreaDto,
} from '../api/types';
import { newId } from './id';
import { MOTION_DEFAULTS } from '../components/MotionBlock';

/**
 * The cross-component contract for adding a widget to a note.
 *
 * The Properties panel and the EditorPage are mounted in different
 * branches of the tree (the panel lives in VaultLayout, the editor in
 * the routed page), so they coordinate through a window CustomEvent —
 * the same decoupling the view-mode toggle and the dashboard's
 * Widgets+ dropdown already use. The panel dispatches
 * NOTE_WIDGET_ADD_EVENT with this detail; EditorPage listens, checks
 * the notePath matches the open note, and appends a freshly-built
 * widget.
 */
export const NOTE_WIDGET_ADD_EVENT = 'nc:add-note-widget';

export type NoteWidgetKind = 'rss' | 'task' | 'links' | 'motion' | 'motor';

export interface NoteWidgetAddDetail {
  /**
   * The note the widget should attach to — the vault-relative path
   * exactly as it appears in the tree selection / NoteDto.path. The
   * editor ignores events whose path doesn't match the open note, so a
   * stale panel selection can't drop a widget on the wrong note.
   */
  notePath: string;
  kind: NoteWidgetKind;
  /**
   * Motion mode, only meaningful when kind === 'motion'. Mirrors the
   * dashboard's per-mode insert. Defaults to 'A' if absent.
   */
  motionMode?: MotionBlockDto['mode'];
}

/**
 * Build a new NoteWidgetDto for the given kind. Defaults mirror the
 * dashboard's add-handlers (DashboardPage) so a widget inserted into a
 * note starts life identically to one dropped on a dashboard — same
 * sizes, same empty payloads. x/y are 0 because the note stack ignores
 * absolute position (the NoteWidgetStack host positions the widget).
 */
export function buildNoteWidget(detail: NoteWidgetAddDetail): NoteWidgetDto {
  const id = newId();

  switch (detail.kind) {
    case 'rss': {
      const rss: RssBlockDto = {
        id: newId(),
        title: '',
        feedUrl: '',
        x: 0,
        y: 0,
        width: 360,
        height: 320,
        headlineSize: 14,
        previewWords: 30,
        maxItems: 10,
      };
      return { id, kind: 'rss', rss };
    }
    case 'task': {
      const task: TaskAreaDto = {
        id: newId(),
        title: '',
        x: 0,
        y: 0,
        width: 320,
        height: 380,
        notes: [],
      };
      return { id, kind: 'task', task };
    }
    case 'links': {
      const links: LinkBlockDto = {
        id: newId(),
        title: '',
        x: 0,
        y: 0,
        width: 300,
        height: 320,
        items: [],
      };
      return { id, kind: 'links', links };
    }
    case 'motion': {
      const mode = detail.motionMode ?? 'A';
      const isModeD = mode === 'D';
      const motion: MotionBlockDto = {
        id: newId(),
        mode,
        x: 0,
        y: 0,
        width: isModeD ? 860 : 640,
        height: isModeD ? 640 : 460,
        // Seed the per-mode defaults exactly as the dashboard's
        // add-handler does, so a motion widget in a note starts
        // identical to one on a dashboard.
        inputs: { ...MOTION_DEFAULTS[mode] },
        showAcc: false,
        showJerk: false,
      };
      return { id, kind: 'motion', motion };
    }
    case 'motor': {
      const motor: MotorBlockDto = {
        id: newId(),
        x: 0,
        y: 0,
        width: 720,
        height: 420,
        // A 2-pole machine on 50 Hz → 3000 rpm synchronous, the
        // textbook starting example. Half load, 6% rated slip (typical
        // induction motor), running.
        polePairs: 1,
        frequencyHz: 50,
        loadPct: 50,
        ratedSlipPct: 6,
        running: true,
      };
      return { id, kind: 'motor', motor };
    }
    default: {
      // Exhaustiveness guard — if a new kind is added to the union
      // without a branch here, TypeScript flags this line.
      const _never: never = detail.kind;
      void _never;
      return { id, kind: detail.kind };
    }
  }
}
