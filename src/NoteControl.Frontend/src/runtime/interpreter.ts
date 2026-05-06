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
  CaseLabel, ScalarTypeName,
} from './ast';
import { StRuntimeError } from './errors';
import { TYPE_META, type TypeMeta } from './types';

// --- Value representation --------------------------------------

/**
 * A runtime value is its type tag plus its JS-side storage.
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
export interface RuntimeValue {
  type: ScalarTypeName;
  value: number | bigint | boolean | string;
}

export type Environment = Map<string, RuntimeValue>;

// --- Sentinels for control flow -------------------------------

class ExitSignal {}
class ContinueSignal {}
class ReturnSignal {}

const EXIT = new ExitSignal();
const CONT = new ContinueSignal();
const RET = new ReturnSignal();

// --- Public API ------------------------------------------------

/**
 * Build a fresh environment from the program declaration. Each
 * variable starts at:
 *   - its evaluated initial expression, if any
 *   - the type's default value otherwise
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
  for (const v of program.program.vars) {
    if (v.initial) {
      const value = evalExpr(v.initial, env);
      env.set(v.nameLower, coerceTo(value, v.type.name, v.line));
    } else {
      const meta = TYPE_META[v.type.name];
      env.set(v.nameLower, { type: v.type.name, value: meta.defaultValue });
    }
  }
  return env;
}

/**
 * Run one full scan of the program body. Mutates env in place.
 * Throws StRuntimeError on any runtime fault — caller stops the
 * scan loop and reports.
 *
 * EXIT or CONTINUE that propagates up to the scan boundary
 * terminates the current scan early without an error (a stray
 * EXIT outside a loop is poor practice but not a crime).
 */
export function runScan(program: ParsedProgram, env: Environment): void {
  try {
    execStatements(program.body, env);
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

function execStatements(stmts: Statement[], env: Environment): void {
  for (const s of stmts) {
    execStatement(s, env);
  }
}

function execStatement(s: Statement, env: Environment): void {
  switch (s.kind) {
    case 'Assign': {
      const value = evalExpr(s.value, env);
      const targetVar = env.get(s.target.nameLower);
      if (!targetVar) {
        // Should be unreachable — the parser already validated
        // every reference. Defensive throw.
        throw new StRuntimeError(
          'internal', s.line,
          `internal: unknown variable "${s.target.name}" at runtime`,
        );
      }
      const coerced = coerceTo(value, targetVar.type, s.line);
      env.set(s.target.nameLower, coerced);
      return;
    }

    case 'If': {
      for (const branch of s.branches) {
        if (branch.condition === null) {
          // ELSE
          execStatements(branch.body, env);
          return;
        }
        const cond = evalExpr(branch.condition, env);
        if (truthy(cond, branch.condition.line)) {
          execStatements(branch.body, env);
          return;
        }
      }
      return;
    }

    case 'Case': {
      const sel = evalExpr(s.selector, env);
      const selN = toIntForCase(sel, s.line);
      let matchedBranch = false;
      for (const branch of s.branches) {
        if (branch.labels.length === 0) continue; // ELSE — handled below
        if (caseLabelsMatch(branch.labels, selN, env)) {
          execStatements(branch.body, env);
          matchedBranch = true;
          break;
        }
      }
      if (!matchedBranch) {
        // Look for ELSE — last branch with empty labels
        const elseBranch = s.branches.find((b) => b.labels.length === 0);
        if (elseBranch) execStatements(elseBranch.body, env);
      }
      return;
    }

    case 'For': {
      const startV = evalExpr(s.start, env);
      const endV = evalExpr(s.end, env);
      const stepV = s.step ? evalExpr(s.step, env)
                           : { type: 'INT' as const, value: 1 };

      // FOR is integer-only in this v1. Real-typed bounds are a
      // type error.
      const startN = toIntForLoop(startV, s.line);
      const endN = toIntForLoop(endV, s.line);
      const stepN = toIntForLoop(stepV, s.line);

      if (stepN === 0n) {
        throw new StRuntimeError(
          'internal', s.line,
          'FOR loop step cannot be zero',
        );
      }

      const targetType = env.get(s.loopVar.nameLower)?.type;
      if (!targetType) {
        throw new StRuntimeError(
          'internal', s.line,
          `internal: loop variable "${s.loopVar.name}" not in env`,
        );
      }

      const ascending = stepN > 0n;
      let i = startN;
      while (ascending ? i <= endN : i >= endN) {
        // Write loop variable to env each iteration. Coerce so a
        // narrow loop var (e.g. SINT) wraps as expected.
        const iValue: RuntimeValue = { type: 'LINT', value: i };
        env.set(s.loopVar.nameLower, coerceTo(iValue, targetType, s.line));

        try {
          execStatements(s.body, env);
        } catch (sig) {
          if (sig instanceof ExitSignal) return;
          if (sig instanceof ContinueSignal) {
            // Fall through to the increment below.
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
        const c = evalExpr(s.condition, env);
        if (!truthy(c, s.condition.line)) return;
        try {
          execStatements(s.body, env);
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
          execStatements(s.body, env);
        } catch (sig) {
          if (sig instanceof ExitSignal) return;
          if (sig instanceof ContinueSignal) {
            // Fall through to the until check.
          } else {
            throw sig;
          }
        }
        const c = evalExpr(s.until, env);
        if (truthy(c, s.until.line)) return;
      }
    }

    case 'Exit': throw EXIT;
    case 'Continue': throw CONT;
    case 'Return': throw RET;

    case 'ExpressionStmt': {
      // v1 has no FB calls or user functions, so a bare expression
      // statement has no side effects. We evaluate it for any
      // potential built-in side effects (currently none — built-
      // ins are pure) and discard the result. If the expression
      // fails (e.g. unknown built-in), the runtime error fires
      // and surfaces in the modal.
      evalExpr(s.expression, env);
      return;
    }
  }
}

// --- CASE label matching --------------------------------------

function caseLabelsMatch(
  labels: CaseLabel[], selN: bigint, env: Environment,
): boolean {
  for (const lab of labels) {
    const lo = toIntForCase(evalExpr(lab.low, env), 0);
    const hi = lab.kind === 'Range'
      ? toIntForCase(evalExpr(lab.high, env), 0)
      : lo;
    if (selN >= lo && selN <= hi) return true;
  }
  return false;
}

// --- Expression evaluation ------------------------------------

function evalExpr(e: Expr, env: Environment): RuntimeValue {
  switch (e.kind) {
    case 'Literal': {
      switch (e.litType) {
        case 'INT':
          // The parser stored the literal value as a JS number
          // (it parsed the digits via Number()). Always-number
          // for INT — the discriminated union doesn't narrow that
          // tightly so we double-coerce defensively.
          return { type: 'DINT', value: Number(e.value) };
        case 'REAL':
          return { type: 'REAL', value: Number(e.value) };
        case 'BOOL':
          return { type: 'BOOL', value: Boolean(e.value) };
        case 'STRING':
          return { type: 'STRING', value: String(e.value) };
        case 'TIME':
          return { type: 'TIME', value: Number(e.value) };
      }
      throw new StRuntimeError('internal', e.line, 'unknown literal type');
    }

    case 'VarRef': {
      const v = env.get(e.nameLower);
      if (!v) {
        throw new StRuntimeError(
          'internal', e.line,
          `internal: unknown variable "${e.name}" at runtime`,
        );
      }
      // Return a copy so downstream mutation doesn't leak.
      return { type: v.type, value: v.value };
    }

    case 'Unary':
      return evalUnary(e.op, evalExpr(e.operand, env), e.line);

    case 'Binary':
      return evalBinary(
        e.op,
        evalExpr(e.left, env),
        evalExpr(e.right, env),
        e.line,
      );

    case 'Call':
      return callBuiltin(
        e.nameLower, e.name,
        e.args.map((a) => evalExpr(a, env)),
        e.line,
      );
  }
}

function evalUnary(
  op: 'NOT' | 'NEG' | 'POS', operand: RuntimeValue, line: number,
): RuntimeValue {
  switch (op) {
    case 'NOT':
      if (operand.type === 'BOOL') {
        return { type: 'BOOL', value: !(operand.value as boolean) };
      }
      // Bitwise NOT on integers
      if (typeof operand.value === 'bigint') {
        return { type: operand.type, value: ~operand.value };
      }
      if (typeof operand.value === 'number') {
        // ~ in JS works on 32-bit ints. For 8/16-bit types this
        // is fine since we coerce on assignment anyway.
        return { type: operand.type, value: ~operand.value };
      }
      throw new StRuntimeError(
        'type-mismatch', line,
        `NOT applied to ${operand.type}`,
      );
    case 'NEG':
      if (typeof operand.value === 'bigint') {
        return { type: operand.type, value: -operand.value };
      }
      if (typeof operand.value === 'number') {
        return { type: operand.type, value: -operand.value };
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
  op: BinaryOp, l: RuntimeValue, r: RuntimeValue, line: number,
): RuntimeValue {
  // Boolean logical ops on BOOLs
  if (l.type === 'BOOL' && r.type === 'BOOL' &&
      (op === 'AND' || op === 'OR' || op === 'XOR')) {
    const a = l.value as boolean;
    const b = r.value as boolean;
    let out: boolean;
    if (op === 'AND') out = a && b;
    else if (op === 'OR') out = a || b;
    else out = a !== b;
    return { type: 'BOOL', value: out };
  }

  // Comparison — works on any matching kinds (numbers vs numbers,
  // strings vs strings, time vs time, bool vs bool)
  if (op === 'EQ' || op === 'NE' || op === 'LT' ||
      op === 'LE' || op === 'GT' || op === 'GE') {
    return { type: 'BOOL', value: compareValues(op, l, r, line) };
  }

  // Numeric arithmetic / bitwise. Promote to a common form.
  // Decision tree:
  //   - If either is real → both → JS number, do FP op
  //   - Else both ints. If either is 64-bit → BigInt. Else number.
  if (l.type === 'REAL' || l.type === 'LREAL' ||
      r.type === 'REAL' || r.type === 'LREAL') {
    const a = toNumberFromAny(l, line);
    const b = toNumberFromAny(r, line);
    return realArith(op, a, b, line);
  }

  // Both integer. Pick representation.
  const lIsBig = TYPE_META[l.type].repr === 'bigint';
  const rIsBig = TYPE_META[r.type].repr === 'bigint';
  if (lIsBig || rIsBig) {
    const a = toBigInt(l, line);
    const b = toBigInt(r, line);
    return bigIntArith(op, a, b, widerType(l.type, r.type), line);
  }
  // Both fit in JS number.
  const a = l.value as number;
  const b = r.value as number;
  return numberArith(op, a, b, widerType(l.type, r.type), line);
}

// --- Arithmetic implementations --------------------------------

function realArith(
  op: BinaryOp, a: number, b: number, line: number,
): RuntimeValue {
  switch (op) {
    case 'ADD': return { type: 'REAL', value: a + b };
    case 'SUB': return { type: 'REAL', value: a - b };
    case 'MUL': return { type: 'REAL', value: a * b };
    case 'DIV':
      // FP division by zero gives Infinity (matches IEEE 754 +
      // TwinCAT lenient mode). No throw.
      return { type: 'REAL', value: a / b };
    case 'MOD':
      // ST: a MOD 0 is a runtime error (TwinCAT). We match that
      // even for reals because % in JS gives NaN, which is worse
      // than an explicit error.
      if (b === 0) {
        throw new StRuntimeError('div-by-zero', line, 'MOD by zero');
      }
      return { type: 'REAL', value: a % b };
    case 'POW': return { type: 'REAL', value: a ** b };
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
): RuntimeValue {
  // Integer arithmetic. Result is held as a JS number; assignment
  // will coerce/wrap to the destination type's range. We do NOT
  // wrap intermediate results — only on assignment. Matches
  // TwinCAT (an intermediate that overflows DINT but is then
  // assigned to LINT preserves the full value).
  switch (op) {
    case 'ADD': return { type: resultType, value: a + b };
    case 'SUB': return { type: resultType, value: a - b };
    case 'MUL': return { type: resultType, value: a * b };
    case 'DIV':
      if (b === 0) {
        throw new StRuntimeError('div-by-zero', line, 'integer division by zero');
      }
      return { type: resultType, value: Math.trunc(a / b) };
    case 'MOD':
      if (b === 0) {
        throw new StRuntimeError('div-by-zero', line, 'MOD by zero');
      }
      // ST MOD has the sign of the dividend (matches JS %).
      return { type: resultType, value: a % b };
    case 'POW': return { type: resultType, value: a ** b };
    case 'AND': return { type: resultType, value: (a & b) >>> 0 };
    case 'OR':  return { type: resultType, value: (a | b) >>> 0 };
    case 'XOR': return { type: resultType, value: (a ^ b) >>> 0 };
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
): RuntimeValue {
  switch (op) {
    case 'ADD': return { type: resultType, value: a + b };
    case 'SUB': return { type: resultType, value: a - b };
    case 'MUL': return { type: resultType, value: a * b };
    case 'DIV':
      if (b === 0n) {
        throw new StRuntimeError('div-by-zero', line, 'integer division by zero');
      }
      // BigInt / truncates toward zero already.
      return { type: resultType, value: a / b };
    case 'MOD':
      if (b === 0n) {
        throw new StRuntimeError('div-by-zero', line, 'MOD by zero');
      }
      return { type: resultType, value: a % b };
    case 'POW':
      if (b < 0n) {
        throw new StRuntimeError(
          'type-mismatch', line,
          'integer ** with negative exponent — use REAL',
        );
      }
      return { type: resultType, value: a ** b };
    case 'AND': return { type: resultType, value: a & b };
    case 'OR':  return { type: resultType, value: a | b };
    case 'XOR': return { type: resultType, value: a ^ b };
    default:
      throw new StRuntimeError(
        'type-mismatch', line,
        `operator "${op}" not valid here`,
      );
  }
}

function compareValues(
  op: BinaryOp, l: RuntimeValue, r: RuntimeValue, line: number,
): boolean {
  // Compare like-with-like. Mixed numeric (BigInt vs number) gets
  // promoted to BigInt-vs-BigInt (lossy for non-int reals — but
  // ST doesn't compare reals to ints often, and the parser would
  // have already promoted them to real arithmetic if either side
  // was real). For string and time we use direct equality.
  if (l.type === 'STRING' || r.type === 'STRING') {
    if (l.type !== 'STRING' || r.type !== 'STRING') {
      throw new StRuntimeError(
        'type-mismatch', line,
        `cannot compare STRING to ${l.type === 'STRING' ? r.type : l.type}`,
      );
    }
    return cmpPrimitive(op, l.value as string, r.value as string);
  }

  // Compare booleans only with =, <>
  if (l.type === 'BOOL' && r.type === 'BOOL') {
    if (op === 'EQ') return l.value === r.value;
    if (op === 'NE') return l.value !== r.value;
    throw new StRuntimeError(
      'type-mismatch', line,
      `BOOLs only support = and <> (got ${op})`,
    );
  }

  // Time = number-of-ms; compare as numbers.
  // Otherwise both numeric — but l might be bigint and r might be
  // number. Promote uniformly.
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
  value: RuntimeValue, target: ScalarTypeName, line: number,
): RuntimeValue {
  const meta = TYPE_META[target];

  if (target === 'BOOL') {
    if (value.type !== 'BOOL') {
      throw new StRuntimeError(
        'type-mismatch', line,
        `cannot assign ${value.type} to BOOL`,
      );
    }
    return { type: 'BOOL', value: value.value as boolean };
  }

  if (target === 'STRING') {
    if (value.type !== 'STRING') {
      throw new StRuntimeError(
        'type-mismatch', line,
        `cannot assign ${value.type} to STRING`,
      );
    }
    return { type: 'STRING', value: value.value as string };
  }

  if (target === 'TIME') {
    if (value.type !== 'TIME') {
      // Allow integer → TIME if it's a positive number-of-ms,
      // since the user's source just wrote `t := 100`. Strict
      // mode would refuse this.
      if (typeof value.value === 'number') {
        return { type: 'TIME', value: Math.max(0, Math.trunc(value.value)) };
      }
      throw new StRuntimeError(
        'type-mismatch', line,
        `cannot assign ${value.type} to TIME`,
      );
    }
    return { type: 'TIME', value: value.value as number };
  }

  if (target === 'REAL' || target === 'LREAL') {
    const n = toNumberFromAny(value, line);
    return { type: target, value: n };
  }

  // Target is integer. Source might be BOOL → reject. Real → trunc.
  // Integer → wrap.
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

  // Get an integer representation of the value.
  let asBig: bigint;
  if (typeof value.value === 'bigint') {
    asBig = value.value;
  } else if (typeof value.value === 'number') {
    asBig = BigInt(Math.trunc(value.value));
  } else {
    throw new StRuntimeError('type-mismatch', line, 'expected number');
  }

  // Wrap to range. Two's-complement style: shift to unsigned,
  // mod by 2^bits, shift back.
  const wrapped = wrapToRange(asBig, meta);

  // Final value: convert back to JS number if the target is
  // ≤32 bit, otherwise keep as BigInt.
  if (meta.repr === 'bigint') {
    return { type: target, value: wrapped };
  }
  return { type: target, value: Number(wrapped) };
}

function wrapToRange(value: bigint, meta: TypeMeta): bigint {
  if (meta.min === null || meta.max === null) return value;
  const range = meta.max - meta.min + 1n;
  let v = ((value - meta.min) % range + range) % range + meta.min;
  return v;
}

// --- Helpers ---------------------------------------------------

function widerType(a: ScalarTypeName, b: ScalarTypeName): ScalarTypeName {
  // For arithmetic results we just need a tag that's compatible
  // with the numeric domain. The actual range check happens on
  // assignment. Pick the wider operand's type as a hint, falling
  // back to DINT for anything weird.
  const ma = TYPE_META[a];
  const mb = TYPE_META[b];
  if (ma.repr === 'bigint' || mb.repr === 'bigint') {
    // Prefer signed if either operand is signed.
    if (ma.signed || mb.signed) return 'LINT';
    return 'ULINT';
  }
  if (ma.bits >= mb.bits) return a;
  return b;
}

function toNumberFromAny(v: RuntimeValue, line: number): number {
  if (typeof v.value === 'number') return v.value;
  if (typeof v.value === 'bigint') return Number(v.value);
  if (typeof v.value === 'boolean') return v.value ? 1 : 0;
  throw new StRuntimeError(
    'type-mismatch', line,
    `cannot convert ${v.type} to a number`,
  );
}

function toBigInt(v: RuntimeValue, line: number): bigint {
  if (typeof v.value === 'bigint') return v.value;
  if (typeof v.value === 'number') return BigInt(Math.trunc(v.value));
  throw new StRuntimeError(
    'type-mismatch', line,
    `cannot convert ${v.type} to integer`,
  );
}

function toIntForCase(v: RuntimeValue, line: number): bigint {
  // CASE only on integer-ish selectors. Real is a type error.
  if (v.type === 'REAL' || v.type === 'LREAL') {
    throw new StRuntimeError(
      'type-mismatch', line,
      'CASE selector must be integer, not REAL',
    );
  }
  return toBigInt(v, line);
}

function toIntForLoop(v: RuntimeValue, line: number): bigint {
  if (v.type === 'REAL' || v.type === 'LREAL') {
    throw new StRuntimeError(
      'type-mismatch', line,
      'FOR loop bounds must be integer, not REAL',
    );
  }
  return toBigInt(v, line);
}

function truthy(v: RuntimeValue, line: number): boolean {
  if (v.type === 'BOOL') return v.value as boolean;
  throw new StRuntimeError(
    'type-mismatch', line,
    `condition must be BOOL, got ${v.type}`,
  );
}

// --- Built-in functions ----------------------------------------

type Builtin = (args: RuntimeValue[], line: number) => RuntimeValue;

const BUILTINS: Map<string, Builtin> = new Map();

function reg(name: string, fn: Builtin): void {
  BUILTINS.set(name.toLowerCase(), fn);
}

// Generic numeric helpers
function asNumOrBig(v: RuntimeValue, line: number): number | bigint {
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
  if (typeof n === 'bigint') return { type: v.type, value: n < 0n ? -n : n };
  return { type: v.type, value: Math.abs(n) };
});

reg('min', (args, line) => {
  if (args.length < 2) {
    throw new StRuntimeError('type-mismatch', line, 'MIN expects at least 2 arguments');
  }
  return args.reduce((acc, v) => {
    const a = asNumOrBig(acc, line);
    const b = asNumOrBig(v, line);
    if (typeof a === 'bigint' || typeof b === 'bigint') {
      const aBig = typeof a === 'bigint' ? a : BigInt(Math.trunc(a as number));
      const bBig = typeof b === 'bigint' ? b : BigInt(Math.trunc(b as number));
      return aBig < bBig ? acc : v;
    }
    return (a as number) < (b as number) ? acc : v;
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
      const aBig = typeof a === 'bigint' ? a : BigInt(Math.trunc(a as number));
      const bBig = typeof b === 'bigint' ? b : BigInt(Math.trunc(b as number));
      return aBig > bBig ? acc : v;
    }
    return (a as number) > (b as number) ? acc : v;
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
  // Stay in v's type slot.
  if (typeof vN === 'bigint') {
    const loB = typeof loN === 'bigint' ? loN : BigInt(Math.trunc(loN as number));
    const hiB = typeof hiN === 'bigint' ? hiN : BigInt(Math.trunc(hiN as number));
    let r = vN;
    if (r < loB) r = loB;
    if (r > hiB) r = hiB;
    return { type: v.type, value: r };
  }
  let r = vN as number;
  const loF = Number(loN);
  const hiF = Number(hiN);
  if (r < loF) r = loF;
  if (r > hiF) r = hiF;
  return { type: v.type, value: r };
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
  args: RuntimeValue[], line: number,
): RuntimeValue {
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
    return { type: v.type, value: r };
  }
  const x = (v.value as number) & ((1 << bits) - 1 || 0xFFFFFFFF);
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
  return { type: v.type, value: r };
}

// Type conversions — register the common ones. Each is just
// "take the value, coerce to target type". The conversion table
// is verbose but each line is trivial.
const CONVERSIONS: Array<[from: ScalarTypeName | '_', to: ScalarTypeName]> = [
  // Common pairs we care about — ABS doesn't need them, but
  // assignments often do.
  ['_', 'INT'], ['_', 'DINT'], ['_', 'UINT'], ['_', 'UDINT'],
  ['_', 'SINT'], ['_', 'USINT'], ['_', 'BYTE'], ['_', 'WORD'],
  ['_', 'DWORD'], ['_', 'LINT'], ['_', 'ULINT'], ['_', 'LWORD'],
  ['_', 'REAL'], ['_', 'LREAL'],
];

// Register all "<X>_TO_<Y>" combinations among the integer/real
// types. STRING and TIME are special-cased outside this loop.
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
        return coerceTo(
          { type: 'INT', value: (v.value as boolean) ? 1 : 0 },
          to, line,
        );
      }
      if (to === 'BOOL') {
        // Numeric→BOOL: 0 = false, anything else = true.
        const n = asNumOrBig(v, line);
        const isTrue = typeof n === 'bigint' ? n !== 0n : n !== 0;
        return { type: 'BOOL', value: isTrue };
      }
      return coerceTo(v, to, line);
    });
  }
}

// Suppress the unused-CONVERSIONS warning. The array was a
// scaffolding artefact during planning; the actual registration
// loop lives below it. Keeping it (rather than deleting) as a
// breadcrumb for future bulk-conversion macros.
void CONVERSIONS;

function callBuiltin(
  nameLower: string, originalName: string,
  args: RuntimeValue[], line: number,
): RuntimeValue {
  const fn = BUILTINS.get(nameLower);
  if (!fn) {
    throw new StRuntimeError(
      'unknown-builtin', line,
      `unknown function "${originalName}" (v1 supports a small set of built-ins — see modal docs)`,
    );
  }
  return fn(args, line);
}

// --- Display helpers ------------------------------------------

/**
 * Render a runtime value the way TwinCAT's online view does:
 *   BOOL → "TRUE" / "FALSE"
 *   ints → decimal
 *   reals → JS toString (good enough for v1)
 *   STRING → quoted with single quotes
 *   TIME → "T#1s500ms"-style
 *
 * Used by the inline-pill renderer and the modal's error banner.
 */
export function formatRuntimeValue(v: RuntimeValue): string {
  switch (v.type) {
    case 'BOOL': return (v.value as boolean) ? 'TRUE' : 'FALSE';
    case 'STRING': return `'${v.value as string}'`;
    case 'TIME': return formatTime(v.value as number);
    case 'REAL':
    case 'LREAL':
      return (v.value as number).toString();
    default: {
      // Integer
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
