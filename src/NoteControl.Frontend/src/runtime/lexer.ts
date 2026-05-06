/**
 * Lexer for the v1 Structured Text subset.
 *
 * Produces a flat token stream. The parser handles the rest.
 *
 * Tokens we emit:
 *
 *   IDENT       — identifiers (case preserved, but parser
 *                 lowercases for keyword/symbol-table lookup)
 *   KEYWORD     — reserved word in the v1 grammar (PROGRAM,
 *                 VAR, IF, FOR, ...). Pre-lowercased.
 *   NUMBER      — integer or real literal, value as a string;
 *                 the parser converts. Includes 16#FF, 2#1010,
 *                 8#777 forms (with the typed-prefix UDINT#42
 *                 stripped at lex time — we don't model the
 *                 type prefix in v1).
 *   STRING      — 'single' or "double" quoted string literal.
 *   TIME        — a TIME literal like T#100ms; value normalised
 *                 to a millisecond count and emitted as a
 *                 NUMBER-like string (the parser tags it as a
 *                 TIME literal).
 *   PUNCT       — operators and punctuation: := = <> < <= > >=
 *                 + - * / ( ) , ; : ..  (etc.)
 *   EOF
 *
 * Comments are skipped silently. Newlines are skipped but
 * tracked in the line counter.
 *
 * Case handling: keywords are case-insensitive in ST. We lower
 * the lookup string and check against a fixed set; the original
 * casing is dropped for keywords (we don't need it). For
 * identifiers we keep the original casing because the user
 * sees it in the watch panel — TwinCAT preserves the spelling
 * of the first declaration.
 */

import { StParseError } from './errors';

export type TokenKind =
  | 'IDENT'
  | 'KEYWORD'
  | 'NUMBER'
  | 'STRING'
  | 'TIME'
  | 'PUNCT'
  | 'EOF';

export interface Token {
  kind: TokenKind;
  /** For KEYWORD/PUNCT: the canonical lowercase form for KEYWORD,
   *  the literal symbol for PUNCT (e.g. ':='). For IDENT: the
   *  user's original casing. For NUMBER/STRING/TIME: the parsed
   *  text (decimal digits, the string contents without quotes,
   *  or the millisecond count as a decimal string). */
  value: string;
  /** 1-indexed line in the source. */
  line: number;
  /** 1-indexed column where the token starts. */
  column: number;
}

const KEYWORDS = new Set([
  // Structure
  'program', 'end_program',
  'function', 'end_function',
  'function_block', 'end_function_block',
  'var', 'var_input', 'var_output', 'var_in_out',
  'var_temp', 'var_global', 'var_external', 'end_var',
  // Control
  'if', 'then', 'elsif', 'else', 'end_if',
  'case', 'of', 'end_case',
  'for', 'to', 'by', 'do', 'end_for',
  'while', 'end_while',
  'repeat', 'until', 'end_repeat',
  'exit', 'continue', 'return',
  // Operators / literals (treated as keywords because they're
  // word-shaped — easier to lex once and let the parser dispatch
  // on value)
  'and', 'or', 'xor', 'not', 'mod',
  'true', 'false',
]);

/**
 * Two-character punctuation that must be tested before
 * single-char alternatives. `:=` before `:`, `<>`/`<=` before
 * `<`, `>=` before `>`, `..` before `.` (range in CASE labels).
 */
const PUNCT_TWO = ['..', ':=', '<>', '<=', '>=', '**'];
const PUNCT_ONE = '+-*/();,:.<>=[]';

/**
 * Public entry point. Returns a flat token stream ending in EOF.
 * Throws StParseError on any unrecognised input.
 */
export function tokenize(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = source.length;

  const col = () => i - lineStart + 1;

  while (i < n) {
    const ch = source[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      line++;
      i++;
      lineStart = i;
      continue;
    }

    // Line comment // ...
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    // Block comment (* ... *)
    if (ch === '(' && source[i + 1] === '*') {
      const startLine = line;
      const startCol = col();
      i += 2;
      while (i < n) {
        if (source[i] === '*' && source[i + 1] === ')') {
          i += 2;
          break;
        }
        if (source[i] === '\n') {
          line++;
          i++;
          lineStart = i;
        } else {
          i++;
        }
      }
      if (i >= n) {
        throw new StParseError(
          'lex', startLine, startCol,
          'unterminated block comment',
        );
      }
      continue;
    }

    // String literals: 'single' and "double"
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const startLine = line;
      const startCol = col();
      i++; // past opening quote
      let str = '';
      while (i < n && source[i] !== quote) {
        if (source[i] === '\n') {
          // ST strings are single-line — multi-line is a parse
          // error rather than letting the lexer drift.
          throw new StParseError(
            'lex', startLine, startCol,
            'unterminated string literal (newline inside)',
          );
        }
        if (source[i] === '$' && i + 1 < n) {
          // ST escape: $L $N $P $R $T $$ $' $"  (we don't
          // implement them all; pass through as-is for v1)
          str += source[i] + source[i + 1];
          i += 2;
        } else {
          str += source[i];
          i++;
        }
      }
      if (i >= n) {
        throw new StParseError(
          'lex', startLine, startCol,
          'unterminated string literal',
        );
      }
      i++; // closing quote
      out.push({ kind: 'STRING', value: str, line: startLine, column: startCol });
      continue;
    }

    // Time literal: T#... or TIME#...  (case-insensitive)
    // Has to be checked before the IDENT path because T is a
    // valid identifier start char.
    if ((ch === 'T' || ch === 't') &&
        (source[i + 1] === '#' ||
         (source.slice(i, i + 5).toUpperCase() === 'TIME#'))) {
      const startLine = line;
      const startCol = col();
      // Skip prefix
      if (source[i + 1] === '#') {
        i += 2;
      } else {
        i += 5;
      }
      let body = '';
      while (i < n) {
        const c = source[i];
        // Allow digits, letters, underscore, and decimal point.
        // Whitespace or punctuation ends the literal.
        if ((c >= '0' && c <= '9') ||
            (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            c === '_' || c === '.') {
          body += c;
          i++;
        } else {
          break;
        }
      }
      const ms = parseTimeLiteral(body, startLine, startCol);
      out.push({
        kind: 'TIME',
        value: String(ms),
        line: startLine, column: startCol,
      });
      continue;
    }

    // Identifier or keyword. Letters, then letters/digits/_.
    if (isAlpha(ch) || ch === '_') {
      const startLine = line;
      const startCol = col();
      const start = i;
      while (i < n && (isAlnum(source[i]) || source[i] === '_')) i++;
      const text = source.slice(start, i);
      const lower = text.toLowerCase();

      // Typed integer prefix: UINT#42, INT#-3, etc. We strip the
      // prefix and tokenise the number — v1 doesn't model the
      // type-prefix beyond range-checking the resulting value
      // against the assignment target. This is a v1 simplification.
      if (i < n && source[i] === '#' && /^[a-z_][a-z0-9_]*$/.test(lower)) {
        // Could be a type prefix; only treat it as one if the
        // following characters form a numeric literal.
        const peek = source[i + 1];
        if (peek && (
          (peek >= '0' && peek <= '9') ||
          peek === '-' || peek === '+'
        )) {
          // Skip the type prefix and the '#'; fall through to the
          // numeric path.
          i++;
          continue; // re-enter the loop, now positioned at the number
        }
      }

      if (KEYWORDS.has(lower)) {
        out.push({ kind: 'KEYWORD', value: lower, line: startLine, column: startCol });
      } else {
        out.push({ kind: 'IDENT', value: text, line: startLine, column: startCol });
      }
      continue;
    }

    // Number — integer, real, or based (16#FF / 2#1010 / 8#777).
    if (isDigit(ch)) {
      const startLine = line;
      const startCol = col();
      const numText = readNumber(source, i, startLine, startCol);
      i += numText.consumed;
      out.push({
        kind: 'NUMBER',
        value: numText.value,
        line: startLine, column: startCol,
      });
      continue;
    }

    // Two-char punctuation
    const two = source.slice(i, i + 2);
    if (PUNCT_TWO.includes(two)) {
      out.push({ kind: 'PUNCT', value: two, line, column: col() });
      i += 2;
      continue;
    }

    // Single-char punctuation
    if (PUNCT_ONE.includes(ch)) {
      out.push({ kind: 'PUNCT', value: ch, line, column: col() });
      i++;
      continue;
    }

    throw new StParseError(
      'lex', line, col(),
      `unexpected character "${ch}"`,
    );
  }

  out.push({ kind: 'EOF', value: '', line, column: col() });
  return out;
}

function isAlpha(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}
function isAlnum(c: string): boolean {
  return isAlpha(c) || isDigit(c);
}
function isHex(c: string): boolean {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

/**
 * Read one numeric literal starting at `i`. Handles:
 *   - 123       decimal
 *   - 1_234     underscored decimal (ST allows them)
 *   - 1.5       real
 *   - 1.5e-3    real with exponent
 *   - 16#FF     hex
 *   - 2#1010    binary
 *   - 8#777     octal
 *
 * Returns the canonical decimal string AS PARSED. The base
 * literals are converted to base-10 at lex time so the parser
 * doesn't have to know about bases.
 *
 * We deliberately don't accept a leading sign here — that's
 * always a unary operator, even in `Counter := -1`. The lexer
 * emits PUNCT '-' followed by NUMBER '1', and the parser
 * folds them.
 */
function readNumber(
  src: string, i: number, line: number, column: number,
): { value: string; consumed: number } {
  const start = i;
  const n = src.length;

  // Read an initial digit run.
  let firstRun = '';
  while (i < n && (isDigit(src[i]) || src[i] === '_')) {
    if (src[i] !== '_') firstRun += src[i];
    i++;
  }

  // Based literal? base#digits
  if (i < n && src[i] === '#') {
    const base = parseInt(firstRun, 10);
    if (base !== 2 && base !== 8 && base !== 16) {
      throw new StParseError(
        'lex', line, column,
        `unsupported integer base ${base} (only 2, 8, 16 are valid)`,
      );
    }
    i++; // past #
    let digits = '';
    while (i < n) {
      const c = src[i];
      if (c === '_') { i++; continue; }
      if (base === 16 ? isHex(c) : isDigit(c)) {
        digits += c;
        i++;
      } else {
        break;
      }
    }
    if (digits.length === 0) {
      throw new StParseError(
        'lex', line, column,
        `expected digits after ${base}#`,
      );
    }
    // Use BigInt to avoid precision loss for 16#FFFFFFFFFFFFFFFF
    // and similar 64-bit values.
    const big = BigInt('0' +
      (base === 2 ? 'b' : base === 8 ? 'o' : 'x') + digits);
    return { value: big.toString(), consumed: i - start };
  }

  // Real? "." followed by digits, or optional exponent
  let frac = '';
  let exp = '';
  if (i < n && src[i] === '.' && i + 1 < n && isDigit(src[i + 1])) {
    i++; // past .
    while (i < n && (isDigit(src[i]) || src[i] === '_')) {
      if (src[i] !== '_') frac += src[i];
      i++;
    }
  }
  if (i < n && (src[i] === 'e' || src[i] === 'E')) {
    let j = i + 1;
    if (j < n && (src[j] === '+' || src[j] === '-')) j++;
    if (j < n && isDigit(src[j])) {
      // Commit to reading the exponent.
      exp += src[i]; // 'e' or 'E'
      i++;
      if (src[i] === '+' || src[i] === '-') {
        exp += src[i];
        i++;
      }
      while (i < n && (isDigit(src[i]) || src[i] === '_')) {
        if (src[i] !== '_') exp += src[i];
        i++;
      }
    }
  }

  const composed = frac.length > 0 || exp.length > 0
    ? firstRun + (frac.length > 0 ? '.' + frac : '') + exp
    : firstRun;
  return { value: composed, consumed: i - start };
}

/**
 * Parse a TIME literal body like "1h2m3s500ms" into milliseconds.
 * Components in any order; sum them. Supports d/h/m/s/ms.
 *
 * Real-PLC quirk: TwinCAT also accepts uppercase suffix and
 * decimal components like "1.5s" → 1500 ms. We accept both.
 */
function parseTimeLiteral(
  body: string, line: number, column: number,
): number {
  if (body.length === 0) {
    throw new StParseError('lex', line, column, 'empty TIME literal');
  }
  // Walk: digits (optional .), then suffix letters.
  let i = 0;
  const n = body.length;
  let totalMs = 0;
  while (i < n) {
    let num = '';
    while (i < n && (isDigit(body[i]) || body[i] === '.')) {
      num += body[i];
      i++;
    }
    let suffix = '';
    while (i < n && !isDigit(body[i])) {
      suffix += body[i].toLowerCase();
      i++;
    }
    if (num.length === 0 || suffix.length === 0) {
      throw new StParseError(
        'lex', line, column,
        `malformed TIME literal "T#${body}"`,
      );
    }
    const v = parseFloat(num);
    let mul: number;
    switch (suffix) {
      case 'ms': mul = 1; break;
      case 's': mul = 1000; break;
      case 'm': mul = 60 * 1000; break;
      case 'h': mul = 60 * 60 * 1000; break;
      case 'd': mul = 24 * 60 * 60 * 1000; break;
      default:
        throw new StParseError(
          'lex', line, column,
          `unknown TIME suffix "${suffix}" (expected ms/s/m/h/d)`,
        );
    }
    totalMs += v * mul;
  }
  // Round to integer ms — PLC TIME has no sub-ms resolution.
  return Math.round(totalMs);
}
