/**
 * Tree-walking interpreter for the v1 ST subset.
 *
 * Pure logic — no React, no DOM. The modal calls runScan() each
 * tick of the scan loop and reads back the environment to render
 * inline pills.
 *
 * Execution model:
 *   - createEnvironment(program) seeds the variable map with each
 *     declared variable's initial value (running its init
 *     expression if non-trivial) or the type's default value.
 *   - runScan(parsedProgram, env) walks the body statement list
 *     top-to-bottom once and mutates env. Throws StRuntimeError
 *     on division-by-zero, unknown built-in, or type mismatch.
 *
 * Numeric semantics — what we promised:
 *   - Integer overflow on assignment WRAPS (matching TwinCAT).
 *     UDINT 0xFFFFFFFF + 1 → 0. INT 32767 + 1 → -32768.
 *   - Integer division truncates toward zero. 7 / 2 = 3, -7 / 2 = -3.
 *   - Real arithmetic uses raw JS numbers — IEEE 754 semantics,
 *     1.0 / 0.0 = Infinity (no exception, matches TwinCAT's
 *     lenient mode).
 *   - Mixed binop: if EITHER operand is REAL/LREAL, promote both
 *     to JS number and do the op as a real. Otherwise stay in
 *     the integer domain (BigInt-promoted if either is 64-bit).
 *   - Bitwise operators on integers; logical on BOOLs. AND/OR/XOR
 *     dispatch on operand kind at the call site.
 *
 * Control flow:
 *   - EXIT, CONTINUE, RETURN are thrown sentinels. The catching
 *     loop / function body re-raises if not its kind.
 *   - RETURN outside a program body just stops the current scan
 *     gracefully (we have no functions in v1).
 *   - EXIT outside a loop is a no-op-ish: it propagates up to the
 *     scan boundary and terminates the scan early, with a console
 *     warning. Same for CONTINUE.
 *
 * What's deliberately missing in v1:
 *   - User-defined functions / function blocks
 *   - Arrays, structs, enums, pointers
 *   - String operations beyond literal assignment
 *   - TIME arithmetic beyond ms-addition
 *   - Latching of inputs at scan-start / outputs at scan-end
 *     (we just walk top-to-bottom)
 */

import type {
  ParsedProgram, Statement, Expr, BinaryOp,
  CaseLabel, ScalarTypeName, FbTypeName, CallArg, MemberExpr,
  VarRefExpr,
} from './ast';
import { StRuntimeError } from './errors';
import { TYPE_META, type TypeMeta } from './types';

// --- Value representation --------------------------------------

/**
 * A scalar value: type tag plus its JS-side storage.
 *
 * Integers ≤32 bit and reals are stored as JS `number`.
 * Integers ≥64 bit (LWORD/LINT/ULINT) use `bigint`.
 * BOOL → `boolean`. STRING → `string`. TIME → `number` (ms).
 *
 * The `type` tag on a value carries through arithmetic so we know
 * what to coerce back to on assignment. Mixed arithmetic produces
 * intermediate values whose type tag reflects the wider operand
 * (the "result type" — real if either is real, etc).
 */
export interface ScalarValue {
  kind: 'scalar';
  type: ScalarTypeName;
  value: number | bigint | boolean | string;
}

/**
 * An FB instance — opaque from the rest of the interpreter's
 * perspective; the only operations are "call it" (`tickFb`) and
 * "read a member" (`readFbMember`). The internal `state` shape
 * varies per fbType and is owned by the matching tickFb function.
 */
export interface FbInstance {
  kind: 'fb';
  fbType: FbTypeName;
  state: Record<string, unknown>;
}

/**
 * An "unknown-typed" runtime value — for variables whose declared
 * type the v1 runtime doesn't have a schema for (user-defined FBs,
 * structs, enums, anything not a built-in scalar or known FB).
 *
 * The runtime treats these as poke-only:
 *   - The body never executes any tick logic for them. Calls in
 *     the body to an unknown FB instance silently no-op.
 *   - The user can poke a value into the bare variable
 *     (`UnknownVar` itself), which lands in `scalarValue`.
 *   - The user can poke values into individual members
 *     (`UnknownVar.Foo`), which land in the `members` map.
 *   - Reads of a bare variable or member return whatever was
 *     last poked, or a "missing" sentinel if nothing yet.
 *
 * The type of a poked value is **inferred from the syntax of the
 * user's input** — `TRUE` / `FALSE` becomes BOOL, `T#1s` becomes
 * TIME, `3.14` becomes LREAL, `42` becomes DINT, `'foo'` becomes
 * STRING. Once inferred, the type is stored alongside the value,
 * so the pill renders with the right styling on subsequent scans
 * (BOOLs as filled blue/black, etc.) and double-click toggle
 * works on inferred-BOOL members the same as declared BOOLs.
 *
 * `typeName` is the original-cased type identifier from the
 * declaration, kept for tooltips like
 * `MyTimer : FB_ValueRanges (unknown)`.
 */
export interface UnknownInstance {
  kind: 'unknown';
  typeName: string;
  /** Value poked directly into the bare variable. null if never
   *  poked (read-back yields the missing sentinel). */
  scalarValue: ScalarValue | null;
  /** Member-name (lowercased) → poked value. */
  members: Map<string, ScalarValue>;
}

/** Anything storable in the env. */
export type RuntimeValue = ScalarValue | FbInstance | UnknownInstance;

export type Environment = Map<string, RuntimeValue>;

// Tag-helpers — the interpreter pre-Ship-C didn't have a `kind`
// discriminator on values; so a lot of code constructed
// `{ type, value }` literals. With FB instances added we now
// require the discriminator. These tiny helpers keep the rest
// of the file readable.
function scalar(type: ScalarTypeName, value: ScalarValue['value']): ScalarValue {
  return { kind: 'scalar', type, value };
}

function asScalar(v: RuntimeValue, line: number, ctx: string): ScalarValue {
  if (v.kind === 'fb') {
    throw new StRuntimeError(
      'type-mismatch', line,
      `${ctx}: expected a scalar value, got an FB instance (type ${v.fbType})`,
    );
  }
  if (v.kind === 'unknown') {
    // An unknown-typed bare variable doesn't have a value until
    // the user pokes one. Reading before poking is reported as
    // a type mismatch so the user sees what's missing — we don't
    // want to silently feed a default into the surrounding
    // expression and have it produce a misleading result.
    if (v.scalarValue === null) {
      throw new StRuntimeError(
        'type-mismatch', line,
        `${ctx}: variable of unknown type "${v.typeName}" has no value yet — double-click or click the pill to poke one`,
      );
    }
    return v.scalarValue;
  }
  return v;
}

// --- Sentinels for control flow -------------------------------

class ExitSignal {}
class ContinueSignal {}
class ReturnSignal {}

const EXIT = new ExitSignal();
const CONT = new ContinueSignal();
const RET = new ReturnSignal();

// --- Public API ------------------------------------------------

/**
 * Per-scan execution context. Threaded through every exec/eval
 * call so state that's purely about THIS scan (statement budget,
 * scan time for timers) doesn't leak via the env (which is
 * persistent across scans).
 *
 * - `env`         — variable storage, persistent.
 * - `scanTimeMs`  — wall-clock-style time the runtime sees this
 *                   scan, in milliseconds. Increments by the
 *                   cycle interval per scan; pauses while the
 *                   user has Stop pressed; reset by the modal's
 *                   Reset button. TON / TOF read this for
 *                   elapsed-time calculations.
 * - `budgetLeft`  — statements remaining before the per-scan
 *                   budget kicks in. Decrements each statement;
 *                   throws StRuntimeError('execution-budget')
 *                   when it hits zero. Reset to MAX_BUDGET each
 *                   scan.
 */
interface ScanContext {
  env: Environment;
  scanTimeMs: number;
  budgetLeft: number;
}

const MAX_BUDGET = 100_000;

/**
 * Build a fresh environment from the program declaration. Each
 * variable starts at:
 *   - for scalars: its evaluated initial expression, or the
 *     type's default value
 *   - for FB instances: a fresh state object (no init expression
 *     allowed, the parser rejects `MyTimer : TON := ...`)
 *
 * Initial expressions can reference earlier-declared variables —
 * the env is populated declaration-order, so `b : INT := a + 1;`
 * works iff `a` was declared above. (Matches TwinCAT.)
 *
 * Throws StRuntimeError if any initial expression fails (e.g.
 * div-by-zero in an init). Unlikely but possible.
 */
export function createEnvironment(program: ParsedProgram): Environment {
  const env: Environment = new Map();
  // Init expressions evaluate in a no-budget, time=0 context.
  // That's fine — inits are simple expressions, never loops.
  const initCtx: ScanContext = { env, scanTimeMs: 0, budgetLeft: MAX_BUDGET };

  for (const v of program.program.vars) {
    if (v.type.kind === 'fb') {
      env.set(v.nameLower, makeFbInstance(v.type.name));
      continue;
    }
    if (v.type.kind === 'unknown') {
      // Unknown-typed: empty container. Reads return "missing"
      // until the user pokes something in.
      env.set(v.nameLower, {
        kind: 'unknown',
        typeName: v.type.unknownName,
        scalarValue: null,
        members: new Map(),
      });
      continue;
    }
    // Scalar.
    if (v.initial) {
      const value = evalExpr(v.initial, initCtx);
      env.set(v.nameLower, coerceTo(value, v.type.name, v.line));
    } else {
      const meta = TYPE_META[v.type.name];
      env.set(v.nameLower, scalar(v.type.name, meta.defaultValue));
    }
  }
  return env;
}

/**
 * Run one full scan of the program body. Mutates env in place.
 * Throws StRuntimeError on any runtime fault — caller stops the
 * scan loop and reports.
 *
 * The caller is responsible for tracking scan time across calls
 * and passing the new value here. Cleanest approach in the modal
 * is `scanTimeMs += cycleMs` per Run-tick, frozen during Stop,
 * back to 0 on Reset.
 *
 * EXIT or CONTINUE that propagates up to the scan boundary
 * terminates the current scan early without an error (a stray
 * EXIT outside a loop is poor practice but not a crime).
 */
export function runScan(
  program: ParsedProgram, env: Environment, scanTimeMs: number,
): void {
  const ctx: ScanContext = {
    env,
    scanTimeMs,
    budgetLeft: MAX_BUDGET,
  };
  try {
    execStatements(program.body, ctx);
  } catch (sig) {
    if (sig instanceof ExitSignal || sig instanceof ContinueSignal ||
        sig instanceof ReturnSignal) {
      // Stray loop-control signals at the scan boundary — silently
      // end this scan. Not an error.
      return;
    }
    throw sig;
  }
}

// --- Statement execution ---------------------------------------

function execStatements(stmts: Statement[], ctx: ScanContext): void {
  for (const s of stmts) {
    execStatement(s, ctx);
  }
}

function execStatement(s: Statement, ctx: ScanContext): void {
  // Per-scan statement budget. Decrements before each statement;
  // hitting zero throws StRuntimeError. Reset to MAX_BUDGET each
  // scan in runScan(), so a long-running program with many small
  // scans is fine — only one *individual* scan can be infinite.
  if (--ctx.budgetLeft < 0) {
    throw new StRuntimeError(
      'internal', s.line,
      `execution budget exceeded (${MAX_BUDGET} statements per scan) — likely infinite loop`,
    );
  }

  switch (s.kind) {
    case 'Assign': {
      const value = evalExpr(s.value, ctx);
      const targetVar = ctx.env.get(s.target.nameLower);
      if (!targetVar) {
        throw new StRuntimeError(
          'internal', s.line,
          `internal: unknown variable "${s.target.name}" at runtime`,
        );
      }
      if (targetVar.kind === 'fb') {
        throw new StRuntimeError(
          'type-mismatch', s.line,
          `cannot assign to FB instance "${s.target.name}" — call it instead`,
        );
      }
      if (targetVar.kind === 'unknown') {
        // Unknown-typed target: store the RHS scalar as-is.
        // Whatever type the expression evaluated to becomes the
        // current type of the unknown variable. The pill will
        // render with that type's styling on the next render.
        const sv = asScalar(value, s.line, `assignment to ${s.target.name}`);
        ctx.env.set(s.target.nameLower, {
          ...targetVar,
          scalarValue: { kind: 'scalar', type: sv.type, value: sv.value },
        });
        return;
      }
      const coerced = coerceTo(value, targetVar.type, s.line);
      ctx.env.set(s.target.nameLower, coerced);
      return;
    }

    case 'If': {
      for (const branch of s.branches) {
        if (branch.condition === null) {
          execStatements(branch.body, ctx);
          return;
        }
        const cond = evalExpr(branch.condition, ctx);
        if (truthy(cond, branch.condition.line)) {
          execStatements(branch.body, ctx);
          return;
        }
      }
      return;
    }

    case 'Case': {
      const sel = evalExpr(s.selector, ctx);
      const selN = toIntForCase(sel, s.line);
      let matchedBranch = false;
      for (const branch of s.branches) {
        if (branch.labels.length === 0) continue;
        if (caseLabelsMatch(branch.labels, selN, ctx)) {
          execStatements(branch.body, ctx);
          matchedBranch = true;
          break;
        }
      }
      if (!matchedBranch) {
        const elseBranch = s.branches.find((b) => b.labels.length === 0);
        if (elseBranch) execStatements(elseBranch.body, ctx);
      }
      return;
    }

    case 'For': {
      const startV = evalExpr(s.start, ctx);
      const endV = evalExpr(s.end, ctx);
      const stepV: ScalarValue = s.step
        ? asScalar(evalExpr(s.step, ctx), s.line, 'FOR step')
        : scalar('INT', 1);

      const startN = toIntForLoop(startV, s.line);
      const endN = toIntForLoop(endV, s.line);
      const stepN = toIntForLoop(stepV, s.line);

      if (stepN === 0n) {
        throw new StRuntimeError(
          'internal', s.line,
          'FOR loop step cannot be zero',
        );
      }

      const loopVarStored = ctx.env.get(s.loopVar.nameLower);
      if (!loopVarStored) {
        throw new StRuntimeError(
          'internal', s.line,
          `internal: loop variable "${s.loopVar.name}" not in env`,
        );
      }
      if (loopVarStored.kind === 'fb') {
        throw new StRuntimeError(
          'type-mismatch', s.line,
          `FOR loop variable cannot be an FB instance`,
        );
      }
      if (loopVarStored.kind === 'unknown') {
        // Permissive: a FOR loop over an unknown-typed variable
        // treats it like a DINT for stepping purposes. Each
        // iteration writes the loop value through as a DINT
        // scalar; the user can still poke a different value
        // mid-loop and the next iteration overwrites it.
        // Unusual to have an unknown loop var, but no reason to
        // forbid it.
        const ascending = stepN > 0n;
        let i = startN;
        while (ascending ? i <= endN : i >= endN) {
          const iValue: ScalarValue = scalar('DINT', Number(i));
          const cur = ctx.env.get(s.loopVar.nameLower);
          if (cur && cur.kind === 'unknown') {
            ctx.env.set(s.loopVar.nameLower, { ...cur, scalarValue: iValue });
          }
          try {
            execStatements(s.body, ctx);
          } catch (sig) {
            if (sig instanceof ExitSignal) return;
            if (sig instanceof ContinueSignal) {
              // Fall through to the increment.
            } else {
              throw sig;
            }
          }
          i += stepN;
        }
        return;
      }
      const targetType = loopVarStored.type;

      const ascending = stepN > 0n;
      let i = startN;
      while (ascending ? i <= endN : i >= endN) {
        const iValue: ScalarValue = { kind: 'scalar', type: 'LINT', value: i };
        ctx.env.set(s.loopVar.nameLower, coerceTo(iValue, targetType, s.line));

        try {
          execStatements(s.body, ctx);
        } catch (sig) {
          if (sig instanceof ExitSignal) return;
          if (sig instanceof ContinueSignal) {
            // Fall through to the increment.
          } else {
            throw sig;
          }
        }
        i += stepN;
      }
      return;
    }

    case 'While': {
      while (true) {
        const c = evalExpr(s.condition, ctx);
        if (!truthy(c, s.condition.line)) return;
        try {
          execStatements(s.body, ctx);
        } catch (sig) {
          if (sig instanceof ExitSignal) return;
          if (sig instanceof ContinueSignal) continue;
          throw sig;
        }
      }
    }

    case 'Repeat': {
      while (true) {
        try {
          execStatements(s.body, ctx);
        } catch (sig) {
          if (sig instanceof ExitSignal) return;
          if (sig instanceof ContinueSignal) {
            // Fall through to UNTIL check.
          } else {
            throw sig;
          }
        }
        const c = evalExpr(s.until, ctx);
        if (truthy(c, s.until.line)) return;
      }
    }

    case 'Exit': throw EXIT;
    case 'Continue': throw CONT;
    case 'Return': throw RET;

    case 'ExpressionStmt': {
      // FB calls are written as expression statements:
      //   `MyTimer(IN := bStart, PT := T#1s);`
      // The Call evaluation handles the FB tick + output bindings.
      // Plain function-call expressions also pass through here;
      // their return value is discarded.
      evalExpr(s.expression, ctx);
      return;
    }
  }
}

// --- CASE label matching --------------------------------------

function caseLabelsMatch(
  labels: CaseLabel[], selN: bigint, ctx: ScanContext,
): boolean {
  for (const lab of labels) {
    const lo = toIntForCase(evalExpr(lab.low, ctx), 0);
    const hi = lab.kind === 'Range'
      ? toIntForCase(evalExpr(lab.high, ctx), 0)
      : lo;
    if (selN >= lo && selN <= hi) return true;
  }
  return false;
}

// --- Expression evaluation ------------------------------------

function evalExpr(e: Expr, ctx: ScanContext): RuntimeValue {
  switch (e.kind) {
    case 'Literal': {
      switch (e.litType) {
        case 'INT':
          return scalar('DINT', Number(e.value));
        case 'REAL':
          return scalar('REAL', Number(e.value));
        case 'BOOL':
          return scalar('BOOL', Boolean(e.value));
        case 'STRING':
          return scalar('STRING', String(e.value));
        case 'TIME':
          return scalar('TIME', Number(e.value));
      }
      throw new StRuntimeError('internal', e.line, 'unknown literal type');
    }

    case 'VarRef': {
      const v = ctx.env.get(e.nameLower);
      if (!v) {
        throw new StRuntimeError(
          'internal', e.line,
          `internal: unknown variable "${e.name}" at runtime`,
        );
      }
      // FB instances aren't directly readable — referencing one
      // by name (without `.member` or call parens) is a runtime
      // error. We catch this in evalExpr because the parser
      // doesn't have type info.
      if (v.kind === 'fb') {
        throw new StRuntimeError(
          'type-mismatch', e.line,
          `cannot read FB instance "${e.name}" directly — call it or read .member`,
        );
      }
      // Unknown-typed bare variable: if the user has poked a
      // value, return it. Otherwise we surface a clear runtime
      // error rather than feed a default — silent zero-out
      // would mask problems in the user's logic.
      if (v.kind === 'unknown') {
        if (v.scalarValue === null) {
          throw new StRuntimeError(
            'type-mismatch', e.line,
            `variable "${e.name}" of unknown type "${v.typeName}" has no value yet — click its pill to poke one`,
          );
        }
        return scalar(v.scalarValue.type, v.scalarValue.value);
      }
      // Copy so downstream mutation doesn't leak.
      return scalar(v.type, v.value);
    }

    case 'Member':
      return evalMember(e, ctx);

    case 'Unary':
      return evalUnary(e.op, evalExpr(e.operand, ctx), e.line);

    case 'Binary':
      return evalBinary(
        e.op,
        evalExpr(e.left, ctx),
        evalExpr(e.right, ctx),
        e.line,
      );

    case 'Call':
      return evalCall(e.nameLower, e.name, e.args, e.line, ctx);
  }
}

function evalMember(e: MemberExpr, ctx: ScanContext): RuntimeValue {
  const v = ctx.env.get(e.object.nameLower);
  if (!v) {
    throw new StRuntimeError(
      'internal', e.line,
      `internal: unknown variable "${e.object.name}" at runtime`,
    );
  }
  if (v.kind === 'unknown') {
    // Unknown-typed member access: read whatever's been poked
    // into this member, or surface a clear error if nothing has.
    // Same policy as bare unknowns — no silent defaulting.
    const poked = v.members.get(e.memberLower);
    if (!poked) {
      throw new StRuntimeError(
        'type-mismatch', e.line,
        `member "${e.object.name}.${e.member}" of unknown type "${v.typeName}" has no value yet — click its pill to poke one`,
      );
    }
    return scalar(poked.type, poked.value);
  }
  if (v.kind !== 'fb') {
    throw new StRuntimeError(
      'type-mismatch', e.line,
      `cannot read member ".${e.member}" on non-FB variable "${e.object.name}"`,
    );
  }
  return readFbMember(v, e.memberLower, e.member, e.line);
}

function evalUnary(
  op: 'NOT' | 'NEG' | 'POS', operandIn: RuntimeValue, line: number,
): ScalarValue {
  const operand = asScalar(operandIn, line, `unary ${op}`);
  switch (op) {
    case 'NOT':
      if (operand.type === 'BOOL') {
        return scalar('BOOL', !(operand.value as boolean));
      }
      // Bitwise NOT on integers
      if (typeof operand.value === 'bigint') {
        return scalar(operand.type, ~operand.value);
      }
      if (typeof operand.value === 'number') {
        return scalar(operand.type, ~operand.value);
      }
      throw new StRuntimeError(
        'type-mismatch', line,
        `NOT applied to ${operand.type}`,
      );
    case 'NEG':
      if (typeof operand.value === 'bigint') {
        return scalar(operand.type, -operand.value);
      }
      if (typeof operand.value === 'number') {
        return scalar(operand.type, -operand.value);
      }
      throw new StRuntimeError(
        'type-mismatch', line,
        `unary minus applied to ${operand.type}`,
      );
    case 'POS':
      // Unary plus is a no-op
      return operand;
  }
}

function evalBinary(
  op: BinaryOp, lIn: RuntimeValue, rIn: RuntimeValue, line: number,
): ScalarValue {
  const l = asScalar(lIn, line, 'binary op left');
  const r = asScalar(rIn, line, 'binary op right');

  // Boolean logical ops on BOOLs
  if (l.type === 'BOOL' && r.type === 'BOOL' &&
      (op === 'AND' || op === 'OR' || op === 'XOR')) {
    const a = l.value as boolean;
    const b = r.value as boolean;
    let out: boolean;
    if (op === 'AND') out = a && b;
    else if (op === 'OR') out = a || b;
    else out = a !== b;
    return scalar('BOOL', out);
  }

  // Comparison
  if (op === 'EQ' || op === 'NE' || op === 'LT' ||
      op === 'LE' || op === 'GT' || op === 'GE') {
    return scalar('BOOL', compareValues(op, l, r, line));
  }

  // Numeric arithmetic / bitwise.
  if (l.type === 'REAL' || l.type === 'LREAL' ||
      r.type === 'REAL' || r.type === 'LREAL') {
    const a = toNumberFromAny(l, line);
    const b = toNumberFromAny(r, line);
    return realArith(op, a, b, line);
  }

  // Both integer.
  const lIsBig = TYPE_META[l.type].repr === 'bigint';
  const rIsBig = TYPE_META[r.type].repr === 'bigint';
  if (lIsBig || rIsBig) {
    const a = toBigInt(l, line);
    const b = toBigInt(r, line);
    return bigIntArith(op, a, b, widerType(l.type, r.type), line);
  }
  const a = l.value as number;
  const b = r.value as number;
  return numberArith(op, a, b, widerType(l.type, r.type), line);
}

// --- Arithmetic implementations --------------------------------

function realArith(
  op: BinaryOp, a: number, b: number, line: number,
): ScalarValue {
  switch (op) {
    case 'ADD': return scalar('REAL', a + b);
    case 'SUB': return scalar('REAL', a - b);
    case 'MUL': return scalar('REAL', a * b);
    case 'DIV':
      return scalar('REAL', a / b);
    case 'MOD':
      if (b === 0) {
        throw new StRuntimeError('div-by-zero', line, 'MOD by zero');
      }
      return scalar('REAL', a % b);
    case 'POW': return scalar('REAL', a ** b);
    default:
      throw new StRuntimeError(
        'type-mismatch', line,
        `operator "${op}" not valid on real numbers`,
      );
  }
}

function numberArith(
  op: BinaryOp, a: number, b: number,
  resultType: ScalarTypeName, line: number,
): ScalarValue {
  switch (op) {
    case 'ADD': return scalar(resultType, a + b);
    case 'SUB': return scalar(resultType, a - b);
    case 'MUL': return scalar(resultType, a * b);
    case 'DIV':
      if (b === 0) {
        throw new StRuntimeError('div-by-zero', line, 'integer division by zero');
      }
      return scalar(resultType, Math.trunc(a / b));
    case 'MOD':
      if (b === 0) {
        throw new StRuntimeError('div-by-zero', line, 'MOD by zero');
      }
      return scalar(resultType, a % b);
    case 'POW': return scalar(resultType, a ** b);
    case 'AND': return scalar(resultType, (a & b) >>> 0);
    case 'OR':  return scalar(resultType, (a | b) >>> 0);
    case 'XOR': return scalar(resultType, (a ^ b) >>> 0);
    default:
      throw new StRuntimeError(
        'type-mismatch', line,
        `operator "${op}" not valid here`,
      );
  }
}

function bigIntArith(
  op: BinaryOp, a: bigint, b: bigint,
  resultType: ScalarTypeName, line: number,
): ScalarValue {
  switch (op) {
    case 'ADD': return scalar(resultType, a + b);
    case 'SUB': return scalar(resultType, a - b);
    case 'MUL': return scalar(resultType, a * b);
    case 'DIV':
      if (b === 0n) {
        throw new StRuntimeError('div-by-zero', line, 'integer division by zero');
      }
      return scalar(resultType, a / b);
    case 'MOD':
      if (b === 0n) {
        throw new StRuntimeError('div-by-zero', line, 'MOD by zero');
      }
      return scalar(resultType, a % b);
    case 'POW':
      if (b < 0n) {
        throw new StRuntimeError(
          'type-mismatch', line,
          'integer ** with negative exponent — use REAL',
        );
      }
      return scalar(resultType, a ** b);
    case 'AND': return scalar(resultType, a & b);
    case 'OR':  return scalar(resultType, a | b);
    case 'XOR': return scalar(resultType, a ^ b);
    default:
      throw new StRuntimeError(
        'type-mismatch', line,
        `operator "${op}" not valid here`,
      );
  }
}

function compareValues(
  op: BinaryOp, l: ScalarValue, r: ScalarValue, line: number,
): boolean {
  if (l.type === 'STRING' || r.type === 'STRING') {
    if (l.type !== 'STRING' || r.type !== 'STRING') {
      throw new StRuntimeError(
        'type-mismatch', line,
        `cannot compare STRING to ${l.type === 'STRING' ? r.type : l.type}`,
      );
    }
    return cmpPrimitive(op, l.value as string, r.value as string);
  }

  if (l.type === 'BOOL' && r.type === 'BOOL') {
    if (op === 'EQ') return l.value === r.value;
    if (op === 'NE') return l.value !== r.value;
    throw new StRuntimeError(
      'type-mismatch', line,
      `BOOLs only support = and <> (got ${op})`,
    );
  }

  const aBig = TYPE_META[l.type].repr === 'bigint';
  const bBig = TYPE_META[r.type].repr === 'bigint';
  if (aBig || bBig) {
    const a = toBigInt(l, line);
    const b = toBigInt(r, line);
    return cmpPrimitive(op, a, b);
  }
  const a = toNumberFromAny(l, line);
  const b = toNumberFromAny(r, line);
  return cmpPrimitive(op, a, b);
}

function cmpPrimitive<T extends number | bigint | string>(
  op: BinaryOp, a: T, b: T,
): boolean {
  switch (op) {
    case 'EQ': return a === b;
    case 'NE': return a !== b;
    case 'LT': return a < b;
    case 'LE': return a <= b;
    case 'GT': return a > b;
    case 'GE': return a >= b;
    default: return false;
  }
}

// --- Type coercion --------------------------------------------

/**
 * Coerce `value` into the target type slot. This is where wrap
 * semantics live for integer assignments.
 *
 * Cases:
 *   - target BOOL: source must be BOOL (no implicit int→bool).
 *   - target REAL/LREAL: number domain, JS number stored as-is.
 *   - target integer: take the integer value (BigInt or number),
 *     mod into the type's range. Two's-complement for signed.
 *   - target STRING: source must be STRING.
 *   - target TIME: source must be TIME (no implicit ms→time).
 */
function coerceTo(
  valueIn: RuntimeValue, target: ScalarTypeName, line: number,
): ScalarValue {
  const value = asScalar(valueIn, line, `assign to ${target}`);
  const meta = TYPE_META[target];

  if (target === 'BOOL') {
    if (value.type === 'BOOL') {
      return scalar('BOOL', value.value as boolean);
    }
    // Accept integer 0 / 1 as FALSE / TRUE. TwinCAT permits this
    // and people lean on it routinely (`bDone := 1;`). We stay
    // STRICT on other integer values: `bDone := 2` is rejected
    // rather than silently treated as TRUE — fewer ambiguous
    // bugs, and the user can write `<> 0` if that's what they
    // actually mean.
    if (typeof value.value === 'number' || typeof value.value === 'bigint') {
      const n = typeof value.value === 'bigint'
        ? value.value
        : BigInt(Math.trunc(value.value as number));
      if (n === 0n) return scalar('BOOL', false);
      if (n === 1n) return scalar('BOOL', true);
      throw new StRuntimeError(
        'type-mismatch', line,
        `cannot assign ${value.value} to BOOL — only 0 / 1 / FALSE / TRUE are accepted`,
      );
    }
    throw new StRuntimeError(
      'type-mismatch', line,
      `cannot assign ${value.type} to BOOL`,
    );
  }

  if (target === 'STRING') {
    if (value.type !== 'STRING') {
      throw new StRuntimeError(
        'type-mismatch', line,
        `cannot assign ${value.type} to STRING`,
      );
    }
    return scalar('STRING', value.value as string);
  }

  if (target === 'TIME') {
    if (value.type !== 'TIME') {
      // Allow integer → TIME if it's a positive number-of-ms.
      if (typeof value.value === 'number') {
        return scalar('TIME', Math.max(0, Math.trunc(value.value)));
      }
      throw new StRuntimeError(
        'type-mismatch', line,
        `cannot assign ${value.type} to TIME`,
      );
    }
    return scalar('TIME', value.value as number);
  }

  if (target === 'REAL' || target === 'LREAL') {
    const n = toNumberFromAny(value, line);
    return scalar(target, n);
  }

  // Target is integer.
  if (value.type === 'BOOL') {
    throw new StRuntimeError(
      'type-mismatch', line,
      `cannot assign BOOL to ${target}`,
    );
  }
  if (value.type === 'STRING') {
    throw new StRuntimeError(
      'type-mismatch', line,
      `cannot assign STRING to ${target}`,
    );
  }

  let asBig: bigint;
  if (typeof value.value === 'bigint') {
    asBig = value.value;
  } else if (typeof value.value === 'number') {
    asBig = BigInt(Math.trunc(value.value));
  } else {
    throw new StRuntimeError('type-mismatch', line, 'expected number');
  }

  const wrapped = wrapToRange(asBig, meta);

  if (meta.repr === 'bigint') {
    return scalar(target, wrapped);
  }
  return scalar(target, Number(wrapped));
}

function wrapToRange(value: bigint, meta: TypeMeta): bigint {
  if (meta.min === null || meta.max === null) return value;
  const range = meta.max - meta.min + 1n;
  const v = ((value - meta.min) % range + range) % range + meta.min;
  return v;
}

// --- Helpers ---------------------------------------------------

function widerType(a: ScalarTypeName, b: ScalarTypeName): ScalarTypeName {
  const ma = TYPE_META[a];
  const mb = TYPE_META[b];
  if (ma.repr === 'bigint' || mb.repr === 'bigint') {
    if (ma.signed || mb.signed) return 'LINT';
    return 'ULINT';
  }
  if (ma.bits >= mb.bits) return a;
  return b;
}

function toNumberFromAny(vIn: RuntimeValue, line: number): number {
  const v = asScalar(vIn, line, 'numeric conversion');
  if (typeof v.value === 'number') return v.value;
  if (typeof v.value === 'bigint') return Number(v.value);
  if (typeof v.value === 'boolean') return v.value ? 1 : 0;
  throw new StRuntimeError(
    'type-mismatch', line,
    `cannot convert ${v.type} to a number`,
  );
}

function toBigInt(vIn: RuntimeValue, line: number): bigint {
  const v = asScalar(vIn, line, 'integer conversion');
  if (typeof v.value === 'bigint') return v.value;
  if (typeof v.value === 'number') return BigInt(Math.trunc(v.value));
  throw new StRuntimeError(
    'type-mismatch', line,
    `cannot convert ${v.type} to integer`,
  );
}

function toIntForCase(vIn: RuntimeValue, line: number): bigint {
  const v = asScalar(vIn, line, 'CASE selector');
  if (v.type === 'REAL' || v.type === 'LREAL') {
    throw new StRuntimeError(
      'type-mismatch', line,
      'CASE selector must be integer, not REAL',
    );
  }
  return toBigInt(v, line);
}

function toIntForLoop(vIn: RuntimeValue, line: number): bigint {
  const v = asScalar(vIn, line, 'FOR loop bound');
  if (v.type === 'REAL' || v.type === 'LREAL') {
    throw new StRuntimeError(
      'type-mismatch', line,
      'FOR loop bounds must be integer, not REAL',
    );
  }
  return toBigInt(v, line);
}

function truthy(vIn: RuntimeValue, line: number): boolean {
  const v = asScalar(vIn, line, 'condition');
  if (v.type === 'BOOL') return v.value as boolean;
  throw new StRuntimeError(
    'type-mismatch', line,
    `condition must be BOOL, got ${v.type}`,
  );
}

// --- Built-in functions ----------------------------------------
//
// Built-ins are pure: take `ScalarValue` args, return one
// `ScalarValue`. They never touch the env, never throw control-
// flow signals. The dispatcher `evalCall` handles the FB-instance
// case BEFORE looking in this table, so a user variable named
// `MyTimer` of type TON shadows any built-in with the same name
// (matters in theory, not in practice for v1's built-in list).

type Builtin = (args: ScalarValue[], line: number) => ScalarValue;

const BUILTINS: Map<string, Builtin> = new Map();

function reg(name: string, fn: Builtin): void {
  BUILTINS.set(name.toLowerCase(), fn);
}

/** Coerce a scalar value to either a number or a bigint, whichever
 *  representation it natively uses. Strings/booleans throw. */
function asNumOrBig(v: ScalarValue, line: number): number | bigint {
  if (typeof v.value === 'bigint') return v.value;
  if (typeof v.value === 'number') return v.value;
  throw new StRuntimeError(
    'type-mismatch', line,
    `expected a number, got ${v.type}`,
  );
}

reg('abs', (args, line) => {
  if (args.length !== 1) {
    throw new StRuntimeError('type-mismatch', line, 'ABS expects 1 argument');
  }
  const v = args[0];
  const n = asNumOrBig(v, line);
  if (typeof n === 'bigint') return scalar(v.type, n < 0n ? -n : n);
  return scalar(v.type, Math.abs(n));
});

reg('min', (args, line) => {
  if (args.length < 2) {
    throw new StRuntimeError('type-mismatch', line, 'MIN expects at least 2 arguments');
  }
  return args.reduce((acc, v) => {
    const a = asNumOrBig(acc, line);
    const b = asNumOrBig(v, line);
    if (typeof a === 'bigint' || typeof b === 'bigint') {
      const aBig = typeof a === 'bigint' ? a : BigInt(Math.trunc(a));
      const bBig = typeof b === 'bigint' ? b : BigInt(Math.trunc(b));
      return aBig < bBig ? acc : v;
    }
    return a < b ? acc : v;
  });
});

reg('max', (args, line) => {
  if (args.length < 2) {
    throw new StRuntimeError('type-mismatch', line, 'MAX expects at least 2 arguments');
  }
  return args.reduce((acc, v) => {
    const a = asNumOrBig(acc, line);
    const b = asNumOrBig(v, line);
    if (typeof a === 'bigint' || typeof b === 'bigint') {
      const aBig = typeof a === 'bigint' ? a : BigInt(Math.trunc(a));
      const bBig = typeof b === 'bigint' ? b : BigInt(Math.trunc(b));
      return aBig > bBig ? acc : v;
    }
    return a > b ? acc : v;
  });
});

reg('limit', (args, line) => {
  if (args.length !== 3) {
    throw new StRuntimeError('type-mismatch', line, 'LIMIT expects 3 arguments (MIN, value, MAX)');
  }
  const [lo, v, hi] = args;
  const loN = asNumOrBig(lo, line);
  const vN = asNumOrBig(v, line);
  const hiN = asNumOrBig(hi, line);
  if (typeof vN === 'bigint') {
    const loB = typeof loN === 'bigint' ? loN : BigInt(Math.trunc(loN));
    const hiB = typeof hiN === 'bigint' ? hiN : BigInt(Math.trunc(hiN));
    let r = vN;
    if (r < loB) r = loB;
    if (r > hiB) r = hiB;
    return scalar(v.type, r);
  }
  let r = vN;
  const loF = typeof loN === 'bigint' ? Number(loN) : loN;
  const hiF = typeof hiN === 'bigint' ? Number(hiN) : hiN;
  if (r < loF) r = loF;
  if (r > hiF) r = hiF;
  return scalar(v.type, r);
});

reg('sel', (args, line) => {
  if (args.length !== 3) {
    throw new StRuntimeError('type-mismatch', line, 'SEL expects 3 arguments (G, IN0, IN1)');
  }
  const [g, in0, in1] = args;
  if (g.type !== 'BOOL') {
    throw new StRuntimeError('type-mismatch', line, 'SEL first argument must be BOOL');
  }
  return (g.value as boolean) ? in1 : in0;
});

// Bit shifts
reg('shl', (args, line) => bitShift('SHL', args, line));
reg('shr', (args, line) => bitShift('SHR', args, line));
reg('rol', (args, line) => bitShift('ROL', args, line));
reg('ror', (args, line) => bitShift('ROR', args, line));

function bitShift(
  op: 'SHL' | 'SHR' | 'ROL' | 'ROR',
  args: ScalarValue[], line: number,
): ScalarValue {
  if (args.length !== 2) {
    throw new StRuntimeError('type-mismatch', line, `${op} expects 2 arguments`);
  }
  const [v, n] = args;
  const meta = TYPE_META[v.type];
  if (meta.repr !== 'number' && meta.repr !== 'bigint') {
    throw new StRuntimeError('type-mismatch', line, `${op} not valid on ${v.type}`);
  }
  const shift = Number(asNumOrBig(n, line));
  const bits = meta.bits || 32;
  if (typeof v.value === 'bigint') {
    const mask = (1n << BigInt(bits)) - 1n;
    const x = v.value & mask;
    let r: bigint;
    switch (op) {
      case 'SHL': r = (x << BigInt(shift)) & mask; break;
      case 'SHR': r = (x >> BigInt(shift)) & mask; break;
      case 'ROL': {
        const s = shift % bits;
        r = ((x << BigInt(s)) | (x >> BigInt(bits - s))) & mask;
        break;
      }
      case 'ROR': {
        const s = shift % bits;
        r = ((x >> BigInt(s)) | (x << BigInt(bits - s))) & mask;
        break;
      }
    }
    return scalar(v.type, r);
  }
  const x = (v.value as number) & ((bits >= 32 ? 0xFFFFFFFF : (1 << bits) - 1));
  let r: number;
  switch (op) {
    case 'SHL': r = (x << shift) >>> 0; break;
    case 'SHR': r = x >>> shift; break;
    case 'ROL': {
      const s = shift % bits;
      r = ((x << s) | (x >>> (bits - s))) >>> 0;
      break;
    }
    case 'ROR': {
      const s = shift % bits;
      r = ((x >>> s) | (x << (bits - s))) >>> 0;
      break;
    }
  }
  return scalar(v.type, r);
}

// Type conversions: register all <X>_TO_<Y> combos for the
// numeric types. STRING ↔ numeric and TIME ↔ numeric are NOT
// auto-registered — those edge cases would lie about behaviour
// in v1.
const NUMERIC_TYPES: ScalarTypeName[] = [
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
  'SINT', 'INT', 'DINT', 'LINT',
  'USINT', 'UINT', 'UDINT', 'ULINT',
  'REAL', 'LREAL',
];
for (const from of NUMERIC_TYPES) {
  for (const to of NUMERIC_TYPES) {
    if (from === to) continue;
    const fnName = `${from}_TO_${to}`;
    reg(fnName, (args, line) => {
      if (args.length !== 1) {
        throw new StRuntimeError('type-mismatch', line, `${fnName} expects 1 argument`);
      }
      const v = args[0];
      // BOOL→numeric: false=0, true=1.
      if (v.type === 'BOOL') {
        return coerceTo(scalar('INT', (v.value as boolean) ? 1 : 0), to, line);
      }
      if (to === 'BOOL') {
        // Numeric→BOOL: 0 = false, anything else = true.
        const n = asNumOrBig(v, line);
        const isTrue = typeof n === 'bigint' ? n !== 0n : n !== 0;
        return scalar('BOOL', isTrue);
      }
      return coerceTo(v, to, line);
    });
  }
}

// --- FB instances --------------------------------------------
//
// Each built-in FB type has:
//   - an `init` that produces a fresh state object
//   - a `tick` that runs one cycle, given the input args (after
//     dropping into named-arg form) and the scan time
//   - a `members` table mapping output names to type+accessor
//
// Adding a new built-in FB is: extend FbTypeName in ast.ts, add
// to FB_TYPES in types.ts, register here.

interface FbSchema {
  /** Make the empty state object for a freshly-declared instance. */
  init(): Record<string, unknown>;
  /** Run one tick. `args` is the named-arg map collected from the
   *  call site; only the FB's known input names are read. Mutates
   *  `state`. `scanTimeMs` is the runtime's wall-clock-style time
   *  for this scan, used by TON/TOF for elapsed-time tracking. */
  tick(
    state: Record<string, unknown>,
    args: Map<string, ScalarValue>,
    scanTimeMs: number,
    line: number,
  ): void;
  /** Members the user may read via `instance.member`. */
  members: Record<string, FbMember>;
}

interface FbMember {
  /** Output's scalar type for the read result. */
  type: ScalarTypeName;
  /** Pull the typed value out of the state object. */
  read(state: Record<string, unknown>): ScalarValue['value'];
}

const FB_SCHEMAS: Record<FbTypeName, FbSchema> = {
  /**
   * TON — On-delay timer. Inputs:
   *   IN  : BOOL  — when TRUE, start (or continue) timing
   *   PT  : TIME  — preset time (ms)
   * Outputs:
   *   Q   : BOOL  — TRUE once elapsed time has reached PT (and IN
   *                 is still TRUE)
   *   ET  : TIME  — current elapsed time, capped at PT
   *
   * Behaviour: while IN is TRUE, ET counts up from 0 to PT in real
   * time. Once ET == PT, Q latches TRUE. When IN goes FALSE, ET
   * resets to 0 and Q clears. Matches IEC 61131-3.
   *
   * State carries `startedAtMs`: scan time at which IN went TRUE.
   * Each tick recomputes ET = currentScanTime - startedAtMs (or
   * resets if IN is FALSE). This means a Stop/Run pause doesn't
   * advance the timer because scan time itself is paused.
   */
  TON: {
    init: () => ({
      q: false,
      et: 0,
      prevIn: false,
      startedAtMs: 0,
    }),
    tick(state, args, scanTimeMs, line) {
      const inV = args.get('in');
      const ptV = args.get('pt');
      if (!inV) {
        throw new StRuntimeError(
          'type-mismatch', line,
          'TON requires IN := <BOOL>',
        );
      }
      if (!ptV) {
        throw new StRuntimeError(
          'type-mismatch', line,
          'TON requires PT := <TIME>',
        );
      }
      if (inV.type !== 'BOOL') {
        throw new StRuntimeError(
          'type-mismatch', line, 'TON.IN must be BOOL',
        );
      }
      if (ptV.type !== 'TIME') {
        // Strict: PT must be a TIME literal (T#…). The earlier
        // permissive "accept a bare integer as ms" path was a
        // foot-gun — `PT := 10000` looked plausible but didn't
        // match the IEC 61131-3 spec or TwinCAT, where PT is
        // declared as TIME and only TIME values flow into it.
        throw new StRuntimeError(
          'type-mismatch', line,
          'TON.PT must be TIME (e.g. T#1s, T#500ms)',
        );
      }
      const inB = inV.value as boolean;
      const pt = Math.max(0, Math.trunc(ptV.value as number));

      if (inB) {
        if (!state.prevIn) {
          // Rising edge — start timing.
          state.startedAtMs = scanTimeMs;
        }
        const elapsed = Math.max(0, scanTimeMs - (state.startedAtMs as number));
        const et = Math.min(elapsed, pt);
        state.et = et;
        state.q = elapsed >= pt;
      } else {
        // IN low — reset.
        state.et = 0;
        state.q = false;
      }
      state.prevIn = inB;
    },
    members: {
      q:  { type: 'BOOL', read: (s) => s.q as boolean },
      et: { type: 'TIME', read: (s) => s.et as number },
    },
  },

  /**
   * TOF — Off-delay timer. Inputs/outputs as TON, but the timing
   * is on the *falling* edge:
   *   - While IN is TRUE: Q is TRUE, ET is 0.
   *   - On falling edge: ET starts counting up from 0.
   *   - While ET < PT: Q stays TRUE.
   *   - When ET reaches PT: Q goes FALSE, ET capped at PT.
   *   - Rising edge mid-timeout: ET resets to 0, Q goes/stays TRUE.
   */
  TOF: {
    init: () => ({
      q: false,
      et: 0,
      prevIn: false,
      stoppedAtMs: 0,
    }),
    tick(state, args, scanTimeMs, line) {
      const inV = args.get('in');
      const ptV = args.get('pt');
      if (!inV || inV.type !== 'BOOL') {
        throw new StRuntimeError(
          'type-mismatch', line, 'TOF requires IN := <BOOL>',
        );
      }
      if (!ptV || ptV.type !== 'TIME') {
        throw new StRuntimeError(
          'type-mismatch', line, 'TOF.PT must be TIME (e.g. T#1s, T#500ms)',
        );
      }
      const inB = inV.value as boolean;
      const pt = Math.max(0, Math.trunc(ptV.value as number));

      if (inB) {
        // High — Q follows IN immediately, ET resets to 0.
        state.q = true;
        state.et = 0;
      } else {
        if (state.prevIn) {
          // Falling edge — start the off-delay timer.
          state.stoppedAtMs = scanTimeMs;
        }
        const elapsed = Math.max(0, scanTimeMs - (state.stoppedAtMs as number));
        const et = Math.min(elapsed, pt);
        state.et = et;
        // Q goes FALSE only once ET has reached PT.
        state.q = elapsed < pt;
      }
      state.prevIn = inB;
    },
    members: {
      q:  { type: 'BOOL', read: (s) => s.q as boolean },
      et: { type: 'TIME', read: (s) => s.et as number },
    },
  },

  /**
   * R_TRIG — Rising-edge detector. One scan of Q=TRUE on every
   * 0→1 transition of CLK; otherwise Q=FALSE.
   *
   * State: just the previous CLK value.
   */
  R_TRIG: {
    init: () => ({ q: false, prevClk: false }),
    tick(state, args, _scanTimeMs, line) {
      const clkV = args.get('clk');
      if (!clkV || clkV.type !== 'BOOL') {
        throw new StRuntimeError(
          'type-mismatch', line, 'R_TRIG requires CLK := <BOOL>',
        );
      }
      const clk = clkV.value as boolean;
      state.q = clk && !(state.prevClk as boolean);
      state.prevClk = clk;
    },
    members: {
      q: { type: 'BOOL', read: (s) => s.q as boolean },
    },
  },

  /**
   * F_TRIG — Falling-edge detector. Mirror of R_TRIG.
   */
  F_TRIG: {
    init: () => ({ q: false, prevClk: false }),
    tick(state, args, _scanTimeMs, line) {
      const clkV = args.get('clk');
      if (!clkV || clkV.type !== 'BOOL') {
        throw new StRuntimeError(
          'type-mismatch', line, 'F_TRIG requires CLK := <BOOL>',
        );
      }
      const clk = clkV.value as boolean;
      state.q = !clk && (state.prevClk as boolean);
      state.prevClk = clk;
    },
    members: {
      q: { type: 'BOOL', read: (s) => s.q as boolean },
    },
  },
};

/** Construct a fresh FB instance for the env. */
function makeFbInstance(fbType: FbTypeName): FbInstance {
  const schema = FB_SCHEMAS[fbType];
  if (!schema) {
    throw new StRuntimeError(
      'internal', 0,
      `internal: no schema for FB type ${fbType}`,
    );
  }
  return { kind: 'fb', fbType, state: schema.init() };
}

/** Read a member from an FB instance, e.g. `MyTimer.Q`. */
function readFbMember(
  inst: FbInstance, memberLower: string, memberOriginal: string, line: number,
): ScalarValue {
  const schema = FB_SCHEMAS[inst.fbType];
  const m = schema.members[memberLower];
  if (!m) {
    const valid = Object.keys(schema.members).map((k) => k.toUpperCase()).join(', ');
    throw new StRuntimeError(
      'type-mismatch', line,
      `unknown member ".${memberOriginal}" on ${inst.fbType} — try one of: ${valid}`,
    );
  }
  return scalar(m.type, m.read(inst.state));
}

// --- Call dispatcher -----------------------------------------

/**
 * Top-level call evaluator. Decides whether `name(...)` is:
 *
 *   1. An FB-instance call — `name` resolves in env to an FB
 *      instance. Args must all be named (`IN := bX`, possibly
 *      `Q => bDone` for output bindings). The instance ticks.
 *      Return value is BOOL TRUE (matches ST: an FB call as an
 *      expression returns the FB's first output, but for v1 we
 *      always return TRUE — bare-statement form is the common
 *      use case and the return value is discarded).
 *
 *   2. A built-in function — looked up in BUILTINS. Args must
 *      all be positional (named-args on built-ins are silently
 *      ignored — IEC allows it but our table doesn't model
 *      parameter names).
 *
 * Unknown names produce a runtime error.
 */
function evalCall(
  nameLower: string, originalName: string,
  args: CallArg[], line: number, ctx: ScanContext,
): RuntimeValue {
  const targetVar = ctx.env.get(nameLower);
  if (targetVar && targetVar.kind === 'fb') {
    return tickFbCall(targetVar, originalName, args, line, ctx);
  }
  if (targetVar && targetVar.kind === 'unknown') {
    // Unknown FB-instance call: silently no-op. We don't have a
    // schema, so we can't tick state or compute outputs. Args
    // are NOT evaluated — that means side effects in arg
    // expressions don't fire either. This is the simplest rule
    // and the one least likely to surprise the user: a greyed-
    // out call line means "this entire statement is on hold; the
    // user drives it via pokes". Statement budget still
    // decrements (handled by the caller in execStatement) so an
    // infinite loop containing only unknown calls still
    // terminates.
    return scalar('BOOL', true);
  }

  // Built-in path. Reject named args (we don't model parameter
  // names for built-ins — using `:=` here is a likely bug).
  const positional: ScalarValue[] = [];
  for (const a of args) {
    if (a.kind !== 'positional') {
      throw new StRuntimeError(
        'type-mismatch', line,
        `function "${originalName}" doesn't accept named arguments`,
      );
    }
    if (!a.value) {
      throw new StRuntimeError(
        'internal', line,
        `internal: positional arg has no value`,
      );
    }
    const v = evalExpr(a.value, ctx);
    positional.push(asScalar(v, line, `argument to ${originalName}`));
  }
  const fn = BUILTINS.get(nameLower);
  if (!fn) {
    throw new StRuntimeError(
      'unknown-builtin', line,
      `unknown function "${originalName}" (v1 supports a small set of built-ins — see modal docs)`,
    );
  }
  return fn(positional, line);
}

/**
 * Run an FB instance for one tick from a call site. Reads named
 * inputs, applies the schema's tick, then copies outputs to any
 * `OUTPUT => target` bindings.
 *
 * Returns a sentinel BOOL TRUE — FB calls as expressions are
 * unusual in v1; they're nearly always statement-level, where the
 * return value is discarded.
 */
function tickFbCall(
  inst: FbInstance, originalName: string, args: CallArg[],
  line: number, ctx: ScanContext,
): ScalarValue {
  const inputs = new Map<string, ScalarValue>();
  const outputBindings: Array<{ paramLower: string; target: VarRefExpr; line: number }> = [];

  for (const a of args) {
    if (a.kind === 'positional') {
      throw new StRuntimeError(
        'type-mismatch', a.line,
        `FB instance "${originalName}" requires named arguments (e.g. IN := <expr>)`,
      );
    }
    if (a.kind === 'named-in') {
      if (!a.value) {
        throw new StRuntimeError('internal', a.line, 'internal: named-in arg has no value');
      }
      const v = asScalar(evalExpr(a.value, ctx), a.line, `argument ${a.name}`);
      inputs.set(a.nameLower, v);
    } else {
      // named-out — `target` may be null when the user wrote
      // `Q =>` with nothing after (TwinCAT allows this; the
      // output is named but not bound). Skip the post-call copy
      // for that case.
      if (a.target) {
        outputBindings.push({ paramLower: a.nameLower, target: a.target, line: a.line });
      }
    }
  }

  const schema = FB_SCHEMAS[inst.fbType];
  schema.tick(inst.state, inputs, ctx.scanTimeMs, line);

  // Copy outputs to bound variables. `Q => bDone` is equivalent
  // to a post-call `bDone := MyTimer.Q;`.
  for (const ob of outputBindings) {
    const m = schema.members[ob.paramLower];
    if (!m) {
      const valid = Object.keys(schema.members).map((k) => k.toUpperCase()).join(', ');
      throw new StRuntimeError(
        'type-mismatch', ob.line,
        `unknown output "${ob.paramLower.toUpperCase()}" on ${inst.fbType} — try one of: ${valid}`,
      );
    }
    const outV = scalar(m.type, m.read(inst.state));
    const targetVar = ctx.env.get(ob.target.nameLower);
    if (!targetVar) {
      throw new StRuntimeError(
        'internal', ob.line,
        `internal: unknown output target "${ob.target.name}"`,
      );
    }
    if (targetVar.kind === 'fb') {
      throw new StRuntimeError(
        'type-mismatch', ob.line,
        `cannot bind FB output to FB instance "${ob.target.name}"`,
      );
    }
    if (targetVar.kind === 'unknown') {
      // Bind into an unknown-typed target — store the FB output
      // value as the unknown's current scalar value, with the
      // FB-output's type. The pill will pick up the type and
      // render with the right styling.
      ctx.env.set(ob.target.nameLower, {
        ...targetVar,
        scalarValue: { kind: 'scalar', type: outV.type, value: outV.value },
      });
      continue;
    }
    ctx.env.set(ob.target.nameLower, coerceTo(outV, targetVar.type, ob.line));
  }

  return scalar('BOOL', true);
}

// --- Display helpers ------------------------------------------

/**
 * Render a runtime value the way TwinCAT's online view does:
 *   BOOL → "TRUE" / "FALSE"
 *   ints → decimal
 *   reals → JS toString (good enough for v1)
 *   STRING → quoted with single quotes
 *   TIME → "T#1s500ms"-style
 *   FB instance → "<TON>" or similar tag — pills don't render
 *                 for FB instances (the instance has no single
 *                 value), but error formatting may need to print
 *                 one.
 */
export function formatRuntimeValue(v: RuntimeValue): string {
  if (v.kind === 'fb') return `<${v.fbType}>`;
  if (v.kind === 'unknown') {
    if (v.scalarValue === null) return `<${v.typeName}?>`;
    return formatRuntimeValue(v.scalarValue);
  }
  switch (v.type) {
    case 'BOOL': return (v.value as boolean) ? 'TRUE' : 'FALSE';
    case 'STRING': return `'${v.value as string}'`;
    case 'TIME': return formatTime(v.value as number);
    case 'REAL':
    case 'LREAL':
      return (v.value as number).toString();
    default: {
      if (typeof v.value === 'bigint') return v.value.toString();
      return Math.trunc(v.value as number).toString();
    }
  }
}

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

// --- Variable poking (mid-run state edits from the UI) -------

/**
 * Parse a user-typed value string into a ScalarValue of the
 * given target type. Returns either a parsed value or an error
 * message; never throws.
 *
 * Accepted formats:
 *   BOOL    — TRUE/FALSE/true/false/1/0 (case-insensitive)
 *   integer — decimal (123, -45) or hex (16#FF) or binary
 *             (2#1010); underscores allowed
 *   real    — 1.5, 3.14e-2, etc.
 *   STRING  — anything; if surrounded by single quotes they're
 *             stripped, otherwise the raw input is used
 *   TIME    — same syntax as a TIME literal: T#1s, T#100ms,
 *             T#1h30m. A bare integer is interpreted as ms.
 *
 * The parsed value is then coerce-wrapped to the target type
 * via the same coerceTo path that assignments use, so a BYTE
 * receiving 256 gets clamped/wrapped per ST semantics.
 */
export function parsePokeInput(
  raw: string, targetType: ScalarTypeName,
): { ok: true; value: ScalarValue } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'empty value' };
  }

  try {
    if (targetType === 'BOOL') {
      const low = trimmed.toLowerCase();
      if (low === 'true' || low === '1') {
        return { ok: true, value: scalar('BOOL', true) };
      }
      if (low === 'false' || low === '0') {
        return { ok: true, value: scalar('BOOL', false) };
      }
      return { ok: false, error: 'expected TRUE / FALSE / 1 / 0' };
    }

    if (targetType === 'STRING') {
      let s = trimmed;
      if ((s.startsWith("'") && s.endsWith("'")) ||
          (s.startsWith('"') && s.endsWith('"'))) {
        s = s.slice(1, -1);
      }
      return { ok: true, value: scalar('STRING', s) };
    }

    if (targetType === 'TIME') {
      // Accept T#... or a bare integer (ms).
      let body = trimmed;
      const upper = body.toUpperCase();
      if (upper.startsWith('T#')) {
        body = body.slice(2);
        const ms = parseTimeBody(body);
        if (ms == null) return { ok: false, error: 'malformed TIME literal' };
        return { ok: true, value: scalar('TIME', ms) };
      }
      if (upper.startsWith('TIME#')) {
        body = body.slice(5);
        const ms = parseTimeBody(body);
        if (ms == null) return { ok: false, error: 'malformed TIME literal' };
        return { ok: true, value: scalar('TIME', ms) };
      }
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        return { ok: false, error: 'expected T#... or a number of ms' };
      }
      return { ok: true, value: scalar('TIME', Math.max(0, Math.trunc(n))) };
    }

    if (targetType === 'REAL' || targetType === 'LREAL') {
      const n = Number(trimmed.replace(/_/g, ''));
      if (!Number.isFinite(n)) return { ok: false, error: 'not a number' };
      return { ok: true, value: scalar(targetType, n) };
    }

    // Integer types.
    const cleaned = trimmed.replace(/_/g, '');
    let asBig: bigint;
    const baseMatch = cleaned.match(/^(-?)(2|8|16)#([0-9a-fA-F]+)$/);
    if (baseMatch) {
      const sign = baseMatch[1] === '-' ? -1n : 1n;
      const base = parseInt(baseMatch[2], 10);
      const digits = baseMatch[3];
      asBig = sign * BigInt('0' + (base === 2 ? 'b' : base === 8 ? 'o' : 'x') + digits);
    } else {
      // Decimal (allow leading sign).
      if (!/^-?\d+$/.test(cleaned)) {
        return { ok: false, error: 'expected an integer' };
      }
      asBig = BigInt(cleaned);
    }
    const meta = TYPE_META[targetType];
    const wrapped = wrapToRange(asBig, meta);
    if (meta.repr === 'bigint') {
      return { ok: true, value: scalar(targetType, wrapped) };
    }
    return { ok: true, value: scalar(targetType, Number(wrapped)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Re-parse a TIME literal body like "1h30m500ms" into ms. Mirrors
 * the lexer's parseTimeLiteral but kept local to avoid coupling
 * the poke path to the lexer's internal API. Returns null on
 * malformed input.
 */
function parseTimeBody(body: string): number | null {
  if (body.length === 0) return null;
  let i = 0;
  const n = body.length;
  let totalMs = 0;
  while (i < n) {
    let num = '';
    while (i < n && (body[i] >= '0' && body[i] <= '9' || body[i] === '.')) {
      num += body[i];
      i++;
    }
    let suffix = '';
    while (i < n && !(body[i] >= '0' && body[i] <= '9')) {
      suffix += body[i].toLowerCase();
      i++;
    }
    if (num.length === 0 || suffix.length === 0) return null;
    const v = parseFloat(num);
    let mul: number;
    switch (suffix) {
      case 'ms': mul = 1; break;
      case 's':  mul = 1000; break;
      case 'm':  mul = 60 * 1000; break;
      case 'h':  mul = 60 * 60 * 1000; break;
      case 'd':  mul = 24 * 60 * 60 * 1000; break;
      default: return null;
    }
    totalMs += v * mul;
  }
  return Math.round(totalMs);
}

/**
 * Apply a parsed poke to the env. The variable may be:
 *   - A known scalar — value is coerced to the declared type
 *     (so a BYTE receiving 9999 wraps to 9999 mod 256).
 *   - An unknown-typed bare variable — value is stored as-is
 *     with whatever type the parsed input has. The "type
 *     inference from input syntax" lives in parsePokeInputForUnknown
 *     (the caller picks parsePokeInput vs parsePokeInputForUnknown
 *     based on whether the variable's type is known).
 *   - An FB instance — rejected; FB instances aren't directly
 *     pokeable. Use pokeMember for FB outputs (also rejected for
 *     known FBs since their members are derived).
 */
export function pokeVariable(
  env: Environment, nameLower: string, value: ScalarValue, line: number,
): { ok: true } | { ok: false; error: string } {
  const v = env.get(nameLower);
  if (!v) return { ok: false, error: `unknown variable "${nameLower}"` };
  if (v.kind === 'fb') {
    return { ok: false, error: `cannot poke FB instance "${nameLower}"` };
  }
  try {
    if (v.kind === 'unknown') {
      // Store the value as the unknown's current scalar — type
      // inferred from what the user typed (already done by the
      // caller, who chose parsePokeInputForUnknown). No coerce:
      // there's no declared type to coerce to.
      env.set(nameLower, {
        ...v,
        scalarValue: { kind: 'scalar', type: value.type, value: value.value },
      });
      return { ok: true };
    }
    const coerced = coerceTo(value, v.type, line);
    env.set(nameLower, coerced);
    return { ok: true };
  } catch (e) {
    if (e instanceof StRuntimeError) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Poke a value into a member of an unknown-typed variable.
 *
 * Used for things like `MyUnknownFb.SomeOutput := <value>` from
 * the inline editor when the user clicks an unknown-FB member
 * pill. Rejected for known FBs since their members are derived
 * from the tick function and would be overwritten next scan
 * anyway.
 *
 * Like pokeVariable for unknowns: the value's type is taken as-is
 * (the caller has already inferred it via parsePokeInputForUnknown).
 */
export function pokeMember(
  env: Environment, objectNameLower: string, memberLower: string,
  value: ScalarValue, _line: number,
): { ok: true } | { ok: false; error: string } {
  const v = env.get(objectNameLower);
  if (!v) return { ok: false, error: `unknown variable "${objectNameLower}"` };
  if (v.kind === 'fb') {
    return {
      ok: false,
      error: `cannot poke member of known FB "${objectNameLower}" — its outputs are computed each scan`,
    };
  }
  if (v.kind !== 'unknown') {
    return {
      ok: false,
      error: `"${objectNameLower}" is not an FB or unknown-typed instance`,
    };
  }
  // We can't structurally clone the Map cheaply in plain JS land,
  // so we just mutate it. The env reference itself is unchanged
  // — that's fine because the version-bump in the modal forces
  // a re-render.
  v.members.set(memberLower, {
    kind: 'scalar', type: value.type, value: value.value,
  });
  return { ok: true };
}

/**
 * Parse poke input for an unknown-typed variable, inferring the
 * value's type from the syntax of what the user typed.
 *
 * Inference rules (checked in this order, first match wins):
 *
 *   1. TRUE / FALSE / true / false                → BOOL
 *   2. Quoted: 'foo' or "foo"                     → STRING
 *   3. Time literal: T#1s, TIME#…, t#100ms        → TIME
 *   4. Number with `.` or `e` exponent            → LREAL
 *   5. Hex / oct / bin (16#FF, 2#1010, 8#777)     → DINT
 *   6. Plain integer (signed)                     → DINT
 *
 * Anything else is treated as an unquoted STRING. This is
 * permissive on purpose — the unknown-poke flow is "user wants
 * to drive a thing without telling us what type it is", and
 * it's easier to forgive ambiguous input than to bounce it.
 *
 * Returned ScalarValue is suitable to pass into pokeVariable /
 * pokeMember on an unknown-typed target.
 */
export function parsePokeInputForUnknown(
  raw: string,
): { ok: true; value: ScalarValue } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'empty value' };
  }

  // 1. BOOL
  const low = trimmed.toLowerCase();
  if (low === 'true')  return { ok: true, value: scalar('BOOL', true)  };
  if (low === 'false') return { ok: true, value: scalar('BOOL', false) };

  // 2. Quoted string
  if ((trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)) {
    return { ok: true, value: scalar('STRING', trimmed.slice(1, -1)) };
  }

  // 3. TIME literal
  const upper = trimmed.toUpperCase();
  if (upper.startsWith('T#') || upper.startsWith('TIME#')) {
    const body = trimmed.slice(upper.startsWith('TIME#') ? 5 : 2);
    const ms = parseTimeBody(body);
    if (ms != null) {
      return { ok: true, value: scalar('TIME', ms) };
    }
    // Falls through to "treat as string" below — better than
    // erroring; the user can re-poke if they really meant TIME.
  }

  // Hex / oct / bin
  const cleaned = trimmed.replace(/_/g, '');
  const baseMatch = cleaned.match(/^(-?)(2|8|16)#([0-9a-fA-F]+)$/);
  if (baseMatch) {
    try {
      const sign = baseMatch[1] === '-' ? -1n : 1n;
      const base = parseInt(baseMatch[2], 10);
      const digits = baseMatch[3];
      const big = sign * BigInt('0' + (base === 2 ? 'b' : base === 8 ? 'o' : 'x') + digits);
      // DINT range; if it's too big we could promote but the
      // unknown-poke flow doesn't care that much. JS Number
      // handles it fine for display either way.
      return { ok: true, value: scalar('DINT', Number(big)) };
    } catch {
      // Falls through.
    }
  }

  // 4. Real (has `.` or scientific `e`)
  if (/[.eE]/.test(cleaned)) {
    const n = Number(cleaned);
    if (Number.isFinite(n)) {
      return { ok: true, value: scalar('LREAL', n) };
    }
  }

  // 5. Plain integer
  if (/^-?\d+$/.test(cleaned)) {
    const n = Number(cleaned);
    if (Number.isFinite(n)) {
      return { ok: true, value: scalar('DINT', n) };
    }
  }

  // Fallback: unquoted string.
  return { ok: true, value: scalar('STRING', trimmed) };
}
