/**
 * Abstract syntax tree nodes for the ST runtime.
 *
 * Discriminated unions everywhere — each node has a `kind` tag and
 * the parser/interpreter switch on it. No classes, no methods on
 * nodes; nodes are plain data. Behaviour lives in the interpreter.
 *
 * Source positions: every node carries a `line` (1-indexed) so
 * runtime errors can point at the offending statement. Column is
 * recorded on tokens but not propagated past parsing — line is the
 * useful unit for highlighting.
 *
 * Identifier casing: ST is case-insensitive for both keywords and
 * identifiers, but TwinCAT preserves the user's original casing
 * for display. We carry both: `name` is the original spelling,
 * `nameLower` is what the symbol table keys on. The parser sets
 * both at construction time so consumers don't accidentally hit
 * one without the other.
 */

// --- Types and type names --------------------------------------

/**
 * The set of scalar type names we recognise in v1. Function-block
 * instance types (TON, TOF, etc.) come in a later ship — declaring
 * one in v1 will produce a parse error pointing at the type name.
 */
export type ScalarTypeName =
  | 'BOOL'
  | 'BYTE' | 'WORD' | 'DWORD' | 'LWORD'
  | 'SINT' | 'INT' | 'DINT' | 'LINT'
  | 'USINT' | 'UINT' | 'UDINT' | 'ULINT'
  | 'REAL' | 'LREAL'
  | 'STRING'
  | 'TIME';

export interface TypeRef {
  /** Canonical uppercase name, e.g. "UDINT". */
  name: ScalarTypeName;
  /** 1-indexed source line where the type was named. */
  line: number;
}

// --- Declarations ----------------------------------------------

export interface VarDecl {
  /** Original spelling, e.g. "Counter". */
  name: string;
  /** Lowercased for symbol-table keys, e.g. "counter". */
  nameLower: string;
  type: TypeRef;
  /** Optional initial-value expression. Parser already
   *  evaluates literals where it can; the interpreter treats this
   *  as just an expression to evaluate when entering scan 0. */
  initial: Expr | null;
  /** Source line of the declaration. */
  line: number;
}

/**
 * A POU declaration block. v1 only honours `localVars`. The other
 * variable-section keywords (VAR_INPUT, VAR_OUTPUT, ...) are
 * recognised at the lexer level so we can emit a useful parse
 * error rather than a confusing "expected identifier".
 */
export interface ProgramDecl {
  /** Original program name from `PROGRAM <name>`. */
  name: string;
  vars: VarDecl[];
}

// --- Expressions -----------------------------------------------

export type Expr =
  | LiteralExpr
  | VarRefExpr
  | UnaryExpr
  | BinaryExpr
  | CallExpr;

/**
 * A literal value parsed from source. We keep the original token
 * text in `raw` for diagnostics; `value` is the parsed JS value
 * (number for numerics, boolean for TRUE/FALSE, string for STRING
 * literals, BigInt-tagged for typed integer literals like 16#FF
 * — but for v1 simplicity we use plain numbers and let the
 * interpreter handle range/overflow at assignment time).
 */
export interface LiteralExpr {
  kind: 'Literal';
  /**
   * Type tag the parser inferred from the literal's syntactic
   * form. Used by the interpreter to pick a starting type before
   * the assignment-target's type is known (matters for things
   * like `myReal := 3` — 3 is INT, gets promoted to REAL on
   * assignment). For v1, the interpreter does this promotion
   * loosely; we just need to remember the literal's "kind".
   */
  litType: 'INT' | 'REAL' | 'BOOL' | 'STRING' | 'TIME';
  /** The literal's value as a JavaScript primitive. */
  value: number | boolean | string;
  raw: string;
  line: number;
}

export interface VarRefExpr {
  kind: 'VarRef';
  name: string;
  nameLower: string;
  line: number;
  /** 1-indexed column of the identifier's first character.
   *  Carried only on VarRefExpr (and not other nodes) because
   *  the inline-pill renderer is the sole consumer — pills only
   *  appear next to variable references. */
  column: number;
}

/** NOT, unary minus, unary plus. */
export type UnaryOp = 'NOT' | 'NEG' | 'POS';

export interface UnaryExpr {
  kind: 'Unary';
  op: UnaryOp;
  operand: Expr;
  line: number;
}

export type BinaryOp =
  // Arithmetic
  | 'ADD' | 'SUB' | 'MUL' | 'DIV' | 'MOD' | 'POW'
  // Bitwise (also serve as logical for BOOL)
  | 'AND' | 'OR' | 'XOR'
  // Comparison
  | 'EQ' | 'NE' | 'LT' | 'LE' | 'GT' | 'GE';

export interface BinaryExpr {
  kind: 'Binary';
  op: BinaryOp;
  left: Expr;
  right: Expr;
  line: number;
}

/**
 * Function call: `ABS(x)`, `MIN(a, b, c)`, `INT_TO_REAL(n)`. v1
 * supports only built-in functions — the parser produces this
 * node for any `IDENT ( ... )` form, and the interpreter looks
 * up the name in its built-in table at call time. Unknown names
 * therefore become a *runtime* error, not a parse error. We
 * could resolve at parse time but it's not worth the coupling.
 */
export interface CallExpr {
  kind: 'Call';
  /** Function name in original casing. */
  name: string;
  /** Lowercased for built-in table lookup. */
  nameLower: string;
  args: Expr[];
  line: number;
}

// --- Statements ------------------------------------------------

export type Statement =
  | AssignStmt
  | IfStmt
  | CaseStmt
  | ForStmt
  | WhileStmt
  | RepeatStmt
  | ExitStmt
  | ContinueStmt
  | ReturnStmt
  | ExpressionStmt;

export interface AssignStmt {
  kind: 'Assign';
  target: VarRefExpr;
  value: Expr;
  line: number;
}

export interface IfBranch {
  /** null for the ELSE branch. */
  condition: Expr | null;
  body: Statement[];
}

export interface IfStmt {
  kind: 'If';
  /** First branch is the IF; subsequent are ELSIFs; last (if
   *  condition is null) is the ELSE. Always ≥ 1 branch. */
  branches: IfBranch[];
  line: number;
}

export interface CaseLabel {
  /** A single literal value (CASE 1:) or a range (CASE 1..5:). */
  kind: 'Single' | 'Range';
  /** For Single: the value. For Range: the low end. */
  low: Expr;
  /** For Range: the high end (inclusive). For Single: same as low. */
  high: Expr;
}

export interface CaseBranch {
  /** Empty for the ELSE branch. */
  labels: CaseLabel[];
  body: Statement[];
}

export interface CaseStmt {
  kind: 'Case';
  selector: Expr;
  /** Last branch with empty `labels` is the ELSE branch.
   *  Always ≥ 1 branch. */
  branches: CaseBranch[];
  line: number;
}

export interface ForStmt {
  kind: 'For';
  /** Loop variable reference (already declared elsewhere). */
  loopVar: VarRefExpr;
  start: Expr;
  end: Expr;
  /** null when no BY clause was given (default step 1). */
  step: Expr | null;
  body: Statement[];
  line: number;
}

export interface WhileStmt {
  kind: 'While';
  condition: Expr;
  body: Statement[];
  line: number;
}

export interface RepeatStmt {
  kind: 'Repeat';
  body: Statement[];
  /** Loop terminates when this is TRUE. */
  until: Expr;
  line: number;
}

export interface ExitStmt {
  kind: 'Exit';
  line: number;
}

export interface ContinueStmt {
  kind: 'Continue';
  line: number;
}

export interface ReturnStmt {
  kind: 'Return';
  line: number;
}

/**
 * A bare expression as a statement — covers FB calls in v1 the
 * way the language allows: e.g. a future `MyTimer(IN := bStart)`.
 * In Ship A the parser will accept these and the runtime smoke
 * test will report "expression-only statements aren't executable
 * yet" if any are present. (The example file has no such
 * statements, so it doesn't matter for the smoke test.)
 */
export interface ExpressionStmt {
  kind: 'ExpressionStmt';
  expression: Expr;
  line: number;
}

// --- Top level -------------------------------------------------

/**
 * The full parsed result: the declaration block plus the body
 * statement list. The runtime constructs an environment from
 * `program.vars` and executes `body` once per scan.
 */
export interface ParsedProgram {
  program: ProgramDecl;
  body: Statement[];
}
