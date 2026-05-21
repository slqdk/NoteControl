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
  type ParsedProgram, type ProgramDecl, type VarDecl, type VarSection, type TypeRef,
  type Statement, type Expr, type CaseLabel, type CaseBranch,
  type IfBranch, type LiteralExpr, type VarRefExpr, type BinaryOp,
  type CallArg, type ChainSegment,
} from './ast';
import { StParseError } from './errors';
import { tokenize, type Token } from './lexer';
import { lookupTypeName, lookupFbType } from './types';

// --- Public API ------------------------------------------------

/** Parse a declaration + a body together — convenience for the
 *  modal which has both. Returns a ParsedProgram. */
export function parseProgram(declText: string, bodyText: string): ParsedProgram {
  const program = parseDeclaration(declText);
  const body = parseBody(bodyText);
  // Auto-declare any chain bases that aren't in the VAR block.
  // These typically refer to namespaced globals
  // (`XTS_Configuration.MoverCount`) or other-POU constants that
  // the user hasn't bothered to mirror in the local VAR block.
  // Synthesising them as unknown FB instances lets the body parse
  // and run; reads/pokes work like any other unknown chain.
  autoDeclareChainBases(body, program.vars);
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
    // Accept any of the POU terminators. The runtime treats all
    // POU types the same (a body executed once per scan), so we
    // don't need to enforce that END_FUNCTION_BLOCK pairs only
    // with FUNCTION_BLOCK — TwinCAT's exporter writes the right
    // pair, and a hand-paste with a wrong terminator is harmless.
    this.acceptKeyword('end_program') ||
      this.acceptKeyword('end_function_block') ||
      this.acceptKeyword('end_function');
  }

  // -- Declaration --------------------------------------------

  parseProgramHeader(): ProgramDecl {
    // Accept any POU header keyword (PROGRAM, FUNCTION_BLOCK,
    // FUNCTION) — the runtime treats them all as "a body to run
    // once per scan, with a flat variable table". This lets the
    // user paste a real FB or function from TwinCAT and exercise
    // its logic in the sandbox without first having to re-shape
    // it into a PROGRAM by hand. The semantic distinction between
    // VAR_INPUT / VAR_OUTPUT / VAR_IN_OUT / VAR doesn't matter
    // here either: in the sandbox every variable is just a slot
    // the body reads and writes (and the user can poke), so we
    // collapse them all into a single flat list.
    let name = '(unnamed)';
    if (this.acceptKeyword('program') ||
        this.acceptKeyword('function_block') ||
        this.acceptKeyword('function')) {
      const id = this.peek();
      if (id.kind !== 'IDENT') {
        throw this.err(id, `expected POU name after the header keyword, got ${describeToken(id)}`);
      }
      name = id.value;
      this.consume();
      // FUNCTION POUs declare a return type after the name:
      //   FUNCTION FooBar : INT
      // We accept the colon-and-type but ignore it — the v1
      // runtime has no concept of "function return value", and
      // when the body is run it just executes statements.
      if (this.acceptPunct(':')) {
        const t = this.peek();
        if (t.kind !== 'IDENT' && t.kind !== 'KEYWORD') {
          throw this.err(t, `expected return type after ":", got ${describeToken(t)}`);
        }
        this.consume();
      }
    }

    const vars: VarDecl[] = [];

    // Any VAR / VAR_INPUT / VAR_OUTPUT / VAR_IN_OUT / VAR_TEMP
    // section opens a flat declaration list. We loop accepting
    // any of them in any order until we run out of section
    // keywords; the body of each shares parseVarSection which
    // appends to the same flat `vars` list. All variables become
    // local-scope at runtime — no input/output distinction is
    // observable.
    const VAR_OPENERS = new Map<string, VarSection>([
      ['var',          'LOCAL'],
      ['var_input',    'INPUT'],
      ['var_output',   'OUTPUT'],
      ['var_in_out',   'IN_OUT'],
      ['var_temp',     'TEMP'],
      ['var_global',   'GLOBAL'],
      ['var_external', 'EXTERNAL'],
    ]);
    while (true) {
      const t = this.peek();
      const sectionTag = t.kind === 'KEYWORD' ? VAR_OPENERS.get(t.value) : undefined;
      if (sectionTag) {
        this.consume();
        // Some VAR_INPUT / VAR_OUTPUT sections have modifier
        // keywords like `CONSTANT`, `RETAIN`, `PERSISTENT` after
        // the section keyword. Skip them — they're attributes,
        // not part of variable shape. (We don't enforce them.)
        while (true) {
          const m = this.peek();
          if (m.kind === 'KEYWORD' &&
              (m.value === 'constant' || m.value === 'retain' ||
               m.value === 'persistent')) {
            this.consume();
            continue;
          }
          break;
        }
        this.parseVarSection(vars, sectionTag);
        continue;
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
  private parseVarSection(vars: VarDecl[], section: VarSection): void {
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

      // Type — handled by `readTypeRef()` which supports plain
      // scalars/FBs, dotted/namespaced type names (treated as
      // unknown), and ARRAY[...] OF T (also treated as unknown,
      // with the full source-equivalent name preserved on the
      // typeRef for the watch-table tooltip).
      const typeTok = this.peek();
      const typeRef = this.readTypeRef();

      // Optional initial value — only meaningful for scalars.
      // FB instances (known or unknown) have internal state init
      // done by the runtime, so we still reject `:= ...` for
      // anything that isn't a scalar.
      let initial: Expr | null = null;
      if (this.acceptPunct(':=')) {
        if (typeRef.kind !== 'scalar') {
          throw this.err(
            typeTok,
            `${typeRef.kind === 'fb' ? 'FB instances' : 'unknown-typed variables'} cannot have an initial value (drop the := for "${describeTypeRef(typeRef)}")`,
          );
        }
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
          type: typeRef,
          section,
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

  /**
   * Read a type reference. Three shapes are accepted:
   *
   *   1. `ARRAY [ range { , range } ] OF <typeRef>`
   *      Recursive: the element type is itself a typeRef, so
   *      multi-dimensional arrays via nested ARRAYs work
   *      (`ARRAY[1..3] OF ARRAY[1..4] OF INT`). Ranges accept
   *      any expression on either side of `..` — including
   *      dotted/namespaced names like `XTS_Configuration.Count`
   *      — because chain expressions parse cleanly now.
   *
   *      The whole array type collapses to a single `unknown`
   *      typeRef. The runtime doesn't model per-element storage
   *      in v1 (the interpreter just treats the whole array as
   *      one poke target). Indexing via `Mover[IDX]` in the body
   *      becomes a chain segment that all share the same key —
   *      same `(*)` collapsing rule the chain reader uses for
   *      method args.
   *
   *   2. `IDENT { . IDENT }` — a possibly-namespaced type name.
   *      A SINGLE IDENT is matched against built-in scalar and
   *      FB types first (so `INT`, `BOOL`, `TON` still resolve);
   *      a dotted name like `Tc3_XTS_Utility.FB_TcIoXtsEnvironment`
   *      is always unknown — the v1 runtime has no schemas for
   *      namespaced types.
   *
   *   3. The error path: anything else gets a clear message.
   *
   * Returns a `TypeRef`. The unknown name preserves the original
   * casing of every segment, joined back together — useful for
   * the watch-table tooltip.
   */
  private readTypeRef(): TypeRef {
    const head = this.peek();
    if (head.kind !== 'IDENT' && head.kind !== 'KEYWORD') {
      throw this.err(head, `expected type name, got ${describeToken(head)}`);
    }

    // ARRAY[...] OF ...  — `ARRAY` is not in the lexer keyword
    // set, so it arrives as IDENT. Case-insensitive match.
    if (head.kind === 'IDENT' && head.value.toUpperCase() === 'ARRAY') {
      this.consume(); // ARRAY
      this.expectPunct('[');
      const ranges: string[] = [];
      // Parse one or more ranges, comma-separated. Each range is
      // `<expr> .. <expr>`. We don't keep the parsed bounds —
      // they're not used at runtime — but we DO record their
      // source text for the type-name display. We do that by
      // re-tokenising… too much work. Instead just consume them
      // structurally and record a placeholder.
      do {
        // Parse the low bound as an expression.
        this.parseExpression();
        // ".." separator is required.
        this.expectPunct('..');
        this.parseExpression();
        ranges.push('…');
      } while (this.acceptPunct(','));
      this.expectPunct(']');
      // OF after the bounds. The lexer treats `of` as a KEYWORD
      // (it's part of CASE...OF), so we look for the keyword
      // here, not an IDENT — accepting either keeps the parser
      // robust to lexer reclassification.
      if (!this.acceptKeyword('of')) {
        const ofTok = this.peek();
        // Permit the IDENT spelling too, in case a future lexer
        // change drops `of` from the keyword set.
        if (ofTok.kind === 'IDENT' && ofTok.value.toUpperCase() === 'OF') {
          this.consume();
        } else {
          throw this.err(ofTok, `expected "OF" after ARRAY[...], got ${describeToken(ofTok)}`);
        }
      }
      // Recursively read the element type.
      const elementType = this.readTypeRef();
      return {
        kind: 'unknown',
        unknownName: `ARRAY[${ranges.join(',')}] OF ${describeTypeRef(elementType)}`,
        line: head.line,
      };
    }

    // Plain or dotted type name. Read one head IDENT/KEYWORD,
    // then keep consuming `.IDENT` while the next token is `.`.
    this.consume(); // head
    const parts: string[] = [head.value];
    while (this.acceptPunct('.')) {
      const t = this.peek();
      if (t.kind !== 'IDENT' && t.kind !== 'KEYWORD') {
        throw this.err(t, `expected type name part after ".", got ${describeToken(t)}`);
      }
      this.consume();
      parts.push(t.value);
    }

    // If the type is a SINGLE undotted name, try built-in
    // resolution (scalar then FB). Dotted names are always
    // unknown — there are no namespaced built-ins in v1.
    if (parts.length === 1) {
      const scalarName = lookupTypeName(parts[0]);
      if (scalarName) {
        return { kind: 'scalar', name: scalarName, line: head.line };
      }
      const fbName = lookupFbType(parts[0]);
      if (fbName) {
        return { kind: 'fb', name: fbName, line: head.line };
      }
    }

    return {
      kind: 'unknown',
      unknownName: parts.join('.'),
      line: head.line,
    };
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
      // The IDENT branch handles two statement shapes:
      //
      //   1. Assignment: `<lhs> := <expr>;`
      //      The LHS may be a plain identifier (`x := ...`), a
      //      single-dot member of an FB or unknown (`obj.m := ...`),
      //      or a deeper chain on an unknown
      //      (`a.b(1).c := ...`).
      //
      //   2. Expression statement: a call form like `MyTimer(...)`
      //      or `obj.method(args);` whose return value is discarded.
      //
      // Both LHS-of-assign and bare-statement-expression share the
      // same prefix grammar, so we parse the prefix as an
      // expression first and then look at the next token. `:=` →
      // assignment; otherwise expression statement.
      //
      // The previous implementation peeked one token ahead for `:=`
      // and committed to assignment only on a bare IDENT LHS. That
      // ruled out dotted assign targets (an explicit limitation we
      // are lifting in this ship).
      const expr = this.parseExpression();
      if (this.acceptPunct(':=')) {
        const value = this.parseExpression();
        this.expectPunct(';');
        return this.buildAssignFromLhs(expr, value, t.line);
      }
      this.expectPunct(';');
      return { kind: 'ExpressionStmt', expression: expr, line: t.line };
    }

    throw this.err(t, `expected a statement, got ${describeToken(t)}`);
  }

  /**
   * Promote a parsed expression to an assignment-target. Three
   * shapes are valid:
   *
   *   - VarRefExpr  → `AssignStmt` (the original simple case)
   *   - MemberExpr  → `ChainAssignStmt` with a one-segment chain
   *                   (covers `MyTimer.IN := …` patterns)
   *   - ChainExpr whose last segment is a 'member'  →
   *     `ChainAssignStmt`
   *
   * Anything else (Literal, Binary, a method-call ending, etc.)
   * is rejected with a clear error pointing at the LHS line. */
  private buildAssignFromLhs(
    lhs: Expr, value: Expr, line: number,
  ): Statement {
    if (lhs.kind === 'VarRef') {
      return { kind: 'Assign', target: lhs, value, line };
    }
    if (lhs.kind === 'Member') {
      return {
        kind: 'ChainAssign',
        target: {
          kind: 'Chain',
          base: lhs.object,
          segments: [{
            kind: 'member',
            name: lhs.member,
            nameLower: lhs.memberLower,
            line: lhs.line,
            // The column of the member identifier itself —
            // `MemberExpr` carries the OBJECT's column, not the
            // member's. We approximate by offsetting past the
            // object's name and the dot. This is only used by the
            // inline-pill renderer; "approximate" is fine.
            column: lhs.column + lhs.object.name.length + 1,
          }],
          line: lhs.line,
        },
        value,
        line,
      };
    }
    if (lhs.kind === 'Chain') {
      const last = lhs.segments[lhs.segments.length - 1];
      if (!last || (last.kind !== 'member' && last.kind !== 'index')) {
        throw new StParseError(
          'parse', lhs.line, 0,
          `can't assign to the result of a method call — the left side must end in a member name or array index`,
        );
      }
      return { kind: 'ChainAssign', target: lhs, value, line };
    }
    throw new StParseError(
      'parse', lhs.line, 0,
      `left side of ":=" must be a variable or a dotted member, not ${describeExprForDiag(lhs)}`,
    );
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
    // Trailing `;` is optional. TwinCAT and most ST style guides
    // omit it (END_IF is a block terminator, not a statement); the
    // earlier strict requirement here was overzealous.
    this.acceptPunct(';');
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
    this.acceptPunct(';');

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
    this.acceptPunct(';');
    return {
      kind: 'For',
      loopVar: {
        kind: 'VarRef',
        name: varTok.value,
        nameLower: varTok.value.toLowerCase(),
        line: varTok.line,
        column: varTok.column,
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
    this.acceptPunct(';');
    return { kind: 'While', condition: cond, body, line: start.line };
  }

  private parseRepeat(): Statement {
    const start = this.peek();
    this.expectKeyword('repeat');
    const body = this.parseStatementList(['until']);
    this.expectKeyword('until');
    const cond = this.parseExpression();
    this.expectKeyword('end_repeat');
    this.acceptPunct(';');
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
      // Simple no-suffix variable reference is the dominant case.
      // We check for it first so the common path is short and the
      // chain handling below only runs when there's actually
      // something to chain.
      const next = this.peek();
      const hasDot = next.kind === 'PUNCT' && next.value === '.';
      const hasParen = next.kind === 'PUNCT' && next.value === '(';
      const hasBracket = next.kind === 'PUNCT' && next.value === '[';

      if (!hasDot && !hasParen && !hasBracket) {
        return {
          kind: 'VarRef',
          name: t.value,
          nameLower: t.value.toLowerCase(),
          line: t.line,
          column: t.column,
        };
      }

      // `IDENT(args)` with NO further chain segments — keep
      // emitting the original `Call` shape so built-in/function
      // dispatch and the existing inline renderer are untouched
      // for the simple-call case.
      if (hasParen) {
        // Peek at what follows the matching `)` to see if a chain
        // continues. If it does (`fb(args).foo` or `fb(args)[i]`),
        // we treat the whole thing as a chain whose first segment
        // is a method call. If not, emit the legacy `Call`.
        //
        // We can decide cheaply: parse the `(args)` first, then
        // look at the next token.
        this.consume(); // (
        const args = this.parseCallArgList();
        const after = this.peek();
        const continues = after.kind === 'PUNCT' &&
          (after.value === '.' || after.value === '[' || after.value === '(');
        if (!continues) {
          return {
            kind: 'Call',
            name: t.value,
            nameLower: t.value.toLowerCase(),
            args,
            line: t.line,
          };
        }
        // Promote to a chain: the head IDENT becomes a faux base
        // VarRef and the (args) becomes a first 'method' segment.
        // Then read any further segments.
        const baseRef: VarRefExpr = {
          kind: 'VarRef',
          name: t.value,
          nameLower: t.value.toLowerCase(),
          line: t.line,
          column: t.column,
        };
        const segments: ChainSegment[] = [{
          kind: 'method',
          name: t.value,
          nameLower: t.value.toLowerCase(),
          args,
          line: t.line,
          column: t.column,
        }];
        segments.push(...this.parseChainTail());
        return {
          kind: 'Chain', base: baseRef, segments, line: t.line,
        };
      }

      // `IDENT[index]` — promote to a chain starting with an
      // index segment.
      if (hasBracket) {
        const baseRef: VarRefExpr = {
          kind: 'VarRef',
          name: t.value,
          nameLower: t.value.toLowerCase(),
          line: t.line,
          column: t.column,
        };
        const segments: ChainSegment[] = [this.parseIndexSegment()];
        segments.push(...this.parseChainTail());
        return {
          kind: 'Chain', base: baseRef, segments, line: t.line,
        };
      }

      // Dotted access. `obj.member` / `obj.method(args)` / deeper
      // chains. We special-case the one-dot, no-args, no-bracket
      // shape (`MyTimer.Q`) and keep emitting `MemberExpr` for
      // backwards compatibility — every consumer that destructures
      // `e.object.name` continues to work. Anything deeper or
      // call/index-bearing is emitted as `ChainExpr`.
      this.consume(); // .
      const baseRef: VarRefExpr = {
        kind: 'VarRef',
        name: t.value,
        nameLower: t.value.toLowerCase(),
        line: t.line,
        column: t.column,
      };
      const segments = this.parseChainSegments();
      if (segments.length === 1 && segments[0].kind === 'member') {
        const m = segments[0];
        return {
          kind: 'Member',
          object: baseRef,
          member: m.name,
          memberLower: m.nameLower,
          line: t.line,
          column: t.column,
        };
      }
      return {
        kind: 'Chain', base: baseRef, segments, line: t.line,
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

  /**
   * Parse a contiguous run of chain segments after a leading dot
   * has been consumed (so the FIRST segment is name-based — a
   * member or method). This is the path used when the chain
   * originates from `obj.…`.
   *
   * The grammar in EBNF:
   *
   *   chain-tail-dotted = name-segment chain-tail ;
   *   name-segment      = IDENT [ '(' arg-list ')' ] ;
   *   chain-tail        = { '.' name-segment | '[' index-list ']' } ;
   */
  private parseChainSegments(): ChainSegment[] {
    const segments: ChainSegment[] = [];
    segments.push(this.parseNameSegment());
    segments.push(...this.parseChainTail());
    return segments;
  }

  /**
   * Parse zero or more trailing chain segments — `.name` /
   * `.name(args)` / `[index]` / `(args)`. Stops at the first
   * non-segment token. Used after every segment is consumed to
   * pick up the next link if any.
   *
   * The `(args)` form (without a leading `.`) is the TwinCAT
   * array-of-FBs invocation pattern: `fb_MC_Power[IDX](Axis:=…)`.
   * Semantically it's "call this slot"; we represent it as a
   * 'call' chain segment.
   */
  private parseChainTail(): ChainSegment[] {
    const segments: ChainSegment[] = [];
    while (true) {
      if (this.acceptPunct('.')) {
        segments.push(this.parseNameSegment());
        continue;
      }
      const t = this.peek();
      if (t.kind === 'PUNCT' && t.value === '[') {
        segments.push(this.parseIndexSegment());
        continue;
      }
      if (t.kind === 'PUNCT' && t.value === '(') {
        // `(args)` after a chain segment is a call on that
        // segment's result. Emit a 'call' segment that carries
        // the arg list; the runtime treats it identically to a
        // method segment for chain-key purposes.
        //
        // We don't guard on segments.length because callers
        // always establish chain context before invoking us —
        // a bare `(args)` with no preceding chain context only
        // appears inside parseCallArgList, not here.
        const openTok = t;
        this.consume(); // (
        const args = this.parseCallArgList();
        segments.push({
          kind: 'call',
          args,
          line: openTok.line,
          column: openTok.column,
        });
        continue;
      }
      break;
    }
    return segments;
  }

  /** Parse `IDENT` or `IDENT(args)` as a chain segment. */
  private parseNameSegment(): ChainSegment {
    const nameTok = this.peek();
    if (nameTok.kind !== 'IDENT' && nameTok.kind !== 'KEYWORD') {
      throw this.err(
        nameTok,
        `expected member name after ".", got ${describeToken(nameTok)}`,
      );
    }
    this.consume();
    if (this.acceptPunct('(')) {
      const args = this.parseCallArgList();
      return {
        kind: 'method',
        name: nameTok.value,
        nameLower: nameTok.value.toLowerCase(),
        args,
        line: nameTok.line,
        column: nameTok.column,
      };
    }
    return {
      kind: 'member',
      name: nameTok.value,
      nameLower: nameTok.value.toLowerCase(),
      line: nameTok.line,
      column: nameTok.column,
    };
  }

  /** Parse `[expr, expr, ...]` as an index segment. Caller has
   *  confirmed the next token is `[` but not consumed it. */
  private parseIndexSegment(): ChainSegment {
    const openTok = this.peek();
    this.expectPunct('[');
    const indices: Expr[] = [];
    indices.push(this.parseExpression());
    while (this.acceptPunct(',')) {
      indices.push(this.parseExpression());
    }
    this.expectPunct(']');
    return {
      kind: 'index',
      indices,
      line: openTok.line,
      column: openTok.column,
    };
  }

  /** Read a (possibly empty) parenthesised arg list AFTER the
   *  opening `(` has been consumed. Returns the args and consumes
   *  the matching `)`. Shared by the simple-call path in primary
   *  and by chain-segment method calls. */
  private parseCallArgList(): CallArg[] {
    const args: CallArg[] = [];
    if (this.acceptPunct(')')) return args;
    args.push(this.parseCallArg());
    while (this.acceptPunct(',')) {
      args.push(this.parseCallArg());
    }
    this.expectPunct(')');
    return args;
  }

  /**
   * Parse one argument inside a call's parens. Three shapes:
   *
   *   expr            — positional
   *   IDENT := expr   — named input (FB inputs, but also valid
   *                     for built-ins that ignore the name)
   *   IDENT => IDENT  — named output (FB only). The right side
   *                     must be a plain variable name — the FB's
   *                     output gets copied there after the call.
   *
   * The decision is made by looking ahead two tokens. If we see
   * IDENT followed by ':=' or '=>', it's a named arg.
   */
  private parseCallArg(): CallArg {
    const first = this.peek();
    if (first.kind === 'IDENT') {
      const next = this.peek(1);
      if (next.kind === 'PUNCT' && next.value === ':=') {
        // named-in
        this.consume(); // IDENT
        this.consume(); // :=
        // TwinCAT allows `Param := ,` and `Param := )` — an
        // explicit "skip this binding" form, leaving the FB's
        // input at its default. Detect by looking at the next
        // token; if it's `,` or `)`, we emit a named-in arg with
        // value=null (matching named-out's convention for the
        // unbound form). The interpreter ignores null-valued
        // named-in args when ticking known FBs; on unknown FBs
        // the whole call is a no-op anyway.
        const peek = this.peek();
        if (peek.kind === 'PUNCT' && (peek.value === ',' || peek.value === ')')) {
          return {
            kind: 'named-in',
            name: first.value,
            nameLower: first.value.toLowerCase(),
            value: null,
            target: null,
            line: first.line,
          };
        }
        const value = this.parseExpression();
        return {
          kind: 'named-in',
          name: first.value,
          nameLower: first.value.toLowerCase(),
          value,
          target: null,
          line: first.line,
        };
      }
      if (next.kind === 'PUNCT' && next.value === '=>') {
        // Named-out: `OutName => target` where the FB's output
        // is copied to a variable after the call. The target is
        // OPTIONAL — TwinCAT lets the user write `Q =>` (or
        // `Q => ,`) to declare an output without binding it.
        // Treat the missing target as a no-op binding (we still
        // emit a named-out arg so the FB schema sees the output
        // was named, but with target=null the interpreter just
        // skips the post-call copy).
        this.consume(); // IDENT (param name)
        this.consume(); // =>
        const tgt = this.peek();
        if (tgt.kind === 'IDENT') {
          this.consume();
          return {
            kind: 'named-out',
            name: first.value,
            nameLower: first.value.toLowerCase(),
            value: null,
            target: {
              kind: 'VarRef',
              name: tgt.value,
              nameLower: tgt.value.toLowerCase(),
              line: tgt.line,
              column: tgt.column,
            },
            line: first.line,
          };
        }
        // Empty target (the next token is `,` or `)`). Accept it.
        if (tgt.kind === 'PUNCT' && (tgt.value === ',' || tgt.value === ')')) {
          return {
            kind: 'named-out',
            name: first.value,
            nameLower: first.value.toLowerCase(),
            value: null,
            target: null,
            line: first.line,
          };
        }
        throw this.err(
          tgt,
          `expected variable name or "," / ")" after "=>", got ${describeToken(tgt)}`,
        );
      }
    }
    // Positional
    const expr = this.parseExpression();
    return {
      kind: 'positional',
      name: '',
      nameLower: '',
      value: expr,
      target: null,
      line: first.line,
    };
  }

  private peekKw(value: string): boolean {
    const t = this.peek();
    return t.kind === 'KEYWORD' && t.value === value;
  }
}

// --- Post-parse cross-checks ----------------------------------

/**
 * Walk `body` and collect every chain-base identifier that isn't
 * already in `vars`. Append synthetic `unknown`-typed VarDecls
 * for each one. This is what makes patterns like
 *
 *   `FOR IDX := 1 TO XTS_Configuration.MoverCount DO …`
 *
 * work without forcing the user to mirror namespaced globals
 * into the local VAR block — the runtime treats the synthetic
 * decl as an unknown FB instance, so reads of any chain on it
 * follow the standard "poke me" flow.
 *
 * The synthetic decls go into a dedicated 'EXTERNAL' section so
 * they're visually distinct in the watch table — the user can
 * see at a glance that the runtime invented these.
 *
 * Only chain BASES are synthesised, not other undeclared names.
 * Bare undeclared identifiers (e.g. `Foo := 1;`) still fail
 * validation — they're far more likely to be typos than valid
 * namespace references.
 */
function autoDeclareChainBases(body: Statement[], vars: VarDecl[]): void {
  const declared = new Set(vars.map((v) => v.nameLower));
  const missing = new Map<string, { name: string; line: number }>();

  function collectFromExpr(e: Expr): void {
    switch (e.kind) {
      case 'Literal': return;
      case 'VarRef': return;
      case 'Unary': collectFromExpr(e.operand); return;
      case 'Binary': collectFromExpr(e.left); collectFromExpr(e.right); return;
      case 'Member':
        if (!declared.has(e.object.nameLower) && !missing.has(e.object.nameLower)) {
          missing.set(e.object.nameLower, { name: e.object.name, line: e.line });
        }
        return;
      case 'Call':
        for (const a of e.args) {
          if (a.value) collectFromExpr(a.value);
        }
        return;
      case 'Chain':
        if (!declared.has(e.base.nameLower) && !missing.has(e.base.nameLower)) {
          missing.set(e.base.nameLower, { name: e.base.name, line: e.line });
        }
        for (const seg of e.segments) {
          if (seg.kind === 'method' || seg.kind === 'call') {
            for (const a of seg.args) {
              if (a.value) collectFromExpr(a.value);
            }
          } else if (seg.kind === 'index') {
            for (const idx of seg.indices) collectFromExpr(idx);
          }
        }
        return;
    }
  }

  function collectFromStmt(s: Statement): void {
    switch (s.kind) {
      case 'Assign': collectFromExpr(s.value); return;
      case 'ChainAssign': collectFromExpr(s.target); collectFromExpr(s.value); return;
      case 'If':
        for (const b of s.branches) {
          if (b.condition) collectFromExpr(b.condition);
          for (const inner of b.body) collectFromStmt(inner);
        }
        return;
      case 'Case':
        collectFromExpr(s.selector);
        for (const b of s.branches) {
          for (const l of b.labels) {
            collectFromExpr(l.low);
            if (l.kind === 'Range') collectFromExpr(l.high);
          }
          for (const inner of b.body) collectFromStmt(inner);
        }
        return;
      case 'For':
        collectFromExpr(s.start); collectFromExpr(s.end);
        if (s.step) collectFromExpr(s.step);
        for (const inner of s.body) collectFromStmt(inner);
        return;
      case 'While':
        collectFromExpr(s.condition);
        for (const inner of s.body) collectFromStmt(inner);
        return;
      case 'Repeat':
        for (const inner of s.body) collectFromStmt(inner);
        collectFromExpr(s.until);
        return;
      case 'ExpressionStmt': collectFromExpr(s.expression); return;
      // Exit / Continue / Return: nothing to scan.
    }
  }

  for (const s of body) collectFromStmt(s);

  for (const [nameLower, info] of missing) {
    vars.push({
      name: info.name,
      nameLower,
      type: { kind: 'unknown', unknownName: '(auto)', line: info.line },
      section: 'EXTERNAL',
      initial: null,
      line: info.line,
    });
  }
}

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
        // Each arg is a CallArg now. Positional and named-in carry
        // an expression in `value`; named-out carries a `target`
        // VarRef that must reference a declared variable.
        for (const a of e.args) {
          if (a.value) visitExpr(a.value);
          if (a.target) {
            if (!declared.has(a.target.nameLower)) {
              throw new StParseError(
                'parse', a.target.line, 1,
                `undeclared output target "${a.target.name}" in call to "${e.name}"`,
              );
            }
          }
        }
        return;
      case 'Member':
        // The object must be a declared variable. Whether the
        // member name is valid is checked at runtime (depends on
        // the variable's FB type).
        if (!declared.has(e.object.nameLower)) {
          throw new StParseError(
            'parse', e.line, 1,
            `undeclared variable "${e.object.name}" before "."`,
          );
        }
        return;
      case 'Chain':
        // Same rule: the base of a chain must be a declared
        // variable. Segments aren't validated here — they refer
        // to fields/methods on an unknown FB type, which the
        // runtime treats as poke-only.
        if (!declared.has(e.base.nameLower)) {
          throw new StParseError(
            'parse', e.line, 1,
            `undeclared variable "${e.base.name}" before "."`,
          );
        }
        // Walk args of method/call segments and indices of index
        // segments so undeclared variables inside those
        // subexpressions still get caught.
        for (const seg of e.segments) {
          if (seg.kind === 'method' || seg.kind === 'call') {
            const segLabel = seg.kind === 'method' ? `.${seg.name}` : '(...)';
            for (const a of seg.args) {
              if (a.value) visitExpr(a.value);
              if (a.target) {
                if (!declared.has(a.target.nameLower)) {
                  throw new StParseError(
                    'parse', a.target.line, 1,
                    `undeclared output target "${a.target.name}" in call to "${segLabel}"`,
                  );
                }
              }
            }
          } else if (seg.kind === 'index') {
            for (const idx of seg.indices) visitExpr(idx);
          }
        }
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
      case 'ChainAssign':
        // The base of the LHS chain must be a declared variable.
        // Re-using the Chain case via visitExpr handles both base
        // validation AND any args inside method segments.
        visitExpr(s.target);
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

/** Short, human-readable summary of an expression for diagnostic
 *  messages. Used only by parse-time "can't assign to <x>" errors,
 *  so it doesn't need to handle every shape gracefully — anything
 *  unrecognised collapses to "this expression". */
function describeExprForDiag(e: Expr): string {
  switch (e.kind) {
    case 'Literal': return 'a literal';
    case 'Call': return `the call to "${e.name}"`;
    case 'Unary': return 'a unary expression';
    case 'Binary': return 'an arithmetic/logical expression';
    case 'Chain': return 'a method-call result';
    default: return 'this expression';
  }
}

/** Render a TypeRef as the user would have typed it. Used in
 *  diagnostics and to build the unknownName of nested ARRAY
 *  declarations. */
function describeTypeRef(t: TypeRef): string {
  if (t.kind === 'scalar') return t.name;
  if (t.kind === 'fb') return t.name;
  return t.unknownName;
}
