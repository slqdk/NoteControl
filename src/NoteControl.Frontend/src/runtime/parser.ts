/**
 * Parser for the v1 Structured Text subset.
 *
 * Recursive descent with explicit precedence-climbing for binary
 * operators. The grammar follows IEC 61131-3 / TwinCAT 3 with the
 * following v1 restrictions:
 *
 *   - POU types: PROGRAM only (FUNCTION_BLOCK / FUNCTION rejected).
 *   - Variable sections: VAR / END_VAR only. The other sections
 *     are recognised at lex time so we can reject them with a
 *     clear error rather than a confusing token-level one.
 *   - Types: scalars listed in TYPE_META. Arrays, structs, enums,
 *     pointers, references, and FB-instance types are rejected
 *     at parse time.
 *   - Statements: assignment, IF, CASE, FOR, WHILE, REPEAT,
 *     EXIT, CONTINUE, RETURN, and bare expressions (call form).
 *   - Expressions: the standard ST precedence table —
 *     OR > XOR > AND > comparison > additive > multiplicative >
 *     power > unary > primary.
 *
 * Two entry points:
 *   parseDeclaration(text) — parses a "PROGRAM Name VAR ... END_VAR
 *                            END_PROGRAM" block (END_PROGRAM is
 *                            accepted but optional, since the
 *                            TwinCAT InterfaceAsPlainText export
 *                            doesn't always include it).
 *   parseBody(text)        — parses a sequence of statements.
 *
 * They're separate because the runtime's two code blocks (Declaration
 * and Implementation) parse independently. Combining them into one
 * input would only work if we forced the user to paste both with
 * the right wrappers — which the import flow does, but a future
 * standalone /Run ST entry might not.
 */

import {
  type ParsedProgram, type ProgramDecl, type VarDecl,
  type Statement, type Expr, type CaseLabel, type CaseBranch,
  type IfBranch, type LiteralExpr, type VarRefExpr, type BinaryOp,
} from './ast';
import { StParseError } from './errors';
import { tokenize, type Token } from './lexer';
import { lookupTypeName } from './types';

// --- Public API ------------------------------------------------

/** Parse a declaration + a body together — convenience for the
 *  modal which has both. Returns a ParsedProgram. */
export function parseProgram(declText: string, bodyText: string): ParsedProgram {
  const program = parseDeclaration(declText);
  const body = parseBody(bodyText);
  // Cross-check: every reference in the body must resolve to a
  // declared variable. We do this in the parser (rather than the
  // interpreter) so a misspelled variable surfaces immediately
  // when the user opens the modal.
  validateVarRefs(body, program.vars);
  return { program, body };
}

export function parseDeclaration(text: string): ProgramDecl {
  const tokens = tokenize(text);
  const p = new Parser(tokens);
  const program = p.parseProgramHeader();
  p.consumeOptionalEndProgram();
  p.expectEof();
  return program;
}

export function parseBody(text: string): Statement[] {
  const tokens = tokenize(text);
  const p = new Parser(tokens);
  const stmts = p.parseStatementList(/* terminators */ []);
  p.expectEof();
  return stmts;
}

// --- Parser implementation -------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  // -- Cursor helpers --

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1];
  }
  private consume(): Token {
    const t = this.peek();
    this.pos++;
    return t;
  }
  private eof(): boolean {
    return this.peek().kind === 'EOF';
  }
  private err(t: Token, message: string): StParseError {
    return new StParseError('parse', t.line, t.column, message);
  }

  /** Match a KEYWORD with a specific (lowercased) value. Consumes
   *  on match; returns whether it matched. */
  private acceptKeyword(value: string): boolean {
    const t = this.peek();
    if (t.kind === 'KEYWORD' && t.value === value) {
      this.consume();
      return true;
    }
    return false;
  }
  private expectKeyword(
    value: string,
    opts: { optional?: boolean } = {},
  ): boolean {
    if (this.acceptKeyword(value)) return true;
    if (opts.optional) return false;
    const t = this.peek();
    throw this.err(t, `expected keyword "${value.toUpperCase()}", got ${describeToken(t)}`);
  }

  /** Match a PUNCT with a specific symbol. */
  private acceptPunct(symbol: string): boolean {
    const t = this.peek();
    if (t.kind === 'PUNCT' && t.value === symbol) {
      this.consume();
      return true;
    }
    return false;
  }
  private expectPunct(symbol: string): void {
    if (this.acceptPunct(symbol)) return;
    const t = this.peek();
    throw this.err(t, `expected "${symbol}", got ${describeToken(t)}`);
  }

  expectEof(): void {
    if (!this.eof()) {
      const t = this.peek();
      throw this.err(t, `unexpected ${describeToken(t)} after end of program`);
    }
  }

  consumeOptionalEndProgram(): void {
    this.acceptKeyword('end_program');
  }

  // -- Declaration --------------------------------------------

  parseProgramHeader(): ProgramDecl {
    // Accept optional leading PROGRAM <name>. The body inside
    // VAR/END_VAR is what really matters; the header is mostly
    // a label.
    let name = '(unnamed)';
    if (this.acceptKeyword('program')) {
      const id = this.peek();
      if (id.kind !== 'IDENT') {
        throw this.err(id, `expected program name after PROGRAM, got ${describeToken(id)}`);
      }
      name = id.value;
      this.consume();
    } else if (
      this.peek().kind === 'KEYWORD' &&
      ['function', 'function_block'].includes(this.peek().value)
    ) {
      const t = this.peek();
      throw this.err(
        t,
        `${t.value.toUpperCase()} POUs aren't supported in v1 — use PROGRAM`,
      );
    }

    const vars: VarDecl[] = [];

    // One or more VAR sections. Reject the non-VAR forms (input/
    // output/etc.) with a clear message.
    while (true) {
      const t = this.peek();
      if (t.kind === 'KEYWORD' && t.value === 'var') {
        this.consume();
        this.parseVarSection(vars);
        continue;
      }
      if (
        t.kind === 'KEYWORD' &&
        (t.value === 'var_input' || t.value === 'var_output' ||
         t.value === 'var_in_out' || t.value === 'var_temp' ||
         t.value === 'var_global' || t.value === 'var_external')
      ) {
        throw this.err(
          t,
          `${t.value.toUpperCase()} sections aren't supported in v1 — only VAR`,
        );
      }
      break;
    }

    return { name, vars };
  }

  /**
   * Parse the body of a VAR / END_VAR section, appending each
   * declaration to `vars`. Caller has already consumed the VAR
   * keyword.
   *
   * Per-line syntax:  Name [, Name2 ...] : TYPE [:= INIT] ;
   */
  private parseVarSection(vars: VarDecl[]): void {
    while (true) {
      const t = this.peek();
      if (t.kind === 'KEYWORD' && t.value === 'end_var') {
        this.consume();
        return;
      }
      if (t.kind !== 'IDENT') {
        throw this.err(t, `expected variable name or END_VAR, got ${describeToken(t)}`);
      }

      // Names are comma-separated until a colon. (Multi-decl on
      // one line — TwinCAT doesn't usually emit this, but it's
      // legal and a hand-pasted snippet might.)
      const names: { tok: Token; name: string; nameLower: string }[] = [];
      names.push(this.readVarName());
      while (this.acceptPunct(',')) {
        names.push(this.readVarName());
      }
      this.expectPunct(':');

      // Type
      const typeTok = this.peek();
      if (typeTok.kind !== 'IDENT' && typeTok.kind !== 'KEYWORD') {
        throw this.err(typeTok, `expected type name, got ${describeToken(typeTok)}`);
      }
      const canon = lookupTypeName(typeTok.value);
      if (!canon) {
        throw this.err(typeTok, `unknown type "${typeTok.value}" (v1 supports only standard scalars)`);
      }
      this.consume();

      // Optional initial value
      let initial: Expr | null = null;
      if (this.acceptPunct(':=')) {
        initial = this.parseExpression();
      }
      this.expectPunct(';');

      // Reject duplicates across the whole declaration block.
      // Case-insensitive key.
      for (const n of names) {
        if (vars.some((v) => v.nameLower === n.nameLower)) {
          throw this.err(n.tok, `duplicate variable declaration "${n.name}"`);
        }
        vars.push({
          name: n.name,
          nameLower: n.nameLower,
          type: { name: canon, line: typeTok.line },
          initial,
          line: n.tok.line,
        });
      }
    }
  }

  private readVarName(): { tok: Token; name: string; nameLower: string } {
    const t = this.peek();
    if (t.kind !== 'IDENT') {
      throw this.err(t, `expected variable name, got ${describeToken(t)}`);
    }
    this.consume();
    return { tok: t, name: t.value, nameLower: t.value.toLowerCase() };
  }

  // -- Statements ---------------------------------------------

  /**
   * Parse statements until we hit an EOF or any of the given
   * terminator keywords. The terminator is NOT consumed here —
   * the caller decides whether to consume it (e.g. END_IF vs
   * ELSIF / ELSE during IF parsing).
   */
  parseStatementList(terminators: string[]): Statement[] {
    const out: Statement[] = [];
    while (!this.eof()) {
      const t = this.peek();
      if (t.kind === 'KEYWORD' && terminators.includes(t.value)) {
        return out;
      }
      out.push(this.parseStatement());
    }
    return out;
  }

  private parseStatement(): Statement {
    const t = this.peek();

    if (t.kind === 'KEYWORD') {
      switch (t.value) {
        case 'if': return this.parseIf();
        case 'case': return this.parseCase();
        case 'for': return this.parseFor();
        case 'while': return this.parseWhile();
        case 'repeat': return this.parseRepeat();
        case 'exit': {
          this.consume();
          this.expectPunct(';');
          return { kind: 'Exit', line: t.line };
        }
        case 'continue': {
          this.consume();
          this.expectPunct(';');
          return { kind: 'Continue', line: t.line };
        }
        case 'return': {
          this.consume();
          this.expectPunct(';');
          return { kind: 'Return', line: t.line };
        }
      }
    }

    if (t.kind === 'IDENT') {
      // Either an assignment (IDENT := ...) or a call expression
      // statement (IDENT(...) ; ).
      // Look ahead one token to decide.
      const next = this.peek(1);
      if (next.kind === 'PUNCT' && next.value === ':=') {
        // Assignment
        const target: VarRefExpr = {
          kind: 'VarRef',
          name: t.value,
          nameLower: t.value.toLowerCase(),
          line: t.line,
        };
        this.consume(); // IDENT
        this.consume(); // :=
        const value = this.parseExpression();
        this.expectPunct(';');
        return { kind: 'Assign', target, value, line: t.line };
      }
      // Otherwise it's an expression statement (will likely be a
      // call form); parse as expression and require ;.
      const expression = this.parseExpression();
      this.expectPunct(';');
      return { kind: 'ExpressionStmt', expression, line: t.line };
    }

    throw this.err(t, `expected a statement, got ${describeToken(t)}`);
  }

  private parseIf(): Statement {
    const start = this.peek();
    this.expectKeyword('if');
    const branches: IfBranch[] = [];

    // First IF
    const cond = this.parseExpression();
    this.expectKeyword('then');
    branches.push({
      condition: cond,
      body: this.parseStatementList(['elsif', 'else', 'end_if']),
    });

    // Zero or more ELSIFs
    while (this.acceptKeyword('elsif')) {
      const c = this.parseExpression();
      this.expectKeyword('then');
      branches.push({
        condition: c,
        body: this.parseStatementList(['elsif', 'else', 'end_if']),
      });
    }

    // Optional ELSE
    if (this.acceptKeyword('else')) {
      branches.push({
        condition: null,
        body: this.parseStatementList(['end_if']),
      });
    }

    this.expectKeyword('end_if');
    this.expectPunct(';');
    return { kind: 'If', branches, line: start.line };
  }

  private parseCase(): Statement {
    const start = this.peek();
    this.expectKeyword('case');
    const selector = this.parseExpression();
    this.expectKeyword('of');

    const branches: CaseBranch[] = [];

    // Loop over labelled branches. Each iteration:
    //   1. Parse one or more comma-separated labels
    //   2. Consume ':'
    //   3. Parse statements until we see (a) ELSE/END_CASE or
    //      (b) the start of another label row.
    //
    // (b) is the tricky case: a "label row" is detectable by
    // looking ahead at primary + (':' | '..'). We check that
    // before calling parseStatement so we don't consume tokens
    // that belong to the next branch.
    while (true) {
      const t = this.peek();
      if (t.kind === 'KEYWORD' && (t.value === 'else' || t.value === 'end_case')) {
        break;
      }
      const labels: CaseLabel[] = [];
      labels.push(this.parseCaseLabel());
      while (this.acceptPunct(',')) {
        labels.push(this.parseCaseLabel());
      }
      this.expectPunct(':');
      const body: Statement[] = [];
      while (true) {
        const tn = this.peek();
        if (tn.kind === 'KEYWORD' &&
            (tn.value === 'else' || tn.value === 'end_case')) {
          break;
        }
        if (this.atCaseLabelStart()) break;
        body.push(this.parseStatement());
      }
      branches.push({ labels, body });
    }

    if (this.acceptKeyword('else')) {
      const body: Statement[] = [];
      while (true) {
        const tn = this.peek();
        if (tn.kind === 'KEYWORD' && tn.value === 'end_case') break;
        body.push(this.parseStatement());
      }
      branches.push({ labels: [], body });
    }
    this.expectKeyword('end_case');
    this.expectPunct(';');

    return { kind: 'Case', selector, branches, line: start.line };
  }

  /**
   * Look ahead to determine whether the cursor is positioned at
   * the start of a CASE label row. Returns true when we see a
   * label-eligible token (NUMBER, STRING, TIME, IDENT, or a
   * unary-minus-then-NUMBER) followed by either ':' or '..'.
   *
   * False positives are possible — `Counter : INT;` looks like
   * a label too — but the parser only consults this inside a
   * CASE body, where a `Name : INT` form would already be a
   * parse error anyway.
   */
  private atCaseLabelStart(): boolean {
    let off = 0;
    const t0 = this.peek(off);
    // Allow optional unary minus
    if (t0.kind === 'PUNCT' && t0.value === '-') {
      off++;
    }
    const t1 = this.peek(off);
    if (
      t1.kind !== 'NUMBER' && t1.kind !== 'STRING' &&
      t1.kind !== 'TIME' && t1.kind !== 'IDENT'
    ) {
      return false;
    }
    const t2 = this.peek(off + 1);
    if (t2.kind === 'PUNCT' && (t2.value === ':' || t2.value === '..')) {
      return true;
    }
    // Could also be IDENT, IDENT : ... if the user lists multiple
    // labels (1, 2: ...), so check for ',' followed eventually by
    // ':'. Cheap heuristic: just one more lookahead for ',' makes
    // this true. We don't need to be exhaustive — false negatives
    // here mean a multi-label row gets eaten as a statement and
    // becomes a parse error, which is acceptable.
    if (t2.kind === 'PUNCT' && t2.value === ',') {
      return true;
    }
    return false;
  }

  private parseCaseLabel(): CaseLabel {
    const low = this.parsePrimary();
    if (this.acceptPunct('..')) {
      const high = this.parsePrimary();
      return { kind: 'Range', low, high };
    }
    return { kind: 'Single', low, high: low };
  }

  private parseFor(): Statement {
    const start = this.peek();
    this.expectKeyword('for');
    // FOR var := start TO end [BY step] DO body END_FOR;
    const varTok = this.peek();
    if (varTok.kind !== 'IDENT') {
      throw this.err(varTok, `expected loop variable name, got ${describeToken(varTok)}`);
    }
    this.consume();
    this.expectPunct(':=');
    const startExpr = this.parseExpression();
    this.expectKeyword('to');
    const endExpr = this.parseExpression();
    let step: Expr | null = null;
    if (this.acceptKeyword('by')) {
      step = this.parseExpression();
    }
    this.expectKeyword('do');
    const body = this.parseStatementList(['end_for']);
    this.expectKeyword('end_for');
    this.expectPunct(';');
    return {
      kind: 'For',
      loopVar: {
        kind: 'VarRef',
        name: varTok.value,
        nameLower: varTok.value.toLowerCase(),
        line: varTok.line,
      },
      start: startExpr,
      end: endExpr,
      step,
      body,
      line: start.line,
    };
  }

  private parseWhile(): Statement {
    const start = this.peek();
    this.expectKeyword('while');
    const cond = this.parseExpression();
    this.expectKeyword('do');
    const body = this.parseStatementList(['end_while']);
    this.expectKeyword('end_while');
    this.expectPunct(';');
    return { kind: 'While', condition: cond, body, line: start.line };
  }

  private parseRepeat(): Statement {
    const start = this.peek();
    this.expectKeyword('repeat');
    const body = this.parseStatementList(['until']);
    this.expectKeyword('until');
    const cond = this.parseExpression();
    this.expectKeyword('end_repeat');
    this.expectPunct(';');
    return { kind: 'Repeat', body, until: cond, line: start.line };
  }

  // -- Expressions --------------------------------------------
  //
  // ST precedence (lowest to highest):
  //   OR
  //   XOR
  //   AND
  //   = <>
  //   < <= > >=
  //   + -
  //   * / MOD
  //   ** (power)
  //   unary NOT, -, +
  //   primary

  parseExpression(): Expr { return this.parseOr(); }

  private parseOr(): Expr {
    let left = this.parseXor();
    while (this.peekKw('or')) {
      const t = this.consume();
      const right = this.parseXor();
      left = { kind: 'Binary', op: 'OR', left, right, line: t.line };
    }
    return left;
  }
  private parseXor(): Expr {
    let left = this.parseAnd();
    while (this.peekKw('xor')) {
      const t = this.consume();
      const right = this.parseAnd();
      left = { kind: 'Binary', op: 'XOR', left, right, line: t.line };
    }
    return left;
  }
  private parseAnd(): Expr {
    let left = this.parseEquality();
    while (this.peekKw('and')) {
      const t = this.consume();
      const right = this.parseEquality();
      left = { kind: 'Binary', op: 'AND', left, right, line: t.line };
    }
    return left;
  }
  private parseEquality(): Expr {
    let left = this.parseRelational();
    while (true) {
      const t = this.peek();
      let op: BinaryOp | null = null;
      if (t.kind === 'PUNCT' && t.value === '=') op = 'EQ';
      else if (t.kind === 'PUNCT' && t.value === '<>') op = 'NE';
      if (!op) break;
      this.consume();
      const right = this.parseRelational();
      left = { kind: 'Binary', op, left, right, line: t.line };
    }
    return left;
  }
  private parseRelational(): Expr {
    let left = this.parseAdditive();
    while (true) {
      const t = this.peek();
      let op: BinaryOp | null = null;
      if (t.kind === 'PUNCT') {
        if (t.value === '<') op = 'LT';
        else if (t.value === '<=') op = 'LE';
        else if (t.value === '>') op = 'GT';
        else if (t.value === '>=') op = 'GE';
      }
      if (!op) break;
      this.consume();
      const right = this.parseAdditive();
      left = { kind: 'Binary', op, left, right, line: t.line };
    }
    return left;
  }
  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (true) {
      const t = this.peek();
      let op: BinaryOp | null = null;
      if (t.kind === 'PUNCT') {
        if (t.value === '+') op = 'ADD';
        else if (t.value === '-') op = 'SUB';
      }
      if (!op) break;
      this.consume();
      const right = this.parseMultiplicative();
      left = { kind: 'Binary', op, left, right, line: t.line };
    }
    return left;
  }
  private parseMultiplicative(): Expr {
    let left = this.parsePower();
    while (true) {
      const t = this.peek();
      let op: BinaryOp | null = null;
      if (t.kind === 'PUNCT') {
        if (t.value === '*') op = 'MUL';
        else if (t.value === '/') op = 'DIV';
      } else if (t.kind === 'KEYWORD' && t.value === 'mod') {
        op = 'MOD';
      }
      if (!op) break;
      this.consume();
      const right = this.parsePower();
      left = { kind: 'Binary', op, left, right, line: t.line };
    }
    return left;
  }
  private parsePower(): Expr {
    // ** is right-associative.
    const left = this.parseUnary();
    const t = this.peek();
    if (t.kind === 'PUNCT' && t.value === '**') {
      this.consume();
      const right = this.parsePower();
      return { kind: 'Binary', op: 'POW', left, right, line: t.line };
    }
    return left;
  }
  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === 'KEYWORD' && t.value === 'not') {
      this.consume();
      return { kind: 'Unary', op: 'NOT', operand: this.parseUnary(), line: t.line };
    }
    if (t.kind === 'PUNCT' && t.value === '-') {
      this.consume();
      return { kind: 'Unary', op: 'NEG', operand: this.parseUnary(), line: t.line };
    }
    if (t.kind === 'PUNCT' && t.value === '+') {
      this.consume();
      return { kind: 'Unary', op: 'POS', operand: this.parseUnary(), line: t.line };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.kind === 'NUMBER') {
      this.consume();
      // Distinguish integer from real by presence of "." or "e"
      const isReal = /[.eE]/.test(t.value);
      const lit: LiteralExpr = {
        kind: 'Literal',
        litType: isReal ? 'REAL' : 'INT',
        value: isReal ? parseFloat(t.value) : Number(t.value),
        raw: t.value,
        line: t.line,
      };
      return lit;
    }
    if (t.kind === 'STRING') {
      this.consume();
      return {
        kind: 'Literal',
        litType: 'STRING',
        value: t.value,
        raw: t.value,
        line: t.line,
      } satisfies LiteralExpr;
    }
    if (t.kind === 'TIME') {
      this.consume();
      return {
        kind: 'Literal',
        litType: 'TIME',
        value: Number(t.value),
        raw: t.value,
        line: t.line,
      } satisfies LiteralExpr;
    }
    if (t.kind === 'KEYWORD' && (t.value === 'true' || t.value === 'false')) {
      this.consume();
      return {
        kind: 'Literal',
        litType: 'BOOL',
        value: t.value === 'true',
        raw: t.value,
        line: t.line,
      } satisfies LiteralExpr;
    }
    if (t.kind === 'IDENT') {
      this.consume();
      // Function call?
      if (this.acceptPunct('(')) {
        const args: Expr[] = [];
        if (!this.acceptPunct(')')) {
          args.push(this.parseExpression());
          while (this.acceptPunct(',')) {
            args.push(this.parseExpression());
          }
          this.expectPunct(')');
        }
        return {
          kind: 'Call',
          name: t.value,
          nameLower: t.value.toLowerCase(),
          args,
          line: t.line,
        };
      }
      return {
        kind: 'VarRef',
        name: t.value,
        nameLower: t.value.toLowerCase(),
        line: t.line,
      };
    }
    if (t.kind === 'PUNCT' && t.value === '(') {
      this.consume();
      const e = this.parseExpression();
      this.expectPunct(')');
      return e;
    }

    throw this.err(t, `expected an expression, got ${describeToken(t)}`);
  }

  private peekKw(value: string): boolean {
    const t = this.peek();
    return t.kind === 'KEYWORD' && t.value === value;
  }
}

// --- Post-parse cross-checks ----------------------------------

/**
 * Walk `body` and ensure every variable reference (including
 * assignment targets and FOR loop variables) refers to a declared
 * name. Built-in function names are accepted in call position
 * without resolving — see CallExpr docs.
 *
 * The check is case-insensitive.
 */
function validateVarRefs(body: Statement[], vars: VarDecl[]): void {
  const declared = new Set(vars.map((v) => v.nameLower));

  function visitExpr(e: Expr): void {
    switch (e.kind) {
      case 'Literal': return;
      case 'VarRef':
        if (!declared.has(e.nameLower)) {
          throw new StParseError(
            'parse', e.line, 1,
            `undeclared variable "${e.name}" — declare it in the VAR block`,
          );
        }
        return;
      case 'Unary':
        visitExpr(e.operand); return;
      case 'Binary':
        visitExpr(e.left); visitExpr(e.right); return;
      case 'Call':
        for (const a of e.args) visitExpr(a);
        return;
    }
  }

  function visitStmt(s: Statement): void {
    switch (s.kind) {
      case 'Assign':
        if (!declared.has(s.target.nameLower)) {
          throw new StParseError(
            'parse', s.line, 1,
            `undeclared variable "${s.target.name}" on left-hand side of assignment`,
          );
        }
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
        if (!declared.has(s.loopVar.nameLower)) {
          throw new StParseError(
            'parse', s.line, 1,
            `undeclared loop variable "${s.loopVar.name}"`,
          );
        }
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

  for (const s of body) visitStmt(s);
}

function describeToken(t: Token): string {
  if (t.kind === 'EOF') return 'end of input';
  if (t.kind === 'KEYWORD') return `"${t.value.toUpperCase()}"`;
  if (t.kind === 'PUNCT') return `"${t.value}"`;
  if (t.kind === 'IDENT') return `identifier "${t.value}"`;
  if (t.kind === 'NUMBER') return `number "${t.value}"`;
  if (t.kind === 'STRING') return 'string literal';
  if (t.kind === 'TIME') return `TIME literal`;
  return `token`;
}
