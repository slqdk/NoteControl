/**
 * Error types produced by the lexer, parser, and (later)
 * interpreter. All carry a 1-indexed line number so the modal
 * can highlight the offending line.
 *
 * `phase` discriminates the source of the error in user-facing
 * output. Lex and parse errors come from static analysis;
 * runtime errors come from execution.
 */

export class StParseError extends Error {
  readonly phase: 'lex' | 'parse';
  readonly line: number;
  readonly column: number;

  constructor(
    phase: 'lex' | 'parse',
    line: number,
    column: number,
    message: string,
  ) {
    super(message);
    this.name = 'StParseError';
    this.phase = phase;
    this.line = line;
    this.column = column;
  }

  /** A short, user-friendly one-liner with the location prefix. */
  format(): string {
    const phaseLabel = this.phase === 'lex' ? 'Lex' : 'Parse';
    return `${phaseLabel} error at line ${this.line}: ${this.message}`;
  }
}

/**
 * Runtime errors. Reserved for the interpreter shipped in a
 * later step — exported now so the type plumbing is complete.
 *
 * `kind` is a programmatic code so the UI can decide on icons /
 * colours without parsing the message string.
 */
export type RuntimeErrorKind =
  | 'div-by-zero'
  | 'overflow'
  | 'unknown-builtin'
  | 'type-mismatch'
  | 'index-out-of-range'
  | 'internal';

export class StRuntimeError extends Error {
  readonly kind: RuntimeErrorKind;
  readonly line: number;

  constructor(kind: RuntimeErrorKind, line: number, message: string) {
    super(message);
    this.name = 'StRuntimeError';
    this.kind = kind;
    this.line = line;
  }

  format(): string {
    return `Runtime error at line ${this.line}: ${this.message}`;
  }
}
