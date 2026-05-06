/**
 * Lenient scanner for "name : Type" pairs in a Structured Text
 * declaration block.
 *
 * Why a separate scanner instead of reusing runtime/parser.ts?
 *
 *   The runtime parser is strict — it throws on the first syntax
 *   error so the modal can show a precise diagnostic. Autocomplete
 *   has the opposite need: while the user is mid-type, the
 *   declaration is almost always partly broken (an unclosed VAR
 *   block, a half-typed type, a missing semicolon). We still want
 *   to surface whatever variables ARE recognisable, so the F2 menu
 *   in the implementation block can offer real choices instead of
 *   nothing.
 *
 *   This file therefore implements a deliberately loose pass:
 *   tokenise, walk forward looking for `IDENT : IDENT` patterns
 *   inside any VAR_* / END_VAR pair, recover on any error by
 *   skipping to the next semicolon. Comments are stripped first.
 *
 * Output is the list of variables we could identify, with their
 * type as a free-text string (we don't classify into scalar /
 * FB / array / pointer here — the caller does that lookup). Order
 * is source order; duplicates by name are kept in case the user
 * re-declared something.
 */

/** A variable declaration recognised inside a VAR_* block. */
export interface ScannedVar {
  /** The variable's identifier as written (case preserved). */
  name: string;
  /**
   * The type token as written (case preserved). Just the first
   * identifier after the `:` — initial values, attributes, and
   * array/pointer wrappers are dropped. So `Counter : UDINT := 0`
   * yields type `UDINT`, and `arr : ARRAY[0..9] OF INT` yields
   * `ARRAY` (good enough for the autocomplete subtitle).
   */
  type: string;
}

/**
 * Strip ST comments — both `(* block *)` and `// line` — and
 * string literals (so a `;` inside a string doesn't confuse the
 * statement splitter). Replaces them with spaces of the same
 * length so column positions stay intact for any future use.
 */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === '(' && c2 === '*') {
      // Block comment. Find the next `*)`. Nested block comments
      // are accepted by some IDEs; we don't try to handle them
      // and just match the first close — the scanner is allowed
      // to be lossy here, no observable difference for variable
      // extraction.
      const end = src.indexOf('*)', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }

    if (c === '/' && c2 === '/') {
      // Line comment to end of line.
      const end = src.indexOf('\n', i + 2);
      const stop = end === -1 ? n : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }

    if (c === "'" || c === '"') {
      // String literal. ST strings don't allow embedded newlines
      // (matches the highlighter and runtime lexer). Treat any
      // mismatch as end-of-line for safety.
      const quote = c;
      let j = i + 1;
      while (j < n && src[j] !== quote && src[j] !== '\n') j++;
      const stop = j < n && src[j] === quote ? j + 1 : j;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

const VAR_OPEN = /^VAR(?:_INPUT|_OUTPUT|_IN_OUT|_GLOBAL|_TEMP|_EXTERNAL|_STAT|_INST|_CONFIG|_ACCESS)?\b/i;

/**
 * Walk the cleaned source and pull out variable declarations.
 *
 * Strategy:
 *   1. Find every VAR_* keyword. For each, scan forward to the
 *      matching END_VAR (or end-of-text — we recover gracefully).
 *   2. Inside that span, split on `;` and try to parse each chunk
 *      as `IDENT (, IDENT)* : TYPE`. The comma form is legal ST
 *      (`a, b, c : INT;` declares three variables of the same
 *      type) and we expand it into one ScannedVar per name.
 *   3. Anything that doesn't match the pattern is skipped silently.
 *
 * Identifier rules: letters, digits, underscores; not starting
 * with a digit. ST is case-insensitive for keywords but variable
 * names preserve their original case in the source — we keep the
 * original spelling.
 */
export function scanDeclaredVars(declarationText: string): ScannedVar[] {
  const cleaned = stripCommentsAndStrings(declarationText);
  const out: ScannedVar[] = [];

  // Tokenise just enough to find VAR_* boundaries by walking the
  // source line-by-line. A VAR_* keyword can sit anywhere on a
  // line; END_VAR likewise. We do a simple uppercase-word scan.
  //
  // We DON'T require the source to be inside a PROGRAM/END_PROGRAM
  // — TwinCAT exports often omit those when round-tripping
  // declarations, and the user's mid-typing state likely will too.

  const len = cleaned.length;
  let i = 0;

  while (i < len) {
    // Skip whitespace.
    while (i < len && /\s/.test(cleaned[i])) i++;
    if (i >= len) break;

    // Read the next "word" (letters/digits/underscores).
    const wordStart = i;
    while (i < len && /[A-Za-z0-9_]/.test(cleaned[i])) i++;
    if (i === wordStart) {
      // Non-word char (a punctuation we don't care about at this
      // outer level). Step over it.
      i++;
      continue;
    }
    const word = cleaned.slice(wordStart, i);

    if (!VAR_OPEN.test(word)) continue;

    // We're inside a VAR_* block. Capture text up to END_VAR (or
    // EOF) — that's our extraction span.
    const blockStart = i;
    let blockEnd = len;
    // Cheap forward scan for END_VAR as a whole word.
    const endRe = /\bEND_VAR\b/gi;
    endRe.lastIndex = blockStart;
    const m = endRe.exec(cleaned);
    if (m) blockEnd = m.index;

    extractFromVarBlock(cleaned.slice(blockStart, blockEnd), out);

    // Advance past the END_VAR we just matched (or to EOF).
    i = m ? endRe.lastIndex : blockEnd;
  }

  return out;
}

/** Identifier shape for ST: starts with letter/_, then alnum/_. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse each `;`-terminated chunk inside a VAR block. Acceptable
 * shapes (after trimming):
 *
 *   foo : INT
 *   foo : INT := 0
 *   foo, bar, baz : INT
 *   foo AT %IX0.0 : BOOL              (TwinCAT direct address)
 *   foo : ARRAY [0..9] OF INT
 *   foo : POINTER TO INT
 *   foo {attribute 'x'} : INT         (TwinCAT pragma)
 *
 * We only need the names and the leading type token. Anything
 * else is dropped on the floor.
 */
function extractFromVarBlock(block: string, out: ScannedVar[]): void {
  const stmts = block.split(';');
  for (const raw of stmts) {
    const stmt = raw.trim();
    if (stmt.length === 0) continue;

    // Find the first colon that's NOT inside a {..} pragma. Most
    // TwinCAT pragmas don't contain `:`, but be defensive.
    const colon = findTopLevelColon(stmt);
    if (colon < 0) continue;

    const left = stmt.slice(0, colon).trim();
    const right = stmt.slice(colon + 1).trim();

    // Strip any trailing `:= initial` from right side, and any
    // attributes/pragmas/AT addresses from the left side.
    const typeName = readLeadingType(right);
    if (!typeName) continue;

    const names = readNameList(left);
    for (const name of names) {
      out.push({ name, type: typeName });
    }
  }
}

/** Find the first `:` not inside `{...}`. Returns -1 if none. */
function findTopLevelColon(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ':' && depth === 0) {
      // Don't match `:=` as the type colon — that's an assignment
      // operator, which shouldn't appear before the type colon
      // anyway, but a malformed line might have it. Bail on `:=`.
      if (s[i + 1] === '=') return -1;
      return i;
    }
  }
  return -1;
}

/**
 * Pull the leading type token off the right-hand side. Walks past
 * any leading whitespace, then reads the first identifier. We
 * intentionally don't try to reconstruct e.g. `ARRAY [0..9] OF INT`
 * — for the autocomplete subtitle "ARRAY" is informative enough.
 */
function readLeadingType(rhs: string): string | null {
  // Trim a leading "REFERENCE TO" / "POINTER TO" so the displayed
  // type is the underlying type — most users care about the
  // pointee, not the wrapper.
  let s = rhs;
  for (;;) {
    const trimmed = s.replace(/^\s+/, '');
    if (/^REFERENCE\s+TO\b/i.test(trimmed)) {
      s = trimmed.replace(/^REFERENCE\s+TO\b/i, '');
      continue;
    }
    if (/^POINTER\s+TO\b/i.test(trimmed)) {
      s = trimmed.replace(/^POINTER\s+TO\b/i, '');
      continue;
    }
    s = trimmed;
    break;
  }

  const m = s.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  return m ? m[0] : null;
}

/**
 * From the left side of `name(, name)* : T`, return the names.
 * Strips TwinCAT pragmas (curly-brace blocks) and `AT %ADDR`
 * direct-address suffixes — both are legal but not useful here.
 */
function readNameList(lhs: string): string[] {
  // Drop curly-brace pragmas anywhere in the lhs.
  const noPragma = lhs.replace(/\{[^}]*\}/g, ' ');

  // Drop a trailing `AT %ADDR` clause from each comma-segment. The
  // ST grammar only allows AT for a single variable, but be loose.
  const segs = noPragma.split(',');
  const names: string[] = [];
  for (const seg of segs) {
    const cleaned = seg.replace(/\bAT\s+%\S+/i, '').trim();
    if (IDENT_RE.test(cleaned)) names.push(cleaned);
  }
  return names;
}
