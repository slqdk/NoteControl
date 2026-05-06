import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';

import type { ParsedProgram, VarDecl } from '../runtime/ast';
import { StParseError } from '../runtime/errors';
import { parseProgram } from '../runtime/parser';
import { TYPE_META } from '../runtime/types';

/**
 * The runtime sandbox modal.
 *
 * Ship A scope (this file): parse the declaration + implementation
 * pair on open, show a TwinCAT-style two-pane layout (declaration
 * on top, implementation below) with a watch panel on the right
 * showing each variable's initial value and type. Run / Stop /
 * Step / Reset buttons are rendered but **disabled** with
 * explanatory tooltips — they activate in Ship B when the
 * interpreter lands.
 *
 * If parsing fails, the modal shows the formatted parse error
 * with line number, no watch panel, and disables every action
 * except Close. The user can dismiss the modal and edit the
 * code blocks directly.
 *
 * Why a portal: the modal renders at document.body to escape any
 * clipping or stacking-context bound to the editor wrapper. The
 * scrim takes the whole viewport regardless of frame-width.
 *
 * Initial-value evaluation: we evaluate literal initial-value
 * expressions in the parser's literal form. Non-literal
 * expressions (like `c : INT := a + b;`) are not supported in
 * the v1 watch view — the variable starts at the type's default
 * value and a small marker shows "(init not evaluated yet)" next
 * to it. Ship B will run the init expressions properly when the
 * interpreter exists.
 */
export interface RuntimeModalProps {
  declarationText: string;
  implementationText: string;
  onClose(): void;
}

interface InitialValue {
  v: VarDecl;
  /** The display value at scan 0. */
  display: string;
  /** True when the initial expression couldn't be reduced to a
   *  literal — the watch panel adds a small marker. */
  unevaluated: boolean;
}

export function RuntimeModal({
  declarationText,
  implementationText,
  onClose,
}: RuntimeModalProps) {
  // Parse once on mount. Re-parsing if the user edited the code
  // outside the modal isn't supported — closing and re-opening
  // is the supported flow.
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

  const initialValues = useMemo<InitialValue[]>(() => {
    if (!parsed.ok) return [];
    return parsed.program.program.vars.map((v) => evaluateInitial(v));
  }, [parsed]);

  // Esc to close. We listen on window instead of the modal element
  // so it works even when focus is in a button inside.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Click on backdrop closes; click on modal itself doesn't.
  const backdropRef = useRef<HTMLDivElement>(null);
  function onBackdropMouseDown(e: React.MouseEvent) {
    if (e.target === backdropRef.current) onClose();
  }

  const stCount = parsed.ok ? parsed.program.body.length : 0;
  const varCount = parsed.ok ? parsed.program.program.vars.length : 0;

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

        <div className="nc-runtime-modal-toolbar">
          <button
            type="button"
            disabled
            title="The interpreter ships in a follow-up step — for now this modal verifies the code parses cleanly"
          >
            Run ▶
          </button>
          <button type="button" disabled title="Not yet">Step</button>
          <button type="button" disabled title="Not yet">Stop</button>
          <button type="button" disabled title="Not yet">Reset</button>

          <div className="nc-runtime-modal-toolbar-spacer" />

          <label className="nc-runtime-modal-cycle">
            Cycle:
            <select disabled value="100">
              <option value="10">10 ms</option>
              <option value="50">50 ms</option>
              <option value="100">100 ms</option>
              <option value="500">500 ms</option>
              <option value="1000">1 s</option>
            </select>
          </label>

          <span className="nc-runtime-modal-status" title="Scan counter">
            scan: 0
          </span>
        </div>

        <div className="nc-runtime-modal-body">
          <div className="nc-runtime-modal-code">
            <div className="nc-runtime-modal-pane">
              <div className="nc-runtime-modal-pane-title">Declaration</div>
              <pre className="nc-runtime-modal-source">
                <code>{declarationText}</code>
              </pre>
            </div>
            <div className="nc-runtime-modal-pane">
              <div className="nc-runtime-modal-pane-title">Implementation</div>
              <pre className="nc-runtime-modal-source">
                <code>{implementationText}</code>
              </pre>
            </div>
          </div>

          <div className="nc-runtime-modal-watch">
            <div className="nc-runtime-modal-pane-title">
              Watch ({varCount})
            </div>
            {parsed.ok ? (
              <table className="nc-runtime-modal-watch-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {initialValues.map((iv) => (
                    <tr key={iv.v.nameLower}>
                      <td className="nc-runtime-modal-watch-name">
                        {iv.v.name}
                      </td>
                      <td className="nc-runtime-modal-watch-type">
                        {iv.v.type.name}
                      </td>
                      <td className="nc-runtime-modal-watch-value">
                        {iv.display}
                        {iv.unevaluated && (
                          <span className="nc-runtime-modal-watch-marker">
                            init not evaluated yet
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="nc-runtime-modal-watch-empty">
                Watch panel unavailable while there are parse errors.
              </div>
            )}
          </div>
        </div>

        <div className="nc-runtime-modal-footer">
          <span className="nc-runtime-modal-foot-note">
            Ship A: parser only. Run/Step/Stop/Reset light up in
            the next ship when the interpreter lands.
          </span>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

/**
 * Compute the initial value display for one variable. We accept
 * literal initial expressions (numbers, booleans, strings, time
 * literals) and unary-minus on a numeric literal. Anything more
 * complex (variable references, calls, arithmetic) needs the
 * interpreter — flag as unevaluated and use the type default.
 *
 * The display uses the same conventions as TwinCAT online:
 *   BOOL   → TRUE / FALSE
 *   ints   → decimal
 *   reals  → JS toString (good enough for v1; locale punctuation
 *            isn't a concern in dev contexts)
 *   STRING → quoted with single quotes
 *   TIME   → recomposed as `T#1s500ms`-style if non-zero, else T#0ms
 */
function evaluateInitial(v: VarDecl): InitialValue {
  const meta = TYPE_META[v.type.name];

  function fallback(): InitialValue {
    return {
      v,
      display: formatValue(v.type.name, meta.defaultValue),
      unevaluated: v.initial !== null,
    };
  }

  if (!v.initial) {
    return {
      v,
      display: formatValue(v.type.name, meta.defaultValue),
      unevaluated: false,
    };
  }

  // Direct literal
  if (v.initial.kind === 'Literal') {
    return {
      v,
      display: formatValue(v.type.name, v.initial.value),
      unevaluated: false,
    };
  }

  // Unary minus on a literal: e.g. `i : INT := -5;`
  if (v.initial.kind === 'Unary' && v.initial.op === 'NEG' &&
      v.initial.operand.kind === 'Literal') {
    const inner = v.initial.operand.value;
    if (typeof inner === 'number') {
      return {
        v,
        display: formatValue(v.type.name, -inner),
        unevaluated: false,
      };
    }
  }

  return fallback();
}

function formatValue(
  typeName: string,
  value: unknown,
): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (typeName === 'TIME') return formatTime(value);
    return value.toString();
  }
  return String(value);
}

/** Render a millisecond count back as a TIME literal `T#1s500ms`. */
function formatTime(ms: number): string {
  if (ms === 0) return 'T#0ms';
  let remaining = Math.max(0, Math.round(ms));
  const parts: string[] = [];
  const day = 24 * 60 * 60 * 1000;
  const hr = 60 * 60 * 1000;
  const min = 60 * 1000;
  const sec = 1000;
  if (remaining >= day) {
    const d = Math.floor(remaining / day);
    parts.push(`${d}d`);
    remaining -= d * day;
  }
  if (remaining >= hr) {
    const h = Math.floor(remaining / hr);
    parts.push(`${h}h`);
    remaining -= h * hr;
  }
  if (remaining >= min) {
    const m = Math.floor(remaining / min);
    parts.push(`${m}m`);
    remaining -= m * min;
  }
  if (remaining >= sec) {
    const s = Math.floor(remaining / sec);
    parts.push(`${s}s`);
    remaining -= s * sec;
  }
  if (remaining > 0) {
    parts.push(`${remaining}ms`);
  }
  return 'T#' + parts.join('');
}
