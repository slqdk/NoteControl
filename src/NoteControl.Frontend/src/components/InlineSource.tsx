import { useEffect, useRef, useState } from 'react';

import type { Environment, RuntimeValue, ScalarValue } from '../runtime/interpreter';
import {
  formatRuntimeValue, parsePokeInput, parsePokeInputForUnknown,
  pokeVariable, pokeMember,
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
 *     (no editor — fast path for "flip this bit").
 *   - Variables of unknown type (user-defined FBs / DUTs the v1
 *     runtime doesn't have a schema for) and their members render
 *     with greyed-out identifier text and a faded pill so the
 *     user sees they're not "really running" — but the pill is
 *     still pokeable, and the type of the poked value is inferred
 *     from input syntax (TRUE → BOOL, T#1s → TIME, 3.14 → REAL,
 *     etc.). Once a value has been poked into an unknown, BOOL
 *     ones support the same double-click toggle as declared BOOLs.
 *   - Built-in FB members (TON.Q, TON.ET) are read-only — they're
 *     derived from the FB's tick state and would be overwritten
 *     next scan, so letting the user poke them would be a lie.
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

/** Identity of the variable / member being edited in the inline
 *  editor. For bare unknowns and known scalars `memberLower` is
 *  null; for unknown-FB member pokes the object is `nameLower`
 *  and the field is `memberLower`. */
interface EditingTarget {
  line: number;
  column: number;
  nameLower: string;
  /** null for bare-variable poke, set for member poke. */
  memberLower: string | null;
}

export function InlineSource({
  source, program, env, errorLine, envVersion, pokeEnabled,
}: InlineSourceProps) {
  const decorations = collectDecorations(program);
  const lines = source.split('\n');

  // Active poke session. Null when nothing is being edited. Used
  // for exclusivity (only one poke at a time) and so the user's
  // input field doesn't fight the scan loop's value updates.
  const [editing, setEditing] = useState<EditingTarget | null>(null);

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

/**
 * Decide whether the variable referenced by a decoration is of
 * unknown type. We use this to grey out the identifier in the
 * source pane and to pick the right poke-input parser.
 *
 * For member-access decorations, "unknown" means the OBJECT is
 * unknown — the member itself doesn't have a separate type
 * declaration in our model. (TON.Q is "known-FB member" and
 * known-FB members are always known-typed; only the body of the
 * unknown FB has the "what's this field's type" gap.)
 */
function isUnknownAt(d: Decoration, env: Environment): boolean {
  if (d.payload.kind === 'var') {
    const v = env.get(d.payload.nameLower);
    return v?.kind === 'unknown';
  }
  const obj = env.get(d.payload.objectLower);
  return obj?.kind === 'unknown';
}

function renderLine(
  text: string,
  decos: Decoration[],
  env: Environment,
  lineNum: number,
  pokeEnabled: boolean,
  editing: EditingTarget | null,
  setEditing: (v: EditingTarget | null) => void,
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
    // Plain text up to the start of the identifier.
    if (idStart > cursor) {
      out.push(text.slice(cursor, idStart));
    }
    // The identifier itself — wrapped in a span so we can grey
    // it when it refers to an unknown-typed variable. (Native
    // text doesn't accept className, hence the wrapper.)
    const identText = text.slice(idStart, idEnd);
    if (isUnknownAt(d, env)) {
      out.push(
        <span key={`id${pillKey}`} className="nc-runtime-ident-unknown">
          {identText}
        </span>,
      );
    } else {
      out.push(identText);
    }
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

/**
 * Pill-rendering data, gathered up-front so the BOOL-toggle and
 * editor-spawn paths read uniformly. `pokeKind` selects which
 * runtime poke API the editor calls, and `currentText` is the
 * pre-filled value for the editor.
 */
interface PillData {
  formattedValue: string;
  pillType: ScalarTypeName | null;
  isBoolTrue: boolean;
  /** True when there's no known value yet (unknown var/member
   *  not poked, or the env lookup failed). */
  isMissing: boolean;
  /** True when the underlying variable is of unknown type,
   *  regardless of whether a value has been poked. */
  isUnknownTyped: boolean;
  /** What kind of poke the editor will perform when the user
   *  commits. null when this pill isn't pokeable at all (FB
   *  instance bare ref, FB-known-member). */
  pokeKind: 'scalar' | 'unknown-var' | 'unknown-member' | null;
}

function gatherPillData(
  d: Decoration, env: Environment,
): PillData {
  const empty: PillData = {
    formattedValue: '?',
    pillType: null,
    isBoolTrue: false,
    isMissing: true,
    isUnknownTyped: false,
    pokeKind: null,
  };

  if (d.payload.kind === 'var') {
    const v: RuntimeValue | undefined = env.get(d.payload.nameLower);
    if (!v) return empty;
    if (v.kind === 'fb') {
      // FB-typed variable referenced bare. Show the type tag so
      // the user sees it's an FB. Not pokeable.
      return {
        ...empty,
        formattedValue: `<${v.fbType}>`,
        isMissing: false,
      };
    }
    if (v.kind === 'unknown') {
      // Unknown-typed bare variable. Pokeable; type is inferred
      // from input syntax. If the user has poked something, show
      // that value with its inferred type's styling.
      if (v.scalarValue === null) {
        return {
          ...empty,
          formattedValue: `<${v.typeName}?>`,
          isUnknownTyped: true,
          pokeKind: 'unknown-var',
          // isMissing stays true so the pill renders muted but
          // still highlights as pokeable.
        };
      }
      const sv = v.scalarValue;
      return {
        formattedValue: formatRuntimeValue(sv),
        pillType: sv.type,
        isBoolTrue: sv.type === 'BOOL' && sv.value === true,
        isMissing: false,
        isUnknownTyped: true,
        pokeKind: 'unknown-var',
      };
    }
    // Known scalar.
    return {
      formattedValue: formatRuntimeValue(v),
      pillType: v.type,
      isBoolTrue: v.type === 'BOOL' && v.value === true,
      isMissing: false,
      isUnknownTyped: false,
      pokeKind: 'scalar',
    };
  }

  // Member access.
  const obj = env.get(d.payload.objectLower);
  if (!obj) return empty;
  if (obj.kind === 'unknown') {
    // Unknown FB member. Pokeable; same inference rules as bare
    // unknowns. Look up whatever's been poked into this member.
    const poked = obj.members.get(d.payload.memberLower);
    if (!poked) {
      return {
        ...empty,
        formattedValue: '?',
        isUnknownTyped: true,
        pokeKind: 'unknown-member',
      };
    }
    return {
      formattedValue: formatRuntimeValue(poked),
      pillType: poked.type,
      isBoolTrue: poked.type === 'BOOL' && poked.value === true,
      isMissing: false,
      isUnknownTyped: true,
      pokeKind: 'unknown-member',
    };
  }
  if (obj.kind !== 'fb') return empty;
  // Known FB member — derive from FB state. Read-only: members
  // are computed each scan, so any poke would be overwritten.
  const ms = obj.state;
  const memberLower = d.payload.memberLower;
  if (memberLower === 'q') {
    const q = ms.q === true;
    return {
      formattedValue: q ? 'TRUE' : 'FALSE',
      pillType: 'BOOL',
      isBoolTrue: q,
      isMissing: false,
      isUnknownTyped: false,
      pokeKind: null,
    };
  }
  if (memberLower === 'et') {
    const et = (ms.et ?? 0) as number;
    return {
      formattedValue: formatTimeForPill(et),
      pillType: 'TIME',
      isBoolTrue: false,
      isMissing: false,
      isUnknownTyped: false,
      pokeKind: null,
    };
  }
  return empty;
}

function renderPill(
  d: Decoration,
  env: Environment,
  key: number,
  lineNum: number,
  pokeEnabled: boolean,
  editing: EditingTarget | null,
  setEditing: (v: EditingTarget | null) => void,
  forceRender: () => void,
): React.ReactNode {
  const data = gatherPillData(d, env);

  // Identify "is this pill being edited right now". For
  // bare-variable pills (var-payload AND unknown-var poke kind),
  // `memberLower` on the editing target is null. For unknown-FB
  // member pills it's the lowercased member name.
  const editTargetMemberLower =
    d.payload.kind === 'member' && data.pokeKind === 'unknown-member'
      ? d.payload.memberLower
      : null;
  const editTargetNameLower =
    d.payload.kind === 'member' ? d.payload.objectLower : d.payload.nameLower;

  const isEditing =
    editing !== null && data.pokeKind !== null &&
    editing.line === lineNum &&
    editing.column === d.column &&
    editing.nameLower === editTargetNameLower &&
    editing.memberLower === editTargetMemberLower;

  if (isEditing) {
    return (
      <PillEditor
        key={key}
        nameLower={editTargetNameLower}
        memberLower={editTargetMemberLower}
        pokeKind={data.pokeKind!}
        currentText={data.formattedValue.replace(/^'|'$/g, '')}
        env={env}
        onCommit={(success) => {
          setEditing(null);
          if (success) forceRender();
        }}
      />
    );
  }

  let cls = 'nc-runtime-pill';
  if (data.isMissing) cls += ' nc-runtime-pill-missing';
  else if (data.pillType === 'BOOL') {
    cls += data.isBoolTrue
      ? ' nc-runtime-pill-bool nc-runtime-pill-bool-true'
      : ' nc-runtime-pill-bool nc-runtime-pill-bool-false';
  }
  if (data.isUnknownTyped) cls += ' nc-runtime-pill-unknown';

  // Pokeable when the pill has an editing path AND poking is
  // enabled. Unknown-var without a poked value is still pokeable
  // (in fact that's the main use — empty pill, click to populate).
  const canPoke = pokeEnabled && data.pokeKind !== null;
  if (canPoke) cls += ' nc-runtime-pill-pokeable';

  // BOOL pills support a double-click toggle. For unknown-typed,
  // we only treat them as BOOL if a BOOL has actually been poked;
  // otherwise the type isn't known yet and there's nothing to
  // toggle.
  const canToggleBool = canPoke && data.pillType === 'BOOL' && !data.isMissing;

  // Tooltip — surfaces both interaction affordances when present
  // and notes the unknown-type origin so the greyed pill is
  // self-explanatory.
  let tooltip: string;
  if (d.payload.kind === 'var') {
    const v = env.get(d.payload.nameLower);
    const typeLabel =
      v?.kind === 'unknown'
        ? `${v.typeName} (unknown — poked value)`
        : data.pillType ?? '?';
    tooltip = `${d.payload.name} : ${typeLabel}`;
  } else {
    const obj = env.get(d.payload.objectLower);
    const typeLabel =
      obj?.kind === 'unknown'
        ? `member of ${obj.typeName} (unknown — poked value)`
        : data.pillType ?? '?';
    tooltip = `${d.payload.objectName}.${d.payload.memberName} : ${typeLabel}`;
  }
  if (canToggleBool) {
    tooltip += ' — double-click to toggle, click to edit';
  } else if (canPoke) {
    tooltip += ' — click to edit';
  }

  // Single-click handler: open the inline editor.
  const handleClick = canPoke
    ? () => {
        setEditing({
          line: lineNum,
          column: d.column,
          nameLower: editTargetNameLower,
          memberLower: editTargetMemberLower,
        });
      }
    : undefined;

  // Double-click handler: BOOL pills toggle directly. Routed
  // through pokeVariable / pokeMember as appropriate so unknown
  // BOOLs (poked-as-BOOL) toggle the same way as declared BOOLs.
  const handleDoubleClick = canToggleBool
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const flipped = !data.isBoolTrue;
        const newVal: ScalarValue = {
          kind: 'scalar', type: 'BOOL', value: flipped,
        };
        let result;
        if (data.pokeKind === 'unknown-member') {
          result = pokeMember(env, editTargetNameLower, editTargetMemberLower!, newVal, 0);
        } else {
          result = pokeVariable(env, editTargetNameLower, newVal, 0);
        }
        if (result.ok) {
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
      {data.formattedValue}
    </span>
  );
}

function PillEditor({
  nameLower, memberLower, pokeKind, currentText, env, onCommit,
}: {
  nameLower: string;
  memberLower: string | null;
  pokeKind: 'scalar' | 'unknown-var' | 'unknown-member';
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

  // For known scalars we need the declared type to drive
  // parsePokeInput — for unknowns we use the inference parser
  // and there's no declared type to check.
  let targetType: ScalarTypeName | null = null;
  if (pokeKind === 'scalar') {
    const v = env.get(nameLower);
    if (!v || v.kind !== 'scalar') return null;
    targetType = v.type;
  }

  function commit() {
    let parsed:
      | { ok: true; value: ScalarValue }
      | { ok: false; error: string };
    if (pokeKind === 'scalar') {
      parsed = parsePokeInput(text, targetType!);
    } else {
      parsed = parsePokeInputForUnknown(text);
    }
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const result = pokeKind === 'unknown-member'
      ? pokeMember(env, nameLower, memberLower!, parsed.value, 0)
      : pokeVariable(env, nameLower, parsed.value, 0);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onCommit(true);
  }

  // Tooltip differs by poke kind: for known scalars we can show
  // the declared type, for unknowns we just say "unknown".
  const tooltipBase =
    pokeKind === 'scalar'
      ? `${nameLower} : ${targetType}`
      : pokeKind === 'unknown-member'
        ? `${nameLower}.${memberLower} : (unknown — type inferred from input)`
        : `${nameLower} : (unknown — type inferred from input)`;

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
        title={error ?? tooltipBase}
        aria-label={`Edit ${nameLower}${memberLower ? '.' + memberLower : ''}`}
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
