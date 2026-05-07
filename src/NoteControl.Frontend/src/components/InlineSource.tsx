import { useEffect, useRef, useState } from 'react';

import type { Environment, RuntimeValue } from '../runtime/interpreter';
import {
  formatRuntimeValue, parsePokeInput, pokeVariable,
} from '../runtime/interpreter';
import type {
  ParsedProgram, VarRefExpr, Statement, Expr, ScalarTypeName,
} from '../runtime/ast';

/**
 * Renders the implementation source text with inline value pills
 * spliced after every variable reference and FB-member access.
 *
 * Visual model (matches TwinCAT online view):
 *   - Plain monospace text with original whitespace preserved.
 *   - After each variable reference identifier, an inline pill
 *     containing the current runtime value of that variable.
 *   - After `MyTimer.Q`-style member access, a pill with the
 *     member's current value.
 *   - BOOLs get a coloured fill (blue=TRUE, grey=FALSE). Other
 *     types get a neutral border-only style.
 *   - Pills are clickable when poking is enabled — single-click
 *     opens an inline editor for any scalar type. BOOLs ALSO
 *     accept a double-click that toggles their value directly
 *     (no editor — fast path for "flip this bit"). FB-instance
 *     and FB-member pills are read-only (member values are
 *     derived; the user can't poke an FB output).
 */
export interface InlineSourceProps {
  source: string;
  program: ParsedProgram;
  env: Environment;
  errorLine: number | null;
  /** Bumped by the parent on every scan / state change so this
   *  component re-renders pill values. The component reads env
   *  through a prop ref but env-mutation alone won't trigger
   *  React; the version bump is what does. */
  envVersion: number;
  /** True when the modal allows mid-run poking. Disabled in
   *  error mode. */
  pokeEnabled: boolean;
}

interface VarPayload {
  kind: 'var';
  nameLower: string;
  name: string;
}

interface MemberPayload {
  kind: 'member';
  objectLower: string;
  objectName: string;
  memberLower: string;
  memberName: string;
}

interface Decoration {
  /** 1-indexed column of the decoration's first character. */
  column: number;
  /** How many source characters this decoration spans. For
   *  VarRefs that's the identifier's length; for MemberExprs
   *  it's `object.length + 1 + member.length`. */
  length: number;
  /** 1-indexed source line. */
  line: number;
  payload: VarPayload | MemberPayload;
}

export function InlineSource({
  source, program, env, errorLine, envVersion, pokeEnabled,
}: InlineSourceProps) {
  const decorations = collectDecorations(program);
  const lines = source.split('\n');

  // Active poke session. Null when nothing is being edited. Used
  // for exclusivity (only one poke at a time) and so the user's
  // input field doesn't fight the scan loop's value updates.
  const [editing, setEditing] = useState<{
    line: number; column: number; nameLower: string;
  } | null>(null);

  // After a successful poke, force a re-render so all pills (not
  // just the edited one) reflect the new value.
  const [, forceRender] = useState({});
  void envVersion;

  return (
    <div className="nc-runtime-inline-source">
      {lines.map((lineText, index) => {
        const lineNum = index + 1;
        const decos = decorations.get(lineNum) ?? [];
        const isErr = errorLine === lineNum;
        return (
          <div
            key={lineNum}
            className={
              'nc-runtime-inline-line' +
              (isErr ? ' nc-runtime-inline-line-err' : '')
            }
          >
            <span className="nc-runtime-inline-gutter">{lineNum}</span>
            <span className="nc-runtime-inline-content">
              {renderLine(
                lineText, decos, env, lineNum,
                pokeEnabled, editing, setEditing,
                () => forceRender({}),
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Walk the parsed program's body and return a map from 1-indexed
 * line number to a sorted list of decoration sites on that line.
 *
 * MemberExprs emit ONE decoration covering `obj.member` rather
 * than separate ones for `obj` and `member`. Avoids double-pills
 * like `myTimer FB myTimer.Q TRUE`.
 *
 * Decoration sources:
 *   - Assignment LHS (a VarRef)
 *   - FOR loop variable
 *   - Every VarRefExpr in expressions
 *   - Every MemberExpr (covers the whole `obj.member` span)
 *   - Call args (positional/named-in values, named-out targets)
 */
function collectDecorations(
  program: ParsedProgram,
): Map<number, Decoration[]> {
  const out = new Map<number, Decoration[]>();

  function add(d: Decoration) {
    const list = out.get(d.line);
    if (list) list.push(d);
    else out.set(d.line, [d]);
  }

  function visitExpr(e: Expr) {
    switch (e.kind) {
      case 'Literal':
        return;
      case 'VarRef':
        add({
          line: e.line, column: e.column, length: e.name.length,
          payload: { kind: 'var', nameLower: e.nameLower, name: e.name },
        });
        return;
      case 'Member':
        add({
          line: e.line, column: e.column,
          length: e.object.name.length + 1 + e.member.length,
          payload: {
            kind: 'member',
            objectLower: e.object.nameLower, objectName: e.object.name,
            memberLower: e.memberLower, memberName: e.member,
          },
        });
        return;
      case 'Unary':
        visitExpr(e.operand); return;
      case 'Binary':
        visitExpr(e.left); visitExpr(e.right); return;
      case 'Call':
        for (const a of e.args) {
          if (a.value) visitExpr(a.value);
          if (a.target) visitVarRef(a.target);
        }
        return;
    }
  }

  function visitStmt(s: Statement) {
    switch (s.kind) {
      case 'Assign':
        visitVarRef(s.target);
        visitExpr(s.value);
        return;
      case 'If':
        for (const b of s.branches) {
          if (b.condition) visitExpr(b.condition);
          for (const inner of b.body) visitStmt(inner);
        }
        return;
      case 'Case':
        visitExpr(s.selector);
        for (const b of s.branches) {
          for (const l of b.labels) {
            visitExpr(l.low);
            if (l.kind === 'Range') visitExpr(l.high);
          }
          for (const inner of b.body) visitStmt(inner);
        }
        return;
      case 'For':
        visitVarRef(s.loopVar);
        visitExpr(s.start);
        visitExpr(s.end);
        if (s.step) visitExpr(s.step);
        for (const inner of s.body) visitStmt(inner);
        return;
      case 'While':
        visitExpr(s.condition);
        for (const inner of s.body) visitStmt(inner);
        return;
      case 'Repeat':
        for (const inner of s.body) visitStmt(inner);
        visitExpr(s.until);
        return;
      case 'Exit':
      case 'Continue':
      case 'Return':
        return;
      case 'ExpressionStmt':
        visitExpr(s.expression);
        return;
    }
  }

  function visitVarRef(v: VarRefExpr) {
    add({
      line: v.line, column: v.column, length: v.name.length,
      payload: { kind: 'var', nameLower: v.nameLower, name: v.name },
    });
  }

  for (const s of program.body) visitStmt(s);

  for (const list of out.values()) {
    list.sort((a, b) => a.column - b.column);
  }
  return out;
}

function renderLine(
  text: string,
  decos: Decoration[],
  env: Environment,
  lineNum: number,
  pokeEnabled: boolean,
  editing: { line: number; column: number; nameLower: string } | null,
  setEditing: (v: { line: number; column: number; nameLower: string } | null) => void,
  forceRender: () => void,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let cursor = 0;
  let pillKey = 0;

  for (const d of decos) {
    const idStart = d.column - 1;
    const idEnd = idStart + d.length;
    if (idStart < cursor) continue;
    if (idEnd > text.length) continue;
    out.push(text.slice(cursor, idEnd));
    out.push(renderPill(
      d, env, pillKey++, lineNum, pokeEnabled, editing, setEditing, forceRender,
    ));
    cursor = idEnd;
  }

  if (cursor < text.length) {
    out.push(text.slice(cursor));
  } else if (text.length === 0 && decos.length === 0) {
    out.push('\u200b');
  }

  return out;
}

function renderPill(
  d: Decoration,
  env: Environment,
  key: number,
  lineNum: number,
  pokeEnabled: boolean,
  editing: { line: number; column: number; nameLower: string } | null,
  setEditing: (v: { line: number; column: number; nameLower: string } | null) => void,
  forceRender: () => void,
): React.ReactNode {
  let formattedValue: string;
  let pillType: ScalarTypeName | null = null;
  let isBoolTrue = false;
  let isMissing = false;

  if (d.payload.kind === 'var') {
    const v: RuntimeValue | undefined = env.get(d.payload.nameLower);
    if (!v) {
      formattedValue = '?';
      isMissing = true;
    } else if (v.kind === 'fb') {
      // FB-typed variable referenced bare (not via member). Show
      // the type tag so the user sees it's an FB. Not pokeable.
      formattedValue = `<${v.fbType}>`;
    } else {
      formattedValue = formatRuntimeValue(v);
      pillType = v.type;
      if (v.type === 'BOOL') isBoolTrue = v.value === true;
    }
  } else {
    // Member access — derive the current member value.
    const obj = env.get(d.payload.objectLower);
    if (!obj || obj.kind !== 'fb') {
      formattedValue = '?';
      isMissing = true;
    } else {
      const ms = obj.state;
      const memberLower = d.payload.memberLower;
      if (memberLower === 'q') {
        const q = ms.q === true;
        formattedValue = q ? 'TRUE' : 'FALSE';
        pillType = 'BOOL';
        isBoolTrue = q;
      } else if (memberLower === 'et') {
        const et = (ms.et ?? 0) as number;
        formattedValue = formatTimeForPill(et);
        pillType = 'TIME';
      } else {
        formattedValue = '?';
        isMissing = true;
      }
    }
  }

  const isEditing =
    editing !== null &&
    d.payload.kind === 'var' &&
    editing.line === lineNum &&
    editing.column === d.column &&
    editing.nameLower === d.payload.nameLower;

  if (isEditing && d.payload.kind === 'var') {
    return (
      <PillEditor
        key={key}
        nameLower={d.payload.nameLower}
        currentText={formattedValue.replace(/^'|'$/g, '')}
        env={env}
        onCommit={(success) => {
          setEditing(null);
          if (success) forceRender();
        }}
      />
    );
  }

  let cls = 'nc-runtime-pill';
  if (isMissing) cls += ' nc-runtime-pill-missing';
  else if (pillType === 'BOOL') {
    cls += isBoolTrue
      ? ' nc-runtime-pill-bool nc-runtime-pill-bool-true'
      : ' nc-runtime-pill-bool nc-runtime-pill-bool-false';
  }

  // Pokeable: scalar var only, type known, poking enabled.
  const canPoke =
    pokeEnabled && !isMissing &&
    d.payload.kind === 'var' && pillType !== null;
  if (canPoke) cls += ' nc-runtime-pill-pokeable';

  // BOOL var pills support a double-click toggle as a fast path.
  // FB-member BOOLs (e.g. Timer01.Q) are NOT toggleable — they're
  // derived outputs of the FB and would be overwritten next scan
  // anyway, so letting the user "toggle" them would be a lie.
  const canToggleBool =
    canPoke && d.payload.kind === 'var' && pillType === 'BOOL';

  // Tooltip text — surfaces both interaction affordances when
  // they're present so the double-click toggle is discoverable
  // (it has no other visual cue).
  let tooltip: string;
  if (d.payload.kind === 'var') {
    tooltip = `${d.payload.name} : ${pillType ?? '?'}`;
    if (canToggleBool) {
      tooltip += ' (double-click to toggle, click to edit)';
    } else if (canPoke) {
      tooltip += ' (click to edit)';
    }
  } else {
    tooltip = `${d.payload.objectName}.${d.payload.memberName} : ${pillType ?? '?'}`;
  }

  // Single-click handler: open the inline editor. Same as before.
  // Note we use onClick (not onMouseDown) so the browser's native
  // double-click detection still works — onClick fires for both
  // halves of a double-click, which is fine because the editor's
  // "open" is idempotent (setEditing on the same target is a no-op
  // beyond the first call within the same render cycle, and React
  // batches state updates anyway).
  const handleClick = canPoke && d.payload.kind === 'var'
    ? () => {
        if (d.payload.kind === 'var') {
          setEditing({
            line: lineNum,
            column: d.column,
            nameLower: d.payload.nameLower,
          });
        }
      }
    : undefined;

  // Double-click handler: BOOLs toggle directly via pokeVariable.
  // We swallow the event so the single-click path's editor doesn't
  // remain open underneath — but importantly we close it explicitly
  // after the toggle, since the first click of the double-click
  // pair will have opened the editor. The forceRender() at the end
  // makes the new BOOL value paint immediately rather than waiting
  // for the next scan tick.
  const handleDoubleClick = canToggleBool && d.payload.kind === 'var'
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (d.payload.kind !== 'var') return;
        const current = env.get(d.payload.nameLower);
        if (!current || current.kind !== 'scalar' || current.type !== 'BOOL') {
          return;
        }
        const flipped = current.value === true ? false : true;
        const result = pokeVariable(
          env, d.payload.nameLower,
          { kind: 'scalar', type: 'BOOL', value: flipped },
          0,
        );
        if (result.ok) {
          // If the editor was opened by the first click of the
          // double-click pair, close it so we don't strand an
          // input field on top of the toggled pill.
          setEditing(null);
          forceRender();
        }
      }
    : undefined;

  return (
    <span
      key={key}
      className={cls}
      title={tooltip}
      role={canPoke ? 'button' : undefined}
      tabIndex={canPoke ? 0 : undefined}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {formattedValue}
    </span>
  );
}

function PillEditor({
  nameLower, currentText, env, onCommit,
}: {
  nameLower: string;
  currentText: string;
  env: Environment;
  onCommit(success: boolean): void;
}) {
  const [text, setText] = useState(currentText);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  const v = env.get(nameLower);
  if (!v || v.kind !== 'scalar') {
    return null;
  }
  const targetType = v.type;

  function commit() {
    const parsed = parsePokeInput(text, targetType);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const result = pokeVariable(env, nameLower, parsed.value, 0);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onCommit(true);
  }

  return (
    <span className="nc-runtime-pill nc-runtime-pill-editing">
      <input
        ref={inputRef}
        type="text"
        className={
          'nc-runtime-pill-input' +
          (error ? ' nc-runtime-pill-input-err' : '')
        }
        value={text}
        size={Math.max(4, text.length + 1)}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCommit(false);
          }
        }}
        onBlur={() => {
          if (text === currentText) {
            onCommit(false);
          } else {
            commit();
          }
        }}
        title={error ?? `${nameLower} : ${targetType}`}
        aria-label={`Edit ${nameLower}`}
      />
    </span>
  );
}

function formatTimeForPill(ms: number): string {
  if (ms === 0) return 'T#0ms';
  let r = Math.max(0, Math.round(ms));
  const parts: string[] = [];
  const day = 86400000, hr = 3600000, min = 60000, sec = 1000;
  if (r >= day) { const d = Math.floor(r / day); parts.push(`${d}d`); r -= d * day; }
  if (r >= hr)  { const h = Math.floor(r / hr);  parts.push(`${h}h`); r -= h * hr; }
  if (r >= min) { const m = Math.floor(r / min); parts.push(`${m}m`); r -= m * min; }
  if (r >= sec) { const s = Math.floor(r / sec); parts.push(`${s}s`); r -= s * sec; }
  if (r > 0) parts.push(`${r}ms`);
  return 'T#' + parts.join('');
}
