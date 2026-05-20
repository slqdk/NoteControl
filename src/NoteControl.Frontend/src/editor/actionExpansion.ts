/**
 * Action expansion (the "inline-substitute action calls" step).
 *
 * Background: in TwinCAT, an ACTION on a function block has no
 * own variables, no parameters, no return value — its body
 * executes in the parent FB's scope. Calls to an action can use
 * either of two syntaxes:
 *
 *   AbortMover();   // parens-empty
 *   AbortMover;     // parens-elided (TwinCAT allows it)
 *
 * Semantically the compiler splices the action's body into the
 * call site. That's exactly the behaviour this module
 * implements: given an FB implementation source and a map of
 * action-name → action-body strings, return a new source string
 * with every action-call site rewritten as the action's body.
 *
 * Ship 2 design choices (set in chat):
 *   - Recognise bare-name calls only: "Name()" and "Name;".
 *     No "fb.Action()" / no "ns.Action()". Per Søren.
 *   - Names match case-insensitively (matches TwinCAT identifier
 *     rules — `abortmover` and `AbortMover` are the same symbol).
 *   - Skip strings ('…') and comments (//… and (*…*)). Action-
 *     name-shaped tokens inside those are left alone.
 *   - Recursive action calls are supported by iterating expansion
 *     until a fixed point. Max 16 iterations; throw on overflow
 *     with a message pointing at the cycle.
 *
 * Non-goals:
 *   - We do NOT parse ST or build an AST here. The interpreter
 *     handles that downstream, on the already-expanded source.
 *   - We do NOT renumber lines. Expanded action bodies retain
 *     their original line breaks, so runtime errors inside an
 *     inlined action's body will report a line number against
 *     the *expanded* implementation — which is the source the
 *     parser saw. That's the least-surprising model: the same
 *     text the interpreter executes is the text the user can
 *     copy/paste to debug. Pre-expansion line numbers are not
 *     preserved (a queue item if it ever matters).
 *
 *   - We do NOT validate that the inlined action body parses on
 *     its own. The full expanded source is parsed by the
 *     interpreter; if an action's body had a syntax error, the
 *     interpreter will surface it at the post-expansion line.
 */

/** Map of action-name (lower-cased) → body text. */
export type ActionBodies = Map<string, string>;

const MAX_EXPANSION_PASSES = 16;

/**
 * Expand action calls in `source` using `actionBodies`.
 *
 * Iterates until no further substitutions happen or
 * MAX_EXPANSION_PASSES is reached. Returns the expanded text.
 *
 * Throws Error when:
 *   - Expansion didn't reach a fixed point within
 *     MAX_EXPANSION_PASSES passes. The message names a sample
 *     action that's still being substituted on the last pass —
 *     usually the entry point of the cycle.
 *
 * Idempotent on a source with no action calls (returns the
 * input string, no allocations beyond the one pass that detects
 * "nothing to do").
 */
export function expandActions(
  source: string,
  actionBodies: ActionBodies,
): string {
  if (actionBodies.size === 0) return source;

  let current = source;
  for (let pass = 0; pass < MAX_EXPANSION_PASSES; pass++) {
    const { output, expandedAnything, lastExpandedName } = expandOnePass(current, actionBodies);
    if (!expandedAnything) {
      return output;
    }
    current = output;
    // Loop carries on; only break on no-change above, or fall
    // through to the cycle error below.
    if (pass === MAX_EXPANSION_PASSES - 1) {
      throw new Error(
        `Action expansion exceeded ${MAX_EXPANSION_PASSES} passes — ` +
          `likely a recursive action cycle. ` +
          (lastExpandedName
            ? `Last expanded action: "${lastExpandedName}". ` +
              `Check whether "${lastExpandedName}" (or an action it calls) ` +
              `calls back into itself.`
            : 'Unable to identify the offending action.'),
      );
    }
  }
  // Defensive — the loop above always either returns or throws.
  return current;
}

/**
 * Result of one expansion pass.
 *
 *   output            — the source with one round of substitutions
 *                       applied.
 *   expandedAnything  — true iff at least one substitution happened
 *                       in this pass. The driver loops only while
 *                       this is true.
 *   lastExpandedName  — case-preserved name of the last action that
 *                       was substituted in this pass. Used for the
 *                       cycle-error message — not for any semantic
 *                       decision.
 */
interface PassResult {
  output: string;
  expandedAnything: boolean;
  lastExpandedName: string | null;
}

/**
 * One pass over `source`: walk it as a tiny state machine
 * (code / string / line-comment / block-comment), and at each
 * identifier in code mode check whether (a) it's NOT preceded by
 * a '.' (which would make it a member access), and (b) the
 * following tokens form a bare action call — "()" or ";". When
 * both hold, replace the whole match (identifier + tail) with the
 * action body. Otherwise leave it alone.
 *
 * Returns the rewritten string. Calling this repeatedly until
 * `expandedAnything === false` produces the fully-expanded form.
 */
function expandOnePass(
  source: string,
  actionBodies: ActionBodies,
): PassResult {
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  let mode: 'code' | 'string' | 'line-comment' | 'block-comment' = 'code';
  let expandedAnything = false;
  let lastExpandedName: string | null = null;

  while (i < n) {
    const c = source[i];

    // --- Mode-exit transitions first (mode → code) ----------------
    if (mode === 'string') {
      // ST string. Single-quote terminator; '$$' escapes are not
      // identifier-like so we don't worry about them. A '$''
      // (dollar-quote-quote) is the canonical embedded-quote
      // escape; we handle it by skipping the next char after '$'.
      if (c === '$' && i + 1 < n) {
        out.push(c);
        out.push(source[i + 1]);
        i += 2;
        continue;
      }
      if (c === "'") {
        out.push(c);
        i++;
        mode = 'code';
        continue;
      }
      out.push(c);
      i++;
      continue;
    }
    if (mode === 'line-comment') {
      if (c === '\n') {
        mode = 'code';
      }
      out.push(c);
      i++;
      continue;
    }
    if (mode === 'block-comment') {
      // Closing token is '*)'. Block comments do NOT nest in ST.
      if (c === '*' && source[i + 1] === ')') {
        out.push('*)');
        i += 2;
        mode = 'code';
        continue;
      }
      out.push(c);
      i++;
      continue;
    }

    // --- mode === 'code' ------------------------------------------
    // Check for mode-enter triggers first.
    if (c === "'") {
      out.push(c);
      i++;
      mode = 'string';
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      out.push('//');
      i += 2;
      mode = 'line-comment';
      continue;
    }
    if (c === '(' && source[i + 1] === '*') {
      out.push('(*');
      i += 2;
      mode = 'block-comment';
      continue;
    }

    // Identifier start? Note that the "preceding char" rule for
    // member-access is checked using the LAST char emitted, not
    // the next char in the source — since out[] is what we've
    // committed, peeking at out[out.length - 1] tells us what
    // came before this identifier in the final output.
    if (isIdentStart(c)) {
      const start = i;
      let end = i + 1;
      while (end < n && isIdentPart(source[end])) end++;
      const ident = source.substring(start, end);

      // Is the preceding non-whitespace char a '.'? If so, this
      // is a member access (`fb.Foo`), and we leave it alone.
      let prevIdx = out.length - 1;
      while (prevIdx >= 0 && isWhitespace(out[prevIdx])) prevIdx--;
      const isMemberAccess = prevIdx >= 0 && out[prevIdx] === '.';

      // Is the trailing sequence a bare-action-call shape?
      const tail = matchActionCallTail(source, end);

      if (!isMemberAccess && tail !== null) {
        const lower = ident.toLowerCase();
        const body = actionBodies.get(lower);
        if (body !== undefined) {
          // Substitute. The action body replaces the identifier
          // AND the tail tokens (i.e. the parens or semicolon).
          //
          // Subtlety: if the call was `Foo;`, the semicolon is
          // PART of the tail and so part of what we replace.
          // After substitution we don't add the semicolon back —
          // the body itself is full ST that should already have
          // its own terminators where it needs them. If the call
          // was `Foo()`, the parens are the tail and we don't
          // add anything afterwards either. Mirrors TwinCAT's
          // semantics: an action body executes in place of its
          // call-and-terminator.
          out.push(body);
          i = end + tail.consumed;
          expandedAnything = true;
          lastExpandedName = ident;
          continue;
        }
      }

      // No substitution — emit the identifier verbatim.
      out.push(ident);
      i = end;
      continue;
    }

    // Non-identifier code character — just pass through.
    out.push(c);
    i++;
  }

  return {
    output: out.join(''),
    expandedAnything,
    lastExpandedName,
  };
}

/**
 * After an identifier ending at position `start`, look ahead to
 * see whether the following tokens form a bare-action-call tail:
 *
 *   - "()"      with optional whitespace between identifier and
 *               '(' and inside the parens
 *   - ";"       with optional whitespace between identifier and
 *               ';'
 *
 * Returns the number of source characters consumed by the tail
 * (so the caller can advance past it), or null when no match.
 *
 * The tail consumption deliberately includes any preceding
 * whitespace, so substitution doesn't leave dangling spaces
 * before the substituted body.
 *
 * Note: this does NOT consume a trailing newline. The action
 * body's own trailing newline (if any) plus the next line's
 * content carry on as before. That keeps the substitution
 * minimally invasive.
 */
function matchActionCallTail(
  source: string,
  start: number,
): { consumed: number } | null {
  let i = start;
  const n = source.length;
  while (i < n && isWhitespace(source[i])) i++;
  if (i >= n) return null;

  if (source[i] === '(') {
    // Need a closing ')' after only whitespace inside.
    let j = i + 1;
    while (j < n && isWhitespace(source[j])) j++;
    if (j < n && source[j] === ')') {
      // Also consume an optional trailing ';' — TwinCAT
      // statements always end with ';', and Foo() inside an IF
      // / WHILE expression position is unusual but legal; we
      // consume the trailing ';' when present so we don't leave
      // a stray semicolon next to the substituted body. When
      // absent (e.g. Foo() as expression), we don't add one.
      let k = j + 1;
      while (k < n && isWhitespace(source[k])) k++;
      if (k < n && source[k] === ';') {
        return { consumed: k + 1 - start };
      }
      return { consumed: j + 1 - start };
    }
    return null;
  }

  if (source[i] === ';') {
    return { consumed: i + 1 - start };
  }

  return null;
}

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}
function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n';
}

// --------------------------------------------------------------------
// Sibling-block collection
//
// The other half of Ship 2: when the user hits Run on an
// Implementation block, we need to discover which sibling code
// blocks are actions and build the action-body map.
//
// A sibling action block, per Ship 1.1's emission contract, is a
// code block with:
//   - language === "st"
//   - title matches /^ACTION\s+(.+?)\s+—\s+Implementation$/  (or
//     the ASCII-dash equivalent /-/) — but in practice slashMenu
//     emits a Unicode em-dash, so we accept both. Case-insensitive
//     on the keyword.
//
// Implementation note on dash variants: the em-dash "—" (U+2014)
// is what the Ship 1.1 emitter produces. If a user manually edits
// the title and types a hyphen-minus "-" or an en-dash "–"
// instead, we should still recognise the block — accommodating
// the editor-as-source-of-truth principle. We accept any of "—",
// "–", "-" surrounded by optional whitespace.
// --------------------------------------------------------------------

const ACTION_TITLE_RE =
  /^ACTION\s+(.+?)\s*[—–\-]\s*Implementation\s*$/i;

/**
 * Try to extract the action name from a code-block title. Returns
 * the bare name (e.g. "AbortMover") when the title matches the
 * pattern, or null otherwise. Whitespace is normalised.
 *
 * Exported (not just internal) so other call sites can use the
 * exact same recognition rule — keeps a single source of truth
 * for "is this an action implementation block?".
 */
export function parseActionTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const m = ACTION_TITLE_RE.exec(title);
  if (!m) return null;
  return m[1].trim();
}

/**
 * Walk a list of (title, language, text) tuples and return an
 * ActionBodies map (lower-cased name → body text). When the same
 * action name appears twice, the LAST wins. We don't warn on
 * duplicates — letting the user override an imported action with
 * a hand-edited later block is a legitimate workflow.
 *
 * Caller is responsible for collecting the tuples from the
 * document. Keeping that part out of this module lets us unit-
 * test the substitution logic without any prosemirror dependency.
 */
export function collectActionBodies(
  blocks: ReadonlyArray<{ title: string | null; language: string | null; text: string }>,
): ActionBodies {
  const out: ActionBodies = new Map();
  for (const b of blocks) {
    if (b.language !== 'st') continue;
    const name = parseActionTitle(b.title);
    if (name === null) continue;
    out.set(name.toLowerCase(), b.text);
  }
  return out;
}
