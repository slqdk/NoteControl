import { useEffect, useMemo, useReducer, useRef } from 'react';
import { createPortal } from 'react-dom';

import { InlineSource } from './InlineSource';
import type { ParsedProgram } from '../runtime/ast';
import type { Environment } from '../runtime/interpreter';
import { createEnvironment, runScan } from '../runtime/interpreter';
import { StParseError, StRuntimeError } from '../runtime/errors';
import { parseProgram } from '../runtime/parser';

/**
 * The runtime sandbox modal.
 *
 * Ship B: full execution. The implementation pane shows live
 * inline value pills next to every variable reference (TwinCAT
 * online-view style); the declaration pane stays plain. Run /
 * Stop / Step / Reset are wired; cycle time selectable.
 *
 * State machine (the 'mode' field of UiState):
 *
 *   'paused'  — initial state on open; also after Stop, after a
 *               full Step, or after Reset. Run is enabled.
 *   'running' — scan loop active. Stop is enabled. The watch
 *               updates each scan.
 *   'error'   — a runtime fault halted execution. The error
 *               line is highlighted in the implementation pane
 *               and a banner shows the formatted message.
 *               Reset clears it; Run is disabled until then.
 *
 * Scan-loop wiring uses setInterval. We carry the interval
 * handle in a ref and clear it on every state transition that
 * leaves 'running' mode. The interval callback is *idempotent*
 * — it dispatches a 'TICK' action and lets the reducer decide
 * whether a scan actually runs (it might not if mode changed
 * between the timer firing and the dispatch).
 *
 * Why useReducer + scan loop in a ref instead of vanilla state:
 * the scan loop callback closes over the env mutably, and we
 * need a single sequenced source of truth so a fast cycle (10ms)
 * doesn't tear state. The reducer also makes the Reset / Run /
 * Step transitions easy to reason about as one switch.
 */

export interface RuntimeModalProps {
  declarationText: string;
  implementationText: string;
  onClose(): void;
}

type Mode = 'paused' | 'running' | 'error';

interface UiState {
  mode: Mode;
  scanCount: number;
  cycleMs: number;
  /** When mode === 'error', the formatted message. */
  errorMessage: string | null;
  /** When mode === 'error', the offending line for highlighting. */
  errorLine: number | null;
  /** Versioning bump — components reading env directly through
   *  the ref need a render trigger to pick up scan changes. */
  envVersion: number;
  /** Cumulative wall-clock-style time the runtime has been
   *  executing, in ms. Increments by cycleMs per Run-tick.
   *  Frozen during Stop/error. Reset to 0 by Reset. The
   *  interpreter passes this into runScan() so TON/TOF can
   *  derive elapsed time from it. */
  scanTimeMs: number;
}

type Action =
  | { type: 'RUN' }
  | { type: 'STOP' }
  | { type: 'STEP_DONE' }
  | { type: 'RESET' }
  | { type: 'CYCLE_CHANGE'; ms: number }
  | { type: 'SCAN_OK' }
  | { type: 'SCAN_ERR'; message: string; line: number };

function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case 'RUN':
      if (state.mode === 'error') return state;
      return { ...state, mode: 'running' };
    case 'STOP':
      return { ...state, mode: 'paused' };
    case 'STEP_DONE':
      return {
        ...state,
        mode: 'paused',
        scanCount: state.scanCount + 1,
        scanTimeMs: state.scanTimeMs + state.cycleMs,
        envVersion: state.envVersion + 1,
      };
    case 'RESET':
      return {
        ...state,
        mode: state.mode === 'error' ? 'paused' : state.mode,
        scanCount: 0,
        scanTimeMs: 0,
        errorMessage: null,
        errorLine: null,
        envVersion: state.envVersion + 1,
      };
    case 'CYCLE_CHANGE':
      return { ...state, cycleMs: action.ms };
    case 'SCAN_OK':
      return {
        ...state,
        scanCount: state.scanCount + 1,
        scanTimeMs: state.scanTimeMs + state.cycleMs,
        envVersion: state.envVersion + 1,
      };
    case 'SCAN_ERR':
      return {
        ...state,
        mode: 'error',
        errorMessage: action.message,
        errorLine: action.line,
        envVersion: state.envVersion + 1,
      };
  }
}

const INITIAL: UiState = {
  mode: 'paused',
  scanCount: 0,
  // 10ms default — matches the typical TwinCAT task cycle and
  // makes counters/timers feel responsive on first Run. Users can
  // dial it slower from the Cycle dropdown when they want to watch
  // the scan progress step by step.
  cycleMs: 10,
  errorMessage: null,
  errorLine: null,
  envVersion: 0,
  scanTimeMs: 0,
};

export function RuntimeModal({
  declarationText, implementationText, onClose,
}: RuntimeModalProps) {
  // --- Parsing (once on mount) -------------------------------
  // Re-parsing on every prop change is the right move IF the
  // user could edit the underlying note while the modal is open.
  // Currently they can't — opening the modal locks focus to it,
  // and the props are passed by value (snapshots) — but useMemo
  // costs nothing here.
  const parsed = useMemo<
    | { ok: true; program: ParsedProgram }
    | { ok: false; error: string; line: number }
  >(() => {
    try {
      const program = parseProgram(declarationText, implementationText);
      return { ok: true, program };
    } catch (e) {
      if (e instanceof StParseError) {
        return { ok: false, error: e.format(), line: e.line };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, line: 0 };
    }
  }, [declarationText, implementationText]);

  // --- Environment --------------------------------------------
  // Held in a ref so the scan loop's interval callback can mutate
  // it directly without closure-capturing-stale-state issues.
  // Initial creation is inline (synchronous, before first render)
  // so the InlineSource renders with real data on the first paint.
  // The Reset effect below rebuilds the env when the user clicks
  // Reset (detected via the version stamp).
  const envRef = useRef<Environment | null>(null);
  if (parsed.ok && envRef.current === null) {
    envRef.current = createEnvironment(parsed.program);
  }

  const [state, dispatch] = useReducer(reducer, INITIAL);

  // --- Scan loop ----------------------------------------------
  const intervalRef = useRef<number | null>(null);
  // Mirror state.scanTimeMs into a ref so the tick callback always
  // reads the current value, not a stale closure capture.
  const scanTimeRef = useRef<number>(state.scanTimeMs);
  scanTimeRef.current = state.scanTimeMs;

  useEffect(() => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (!parsed.ok || state.mode !== 'running') return;

    const tick = () => {
      const env = envRef.current;
      if (!env) return;
      try {
        runScan(parsed.program, env, scanTimeRef.current);
        dispatch({ type: 'SCAN_OK' });
      } catch (e) {
        if (e instanceof StRuntimeError) {
          dispatch({ type: 'SCAN_ERR', message: e.format(), line: e.line });
        } else {
          dispatch({
            type: 'SCAN_ERR',
            message: e instanceof Error ? e.message : String(e),
            line: 0,
          });
        }
      }
    };

    intervalRef.current = window.setInterval(tick, state.cycleMs);
    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [parsed, state.mode, state.cycleMs]);

  // --- Reset side effect: rebuild env --------------------------
  // We listen for a (scanCount=0, envVersion-bump) tuple, which
  // is the signature of the RESET action. Tracking the last-seen
  // envVersion in a ref keeps this from firing redundantly. The
  // ref is seeded to 0 (the initial envVersion) so the inline
  // synchronous env init above stands as the ground truth on
  // mount — this effect ONLY fires when the user clicks Reset.
  const resetSeenAtVersionRef = useRef<number>(0);
  useEffect(() => {
    if (!parsed.ok) return;
    if (state.scanCount === 0 && state.envVersion !== resetSeenAtVersionRef.current) {
      resetSeenAtVersionRef.current = state.envVersion;
      envRef.current = createEnvironment(parsed.program);
    }
  }, [state.envVersion, state.scanCount, parsed]);

  // --- Step: run one scan synchronously ------------------------
  const onStep = () => {
    const env = envRef.current;
    if (!env || !parsed.ok) return;
    if (state.mode === 'error') return;
    try {
      runScan(parsed.program, env, scanTimeRef.current);
      dispatch({ type: 'STEP_DONE' });
    } catch (e) {
      if (e instanceof StRuntimeError) {
        dispatch({ type: 'SCAN_ERR', message: e.format(), line: e.line });
      } else {
        dispatch({
          type: 'SCAN_ERR',
          message: e instanceof Error ? e.message : String(e),
          line: 0,
        });
      }
    }
  };

  // --- Esc to close -------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // --- Backdrop click to close --------------------------------
  const backdropRef = useRef<HTMLDivElement>(null);
  function onBackdropMouseDown(e: React.MouseEvent) {
    if (e.target === backdropRef.current) onClose();
  }

  // --- Derived display values ---------------------------------
  const stCount = parsed.ok ? parsed.program.body.length : 0;
  const varCount = parsed.ok ? parsed.program.program.vars.length : 0;
  const env = envRef.current;
  // envVersion forces re-render on scan; don't reference it in
  // logic, but we DO want React to see it as a render trigger.
  void state.envVersion;

  const canRun = parsed.ok && state.mode !== 'running' && state.mode !== 'error';
  const canStop = parsed.ok && state.mode === 'running';
  const canStep = parsed.ok && state.mode === 'paused';
  const canReset = parsed.ok;

  const modal = (
    <div
      className="nc-runtime-modal-backdrop"
      ref={backdropRef}
      onMouseDown={onBackdropMouseDown}
      role="dialog"
      aria-modal="true"
      aria-label="ST sandbox"
    >
      <div className="nc-runtime-modal">
        <div className="nc-runtime-modal-header">
          <div className="nc-runtime-modal-title">
            ST sandbox
            {parsed.ok && (
              <span className="nc-runtime-modal-summary">
                · {parsed.program.program.name} · {varCount} variable
                {varCount !== 1 ? 's' : ''} · {stCount} statement
                {stCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <button
            type="button"
            className="nc-runtime-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {!parsed.ok && (
          <div className="nc-runtime-modal-error">
            <strong>Couldn't parse the code:</strong>
            <br />
            {parsed.error}
          </div>
        )}

        {state.mode === 'error' && state.errorMessage && (
          <div className="nc-runtime-modal-error">
            <strong>Runtime halted:</strong>
            <br />
            {state.errorMessage}
            <br />
            <span className="nc-runtime-modal-error-hint">
              Click Reset to clear and start over.
            </span>
          </div>
        )}

        <div className="nc-runtime-modal-toolbar">
          <button
            type="button"
            disabled={!canRun}
            onClick={() => dispatch({ type: 'RUN' })}
            title="Run continuously at the chosen cycle time"
          >
            Run ▶
          </button>
          <button
            type="button"
            disabled={!canStep}
            onClick={onStep}
            title="Run one scan, then pause"
          >
            Step
          </button>
          <button
            type="button"
            disabled={!canStop}
            onClick={() => dispatch({ type: 'STOP' })}
            title="Pause execution; values frozen at current scan"
          >
            Stop
          </button>
          <button
            type="button"
            disabled={!canReset}
            onClick={() => dispatch({ type: 'RESET' })}
            title="Re-evaluate initial values; scan counter back to 0"
          >
            Reset
          </button>

          <div className="nc-runtime-modal-toolbar-spacer" />

          <label className="nc-runtime-modal-cycle">
            Cycle:
            <select
              value={state.cycleMs}
              disabled={state.mode === 'error'}
              onChange={(e) =>
                dispatch({ type: 'CYCLE_CHANGE', ms: Number(e.target.value) })
              }
            >
              <option value={10}>10 ms</option>
              <option value={50}>50 ms</option>
              <option value={100}>100 ms</option>
              <option value={500}>500 ms</option>
              <option value={1000}>1 s</option>
            </select>
          </label>

          <span className="nc-runtime-modal-status" title="Scan counter">
            scan: {state.scanCount}
          </span>
          <span className="nc-runtime-modal-status" title="Runtime elapsed time (frozen during Stop)">
            t: {formatElapsed(state.scanTimeMs)}
          </span>
        </div>

        <div className="nc-runtime-modal-body">
          <div className="nc-runtime-modal-pane">
            <div className="nc-runtime-modal-pane-title">Declaration</div>
            <pre className="nc-runtime-modal-source">
              <code>{declarationText}</code>
            </pre>
          </div>
          <div className="nc-runtime-modal-pane">
            <div className="nc-runtime-modal-pane-title">Implementation</div>
            {parsed.ok && env ? (
              <InlineSource
                source={implementationText}
                program={parsed.program}
                env={env}
                errorLine={state.errorLine}
                envVersion={state.envVersion}
                pokeEnabled={state.mode !== 'error'}
              />
            ) : (
              <pre className="nc-runtime-modal-source">
                <code>{implementationText}</code>
              </pre>
            )}
          </div>
        </div>

        <div className="nc-runtime-modal-footer">
          <span className="nc-runtime-modal-foot-note">
            Live values shown next to each variable reference. v1
            scope: scalars + IF/CASE/FOR/WHILE/REPEAT only — no
            timers or function blocks yet.
          </span>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

/**
 * Format the runtime's elapsed time for the toolbar status. Uses
 * a slightly different convention than the inline TIME pills: we
 * always show seconds, and rounded to one decimal place under
 * 100s, so the running counter feels alive at fast cycles.
 *
 * Examples:
 *   0      → "0s"
 *   500    → "0.5s"
 *   1500   → "1.5s"
 *   60000  → "60s"
 *   125000 → "2m 5s"
 */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) {
    const dec = (ms / 1000).toFixed(1);
    return `${dec}s`;
  }
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}
