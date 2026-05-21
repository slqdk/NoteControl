import { useEffect, useRef, useState } from 'react';

import type { Environment, RuntimeValue, ScalarValue } from '../runtime/interpreter';
import {
  formatRuntimeValue, parsePokeInput, parsePokeInputForUnknown,
  pokeVariable, pokeMember, pokeChain, readChain, buildChainKey,
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

/**
 * Decoration for a chain expression (deeper-than-one-dot or
 * call-bearing). The pill renders right after the LAST segment of
 * the chain (so it sits visually after the closing `)` of a
 * trailing method call, or after the final `.member` name).
 *
 * `chainKey` is the runtime key the renderer uses for both reads
 * (via `readChain`) and pokes (via `pokeChain`) — pre-computed at
 * decoration time so the render pass doesn't re-derive it.
 *
 * `displayPath` is the human-readable form (e.g.
 * `XtsEnvironment.XpuTcIo(...).GetTrackCount(...)`) used in
 * tooltips.
 */
interface ChainPayload {
  kind: 'chain';
  /** Lowercased base variable name — for env lookup. */
  baseLower: string;
  /** Original-cased base name — for tooltips. */
  baseName: string;
  /** Stable runtime key for this chain shape (no base prefix). */
  chainKey: string;
  /** Display form for tooltips. */
  displayPath: string;
}

interface Decoration {
  /** 1-indexed column of the decoration's first character. */
  column: number;
  /** How many source characters this decoration spans. For
   *  VarRefs that's the identifier's length; for MemberExprs
   *  it's `object.length + 1 + member.length`. For ChainExprs we
   *  span only the last segment's identifier so the pill lands
   *  right after it — the base and any intermediate segments
   *  aren't decorated separately (avoids three pills competing
   *  for space on one line). */
  length: number;
  /** 1-indexed source line. */
  line: number;
  payload: VarPayload | MemberPayload | ChainPayload;
}

/** Identity of the variable / member / chain being edited in the
 *  inline editor. For bare unknowns and known scalars `memberLower`
 *  and `chainKey` are null. For unknown-FB member pokes the object
 *  is `nameLower` and the field is `memberLower`. For chain pokes
 *  the base is `nameLower` and `chainKey` is the segments key. */
interface EditingTarget {
  line: number;
  column: number;
  nameLower: string;
  /** null for bare-variable poke or chain poke, set for member poke. */
  memberLower: string | null;
  /** null for var/member pokes, set for chain pokes. */
  chainKey: string | null;
}

export function InlineSource({
  source, program, env, errorLine, envVersion, pokeEnabled,
}: InlineSourceProps) {
  const lines = source.split('\n');
  const decorations = collectDecorations(program, lines);

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
  sourceLines: string[],
): Map<number, Decoration[]> {
  const out = new Map<number, Decoration[]>();

  function add(d: Decoration) {
    const list = out.get(d.line);
    if (list) list.push(d);
    else out.set(d.line, [d]);
  }

  /**
   * True if `nameLower` is declared as STRING. Used by the
   * Assign-visit to drop the LHS-side pill on string-literal
   * assignments (`StatusSTRING := '...';`), which otherwise
   * displays the stale prior value next to the new literal —
   * pure noise on a state machine that re-assigns the same
   * variable many times.
   */
  function isStringTypedVar(nameLower: string): boolean {
    const v = program.program.vars.find(x => x.nameLower === nameLower);
    return v?.type.kind === 'scalar' && v.type.name === 'STRING';
  }

  /**
   * For a chain whose last segment is a method call, find the
   * column of the closing `)` so the pill renders right after it
   * rather than between the method name and its opening paren.
   *
   * Same idea for a trailing array-index segment: scan past `[…]`
   * to the column after `]`.
   *
   * Strategy: scan forward counting `(`/`)` (or `[`/`]`) from the
   * starting column, honouring nested matches. If the chain wraps
   * across lines (rare), we fall back to the column we started
   * scanning from — the pill will land slightly off, but at least
   * visibly tied to the chain.
   *
   * The returned column is 1-indexed and points at the column
   * AFTER the closing bracket — where the pill will be inserted.
   */
  function findColumnAfterMatchingClose(
    line: number, startCol: number, open: '(' | '[',
  ): number {
    const close = open === '(' ? ')' : ']';
    const lineText = sourceLines[line - 1] ?? '';
    let i = startCol - 1; // 0-indexed cursor
    // Skip whitespace until we hit the opening bracket.
    while (i < lineText.length && /\s/.test(lineText[i]!)) i++;
    if (lineText[i] !== open) return startCol;
    let depth = 0;
    for (; i < lineText.length; i++) {
      const ch = lineText[i];
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return i + 2; // +1 to 1-index, +1 to land AFTER
      }
    }
    // No matching close on this line — chain wraps. Pill at start.
    return startCol;
  }

  function visitChain(e: import('../runtime/ast').ChainExpr) {
    // Always visit args / indices first so inner pills exist
    // even if the outer chain pill couldn't be placed.
    for (const seg of e.segments) {
      if (seg.kind === 'method' || seg.kind === 'call') {
        for (const a of seg.args) {
          if (a.value) visitExpr(a.value);
          if (a.target) visitVarRef(a.target);
        }
      } else if (seg.kind === 'index') {
        for (const idx of seg.indices) visitExpr(idx);
      }
    }

    const lastSeg = e.segments[e.segments.length - 1]!;
    let column: number;
    let length: number;
    if (lastSeg.kind === 'method') {
      // Pill goes right after the closing `)`. Method segments
      // have `column` pointing at the method name; the `(` comes
      // right after the name (possibly with whitespace).
      column = findColumnAfterMatchingClose(
        lastSeg.line, lastSeg.column + lastSeg.name.length, '(',
      );
      length = 0;
    } else if (lastSeg.kind === 'call') {
      // 'call' segments carry the column of the `(` itself.
      column = findColumnAfterMatchingClose(
        lastSeg.line, lastSeg.column, '(',
      );
      length = 0;
    } else if (lastSeg.kind === 'index') {
      // Pill goes right after the closing `]`. Index segments
      // carry the column of the `[` itself.
      column = findColumnAfterMatchingClose(
        lastSeg.line, lastSeg.column, '[',
      );
      length = 0;
    } else {
      // Pill goes right after the last `.name`.
      column = lastSeg.column;
      length = lastSeg.name.length;
    }

    // Build the display path.
    let displayPath = e.base.name;
    for (const s of e.segments) {
      if (s.kind === 'method') displayPath += '.' + s.name + '(...)';
      else if (s.kind === 'call') displayPath += '(...)';
      else if (s.kind === 'index') displayPath += '[…]';
      else displayPath += '.' + s.name;
    }

    add({
      line: lastSeg.line,
      column,
      length,
      payload: {
        kind: 'chain',
        baseLower: e.base.nameLower,
        baseName: e.base.name,
        chainKey: buildChainKey(e.segments),
        displayPath,
      },
    });
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
      case 'Chain':
        visitChain(e);
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
      case 'Assign': {
        // The LHS-side pill is a "before" view of the variable
        // that's about to be overwritten. It's useful when the
        // RHS is a computation (you see what was there vs what's
        // going in), but pure noise for STRING literal assigns —
        // every `StatusSTRING := '...';` line would show the
        // same stale value next to the new literal, making the
        // user's eye flick back and forth.
        //
        // Skip the LHS pill in that one narrow case: RHS is a
        // STRING literal AND the LHS variable is declared STRING.
        // Numeric `InitialStep := 10;` patterns keep their LHS
        // pill — the CASE-state "what step am I on" reading is
        // genuinely useful there.
        const skipLhsPill =
          s.value.kind === 'Literal' &&
          s.value.litType === 'STRING' &&
          isStringTypedVar(s.target.nameLower);
        if (!skipLhsPill) visitVarRef(s.target);
        visitExpr(s.value);
        return;
      }
      case 'ChainAssign':
        // The LHS is a chain expression — emit its decoration
        // (which is anchored at its last segment) and walk the
        // RHS for any inner pills.
        visitChain(s.target);
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
  if (d.payload.kind === 'chain') {
    // Chain decorations always sit on an unknown base — that's
    // the whole point of the chain shape. Confirm anyway in case
    // the env got out of sync with the parsed program.
    const base = env.get(d.payload.baseLower);
    return base?.kind === 'unknown';
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
  pokeKind: 'scalar' | 'unknown-var' | 'unknown-member' | 'chain' | null;
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
        // No poked value: show the runtime's default (BOOL FALSE)
        // with muted styling. Matches the chain pill's policy
        // and reflects what evalExpr will actually return when
        // the runtime reads this variable.
        return {
          ...empty,
          formattedValue: 'FALSE',
          pillType: 'BOOL',
          isMissing: true,
          isBoolTrue: false,
          isUnknownTyped: true,
          pokeKind: 'unknown-var',
        };
      }
      const sv = v.scalarValue;
      return {
        formattedValue: formatRuntimeValue(sv),
        pillType: sv.type,
        isBoolTrue: sv.type === 'BOOL' && sv.value === true,
        // A stored defaulted value (`fromUnknownDefault`) renders
        // muted so the user sees "this isn't real" — same as the
        // chain pill.
        isMissing: sv.fromUnknownDefault === true,
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

  if (d.payload.kind === 'chain') {
    // Chain pill. The base must be unknown (the parser only
    // emits ChainExpr against unknown bases at runtime — see
    // evalChain). We read whatever was poked under the chain's
    // key. The chain key uniquely identifies this chain shape
    // across all its uses in the source, so a single poke applies
    // everywhere the same chain expression appears.
    //
    // No stored value? Show the runtime's default (BOOL FALSE)
    // with `isMissing` styling. This mirrors evalChain's policy:
    // unpoked chains default to FALSE; the user can click to
    // override. Previously the pill showed "?" and the runtime
    // halted on first read — that turned out to be unworkable
    // because Reset wiped pokes and the user couldn't progress.
    const stored = readChain(env, d.payload.baseLower, d.payload.chainKey);
    if (!stored) {
      return {
        ...empty,
        formattedValue: 'FALSE',
        pillType: 'BOOL',
        isMissing: true,
        isBoolTrue: false,
        isUnknownTyped: true,
        pokeKind: 'chain',
      };
    }
    // Poked or stored-defaulted value. `fromUnknownDefault` on
    // the stored value means "this came from a defaulted read
    // that was assigned through" — still show the value, but
    // keep the muted (isMissing) styling so the user knows it
    // isn't a real computed value.
    return {
      formattedValue: formatRuntimeValue(stored),
      pillType: stored.type,
      isBoolTrue: stored.type === 'BOOL' && stored.value === true,
      isMissing: stored.fromUnknownDefault === true,
      isUnknownTyped: true,
      pokeKind: 'chain',
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
      // Match the runtime default: BOOL FALSE, muted styling.
      return {
        ...empty,
        formattedValue: 'FALSE',
        pillType: 'BOOL',
        isMissing: true,
        isBoolTrue: false,
        isUnknownTyped: true,
        pokeKind: 'unknown-member',
      };
    }
    return {
      formattedValue: formatRuntimeValue(poked),
      pillType: poked.type,
      isBoolTrue: poked.type === 'BOOL' && poked.value === true,
      isMissing: poked.fromUnknownDefault === true,
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

  // Identify "is this pill being edited right now". The triple
  // (nameLower, memberLower, chainKey) uniquely identifies a poke
  // target across all three payload shapes:
  //   - var pill          → nameLower set, others null
  //   - unknown-member    → nameLower=base, memberLower=field, chainKey=null
  //   - chain pill        → nameLower=base, memberLower=null, chainKey=segments
  let editTargetNameLower: string;
  let editTargetMemberLower: string | null = null;
  let editTargetChainKey: string | null = null;
  if (d.payload.kind === 'var') {
    editTargetNameLower = d.payload.nameLower;
  } else if (d.payload.kind === 'member') {
    editTargetNameLower = d.payload.objectLower;
    if (data.pokeKind === 'unknown-member') {
      editTargetMemberLower = d.payload.memberLower;
    }
  } else {
    // chain
    editTargetNameLower = d.payload.baseLower;
    editTargetChainKey = d.payload.chainKey;
  }

  const isEditing =
    editing !== null && data.pokeKind !== null &&
    editing.line === lineNum &&
    editing.column === d.column &&
    editing.nameLower === editTargetNameLower &&
    editing.memberLower === editTargetMemberLower &&
    editing.chainKey === editTargetChainKey;

  if (isEditing) {
    return (
      <PillEditor
        key={key}
        nameLower={editTargetNameLower}
        memberLower={editTargetMemberLower}
        chainKey={editTargetChainKey}
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

  // BOOL pills support a double-click toggle. We allow toggling
  // even when `isMissing` (defaulted) is true — flipping a
  // defaulted FALSE to a real poked TRUE is the whole point of
  // the gesture, and it's what the user expects in a state
  // machine where most chain reads default to FALSE until
  // overridden. (Ship 1.1 marks defaulted values as isMissing
  // for the muted pill styling; that styling shouldn't lock the
  // toggle out.)
  const canToggleBool = canPoke && data.pillType === 'BOOL';

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
  } else if (d.payload.kind === 'member') {
    const obj = env.get(d.payload.objectLower);
    const typeLabel =
      obj?.kind === 'unknown'
        ? `member of ${obj.typeName} (unknown — poked value)`
        : data.pillType ?? '?';
    tooltip = `${d.payload.objectName}.${d.payload.memberName} : ${typeLabel}`;
  } else {
    // chain
    const base = env.get(d.payload.baseLower);
    const typeLabel =
      base?.kind === 'unknown'
        ? `result of chain on ${base.typeName} (unknown — poked value)`
        : data.pillType ?? '?';
    tooltip = `${d.payload.displayPath} : ${typeLabel}`;
  }
  if (canToggleBool) {
    tooltip += ' — double-click to toggle, click to edit';
  } else if (canPoke) {
    tooltip += ' — click to edit';
  }

  // Single-click vs double-click coordination.
  //
  // Browsers fire `click` BEFORE `dblclick`. If single-click
  // immediately opens the editor, the second click of a double-
  // click lands in the now-open input field (selecting its text)
  // and `dblclick` never gets to toggle the value. The user sees
  // "I have to double-click to toggle, but double-click just
  // opens the editor" — which is exactly the bug.
  //
  // Fix: defer the single-click's editor-open by ~250ms (slightly
  // longer than the OS double-click threshold). If a `dblclick`
  // arrives in that window, we cancel the pending open and toggle
  // instead. If no dblclick arrives, the pending open fires.
  //
  // The timer ID lives at module scope (see PENDING_CLICK at the
  // bottom of this file) because only one click can be pending
  // at a time across the whole UI, and putting it there avoids
  // needing per-render refs in this stateless helper.
  const handleClick = canPoke
    ? () => {
        clearPendingClick();
        // If this pill supports double-click toggle, defer the
        // editor-open so a dblclick can pre-empt it. For pills
        // that DON'T toggle (non-BOOL or non-pokeable), open
        // immediately — no point making the user wait.
        if (canToggleBool) {
          PENDING_CLICK.id = window.setTimeout(() => {
            PENDING_CLICK.id = null;
            setEditing({
              line: lineNum,
              column: d.column,
              nameLower: editTargetNameLower,
              memberLower: editTargetMemberLower,
              chainKey: editTargetChainKey,
            });
          }, 250);
        } else {
          setEditing({
            line: lineNum,
            column: d.column,
            nameLower: editTargetNameLower,
            memberLower: editTargetMemberLower,
            chainKey: editTargetChainKey,
          });
        }
      }
    : undefined;

  // Double-click handler: BOOL pills toggle directly. Routed
  // through the matching poke API (pokeVariable / pokeMember /
  // pokeChain) so unknown BOOLs, chain BOOLs, and known scalar
  // BOOLs all toggle the same way. Defaulted BOOLs (from the
  // Ship 1.1 default-FALSE policy) are first-class targets here
  // — toggling a defaulted FALSE to a poked TRUE is the typical
  // way the user drives the simulation past a CASE branch's
  // gating chain read.
  const handleDoubleClick = canToggleBool
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Pre-empt the pending single-click open. Without this
        // the editor would open after the timer expires, on top
        // of the toggle that just succeeded — confusing UI.
        clearPendingClick();
        const flipped = !data.isBoolTrue;
        const newVal: ScalarValue = {
          kind: 'scalar', type: 'BOOL', value: flipped,
        };
        let success = false;
        if (data.pokeKind === 'chain') {
          success = pokeChain(env, editTargetNameLower, editTargetChainKey!, newVal);
        } else if (data.pokeKind === 'unknown-member') {
          const result = pokeMember(env, editTargetNameLower, editTargetMemberLower!, newVal, 0);
          success = result.ok;
        } else {
          const result = pokeVariable(env, editTargetNameLower, newVal, 0);
          success = result.ok;
        }
        if (success) {
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

export function PillEditor({
  nameLower, memberLower, chainKey, pokeKind, currentText, env, onCommit,
}: {
  nameLower: string;
  memberLower: string | null;
  /** Set when poking a chain expression; null otherwise. */
  chainKey: string | null;
  pokeKind: 'scalar' | 'unknown-var' | 'unknown-member' | 'chain';
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
  // parsePokeInput — for unknowns and chains we use the inference
  // parser and there's no declared type to check.
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
    // Route to the matching poke API. Chain pokes use pokeChain
    // with the pre-built segment key; unknown-member pokes use
    // pokeMember; everything else uses pokeVariable.
    if (pokeKind === 'chain') {
      const ok = pokeChain(env, nameLower, chainKey!, parsed.value);
      if (!ok) {
        setError(`base "${nameLower}" is no longer an unknown FB instance`);
        return;
      }
      onCommit(true);
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

  // Tooltip differs by poke kind. Chains get a `…` shorthand
  // since the full segment list would be noisy in a tooltip.
  const tooltipBase =
    pokeKind === 'scalar'
      ? `${nameLower} : ${targetType}`
      : pokeKind === 'unknown-member'
        ? `${nameLower}.${memberLower} : (unknown — type inferred from input)`
        : pokeKind === 'chain'
          ? `${nameLower}.… : (unknown — type inferred from input)`
          : `${nameLower} : (unknown — type inferred from input)`;

  // ARIA label — chain pokes label by the chain key (lowercased
  // segment shape) so screen readers say something meaningful.
  const ariaLabel =
    pokeKind === 'chain'
      ? `Edit ${nameLower}.${chainKey}`
      : `Edit ${nameLower}${memberLower ? '.' + memberLower : ''}`;

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
        aria-label={ariaLabel}
      />
    </span>
  );
}

export function formatTimeForPill(ms: number): string {
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

/**
 * Module-scope holder for the deferred-single-click timer.
 *
 * Single-click on a toggleable BOOL pill schedules the editor-
 * open on this timer. Double-click clears it (and toggles the
 * value instead). Storing the timer at module scope is fine
 * because only one click can be pending at a time across the
 * whole inline-source UI — multiple simultaneous pending clicks
 * would only happen on multi-touch, which isn't a target use
 * case for the desktop sandbox.
 *
 * `id` is a `window.setTimeout` return value (number in the DOM
 * type, but TypeScript's lib.dom types it as `number` already).
 */
const PENDING_CLICK: { id: number | null } = { id: null };

function clearPendingClick(): void {
  if (PENDING_CLICK.id !== null) {
    window.clearTimeout(PENDING_CLICK.id);
    PENDING_CLICK.id = null;
  }
}
