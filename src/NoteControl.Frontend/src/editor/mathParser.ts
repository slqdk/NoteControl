/**
 * Math (LaTeX) parsing and serialization helpers.
 *
 * NoteControl recognises four LaTeX delimiter styles on input:
 *
 *   $...$        inline math   (Pandoc / Obsidian / GitHub style)
 *   $$...$$      block math    (same family)
 *   \(...\)      inline math   (raw LaTeX style)
 *   \[...\]      block math    (raw LaTeX style)
 *
 * On output (markdown serialization) we normalise to the dollar
 * form only. Rationale (see the chat handoff that introduced
 * math support): one canonical on-disk format means a save-then-
 * reload never silently rewrites a file. Files stay portable to
 * Obsidian, GitHub's math rendering, and Pandoc, all of which
 * default to dollars. The `\(...\)` / `\[...\]` styles are still
 * ACCEPTED on paste and on load — we just always emit dollars.
 *
 * --- The "currency $" problem ---
 *
 * Naively pattern-matching `$...$` will eat real text like
 *   "It costs $5 and $10"
 * as if "5 and " were math. The well-trodden solution is the
 * Pandoc rule:
 *
 *   - Opening `$` must NOT be followed by a whitespace character.
 *   - Closing `$` must NOT be preceded by a whitespace character.
 *   - The character right after the closing `$` must NOT be an
 *     ASCII digit (otherwise "$5 and $10" still trips).
 *
 * That's what `MATH_INLINE_DOLLAR` enforces. The `$$...$$` form
 * has no currency ambiguity in practice — two-dollar runs in
 * normal prose are vanishingly rare — so it has a simpler rule:
 * matched pair, no whitespace immediately inside.
 *
 * --- Markdown-safe substitution ---
 *
 * We MUST skip math substitution inside:
 *   - fenced code blocks ( ```...``` and ~~~...~~~ )
 *   - indented code blocks (4-space lines after a blank line —
 *     we approximate this as "any line starting with 4+ spaces
 *     OR a tab", which is over-aggressive but safe)
 *   - inline code spans ( `...` )
 *   - raw HTML tags  ( <...> )
 *
 * Because tiptap-markdown's `html: true` lets raw HTML through,
 * the *output* of this scan is a string with the math spans
 * already replaced by HTML elements that the math node's
 * parseHTML rule will pick up:
 *
 *   $x^2$              →  <span data-math-inline="x^2"></span>
 *   $$\sum_i x_i$$     →  <div data-math-block="\sum_i x_i"></div>
 *
 * (Inner content is escaped for the HTML attribute. The math
 * node reads the attribute back as the raw LaTeX source — never
 * from the element's text content.)
 *
 * --- Paste path ---
 *
 * The paste interceptor (AssetPasteExtension-adjacent) uses the
 * SAME scanner to turn pasted plain text into a string containing
 * the same `<span data-math-inline>` / `<div data-math-block>`
 * placeholders, then hands the result back to TipTap as HTML.
 * Same parseHTML rule picks them up. The paste path skips the
 * "inside code fence" checks since pasted text is usually a
 * fragment, not a complete markdown document — but it still
 * honours backtick-fenced inline code spans inside that fragment.
 */

/**
 * Escape a LaTeX source string so it can be put inside an HTML
 * attribute. We use the conservative full-encode (no ampersands,
 * quotes, or angle brackets survive raw). HTML entity decoding
 * happens automatically when parseHTML reads the attribute back.
 */
export function escapeForHtmlAttr(source: string): string {
  return source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Inverse of escapeForHtmlAttr — called when we lift the attribute
 * value back into a LaTeX source string. Browser-set attribute
 * reads usually do this for us, but we run it defensively for the
 * cases where we pulled the raw attribute string out of HTML
 * we built ourselves (e.g. round-tripping inside test helpers).
 */
export function unescapeFromHtmlAttr(escaped: string): string {
  return escaped
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/**
 * The four kinds of math regions we accept on input. The
 * tokenizer below produces these as a stream so the substitution
 * layer can rewrite them uniformly.
 */
type MathKind = 'inline' | 'block';

interface MathToken {
  kind: MathKind;
  /** Source LaTeX, without the surrounding delimiters. */
  source: string;
  /** Offset of the opening delimiter in the input string. */
  start: number;
  /** Offset just past the closing delimiter in the input string. */
  end: number;
}

/**
 * Scan a markdown-shaped string and rewrite recognised LaTeX
 * delimiters as HTML placeholder elements. Skips inside code
 * fences, inline code spans, and HTML tags.
 *
 * Returns the rewritten string. If nothing matches, returns the
 * original string unchanged (no allocation churn).
 *
 * Options:
 *   - allowFences (default true) — when true, the scanner tracks
 *     fenced/indented code blocks and skips them. When false (the
 *     paste path), only inline backticks are honoured.
 */
export function rewriteMarkdownMathToHtml(
  input: string,
  options: { allowFences?: boolean } = {},
): string {
  if (!hasAnyMathDelimiter(input)) return input;

  const allowFences = options.allowFences !== false;
  const tokens = scanMathTokens(input, { allowFences });
  if (tokens.length === 0) return input;

  // Replay the input, swapping each math token for its HTML
  // placeholder. The tokens list is in source order, so we can
  // do a single forward sweep with a cursor.
  const out: string[] = [];
  let cursor = 0;
  for (const tok of tokens) {
    if (tok.start > cursor) {
      out.push(input.slice(cursor, tok.start));
    }
    if (tok.kind === 'inline') {
      out.push(
        `<span data-math-inline="${escapeForHtmlAttr(tok.source)}"></span>`,
      );
    } else {
      // Block math sits on its own line in canonical markdown,
      // but our placeholder is a self-closing-shaped div that
      // markdown-it will treat as a HTML block. Surround with
      // blank lines to be safe — markdown-it switches into
      // HTML-block mode only when the tag starts at column 0
      // and is preceded by a blank line. We're inserting MID-
      // document though, so we can't always satisfy "preceded
      // by blank line"; rely on markdown-it's lenient HTML
      // handling instead. Empirically: it works for our use
      // case because we always emit on its own line during
      // serialize, and inputs we rewrite here are also on
      // their own line for "$$ ... $$" by convention.
      out.push(
        `<div data-math-block="${escapeForHtmlAttr(tok.source)}"></div>`,
      );
    }
    cursor = tok.end;
  }
  if (cursor < input.length) out.push(input.slice(cursor));
  return out.join('');
}

/**
 * Cheap pre-check so we don't allocate a token list when there's
 * obviously no math to find. Misses `\(` style if the input
 * doesn't also contain a dollar — that's intentional, dollar-
 * only is the common case and we want to early-out cheaply for
 * non-math documents.
 */
function hasAnyMathDelimiter(input: string): boolean {
  if (input.indexOf('$') >= 0) return true;
  if (input.indexOf('\\(') >= 0) return true;
  if (input.indexOf('\\[') >= 0) return true;
  return false;
}

/**
 * Walk the input character by character, tracking the lexical
 * state (in-fence, in-code-span, in-html-tag, plain text). When
 * in plain text, attempt to consume a math token starting at the
 * current cursor. On match, emit a token and advance past it.
 *
 * This is intentionally a small hand-written state machine rather
 * than a regex sweep, because the interactions between fences and
 * delimiters can't be handled cleanly with separate regexes (the
 * "is this $ inside a code block" check has no local signal).
 */
function scanMathTokens(
  input: string,
  options: { allowFences: boolean },
): MathToken[] {
  const tokens: MathToken[] = [];
  const len = input.length;
  let i = 0;

  // Lexical-state flags. Only one is "open" at any time.
  let inFence = false;
  let fenceMarker = '';        // '```' or '~~~'
  let atLineStart = true;
  let inHtmlTag = false;

  while (i < len) {
    const ch = input[i];

    // --- HTML tag tracking ---------------------------------------
    // A `<` that begins a tag suspends math scanning until we hit
    // the matching `>`. We deliberately don't try to be clever
    // about attribute quoting — tags with literal `$` inside an
    // attribute value would be exotic, and our own placeholder
    // tags don't include math source until AFTER substitution.
    if (inHtmlTag) {
      if (ch === '>') inHtmlTag = false;
      i++;
      atLineStart = ch === '\n';
      continue;
    }
    if (ch === '<' && !inFence) {
      // Heuristic: `<` followed by ASCII letter, `/`, or `!` is a
      // tag start. Other `<` is a literal less-than sign.
      const next = input[i + 1];
      if (
        next === '/' ||
        next === '!' ||
        (next !== undefined && /[a-zA-Z]/.test(next))
      ) {
        inHtmlTag = true;
        i++;
        atLineStart = false;
        continue;
      }
    }

    // --- Fence tracking ------------------------------------------
    if (options.allowFences && atLineStart) {
      const fence = matchFenceStart(input, i);
      if (fence) {
        if (inFence) {
          if (fence === fenceMarker) {
            inFence = false;
            fenceMarker = '';
          }
        } else {
          inFence = true;
          fenceMarker = fence;
        }
        // Skip to end of line — fences only matter at line start
        // and the rest of the line is fence info (language tag).
        while (i < len && input[i] !== '\n') i++;
        atLineStart = false;
        continue;
      }
    }
    if (inFence) {
      atLineStart = ch === '\n';
      i++;
      continue;
    }

    // --- Indented code blocks ------------------------------------
    // Approximate rule: a line that begins with 4 spaces or a tab
    // and that line's "in code block" status. We treat the WHOLE
    // line as code when it starts that way. This is conservative
    // (a continuation paragraph inside a list item can also be
    // 4-indented and isn't code) but the cost is "math inside
    // hand-indented prose is left as literal" which is rare and
    // not a correctness bug.
    if (options.allowFences && atLineStart) {
      if (isIndentedCodeLineStart(input, i)) {
        // Skip to end of line.
        while (i < len && input[i] !== '\n') i++;
        atLineStart = false;
        continue;
      }
    }

    // --- Inline code span ----------------------------------------
    // A backtick run starts a code span. We consume up to the
    // matching same-length backtick run. Common case: single
    // backtick.
    if (ch === '`') {
      let runLen = 0;
      while (i + runLen < len && input[i + runLen] === '`') runLen++;
      // Find the next backtick run of the same length.
      const closeIdx = findBacktickRun(input, i + runLen, runLen);
      if (closeIdx >= 0) {
        i = closeIdx + runLen;
        atLineStart = false;
        continue;
      }
      // Unclosed backtick: treat as literal text and move on.
      i += runLen;
      atLineStart = false;
      continue;
    }

    // --- Math: try to consume a token at this position -----------
    const tok = tryConsumeMath(input, i);
    if (tok) {
      tokens.push(tok);
      i = tok.end;
      atLineStart = false;
      continue;
    }

    // --- Plain character -----------------------------------------
    atLineStart = ch === '\n';
    i++;
  }

  return tokens;
}

function matchFenceStart(input: string, i: number): string | null {
  // Allow up to 3 leading spaces before a fence (commonmark).
  let p = i;
  let spaces = 0;
  while (p < input.length && input[p] === ' ' && spaces < 3) {
    p++;
    spaces++;
  }
  if (input[p] === '`' && input[p + 1] === '`' && input[p + 2] === '`') {
    return '```';
  }
  if (input[p] === '~' && input[p + 1] === '~' && input[p + 2] === '~') {
    return '~~~';
  }
  return null;
}

function isIndentedCodeLineStart(input: string, i: number): boolean {
  if (input[i] === '\t') return true;
  return (
    input[i] === ' ' &&
    input[i + 1] === ' ' &&
    input[i + 2] === ' ' &&
    input[i + 3] === ' '
  );
}

function findBacktickRun(input: string, from: number, runLen: number): number {
  let i = from;
  while (i < input.length) {
    if (input[i] !== '`') {
      i++;
      continue;
    }
    let n = 0;
    while (i + n < input.length && input[i + n] === '`') n++;
    if (n === runLen) return i;
    i += n;
  }
  return -1;
}

/**
 * Look at input[i] and decide whether a math token starts there.
 * Returns the token (with start, end, and source) or null.
 *
 * Order of attempts matters:
 *   1. $$ ... $$    (two dollars — block math, highest priority)
 *   2. $  ... $     (single dollar — inline, Pandoc rule)
 *   3. \[ ... \]    (LaTeX block style)
 *   4. \( ... \)    (LaTeX inline style)
 */
function tryConsumeMath(input: string, i: number): MathToken | null {
  // --- $$ ... $$ -----------------------------------------------
  if (input[i] === '$' && input[i + 1] === '$') {
    const start = i;
    const openEnd = i + 2;
    // No whitespace immediately after the opener (matches the
    // pandoc/markdown convention used by Obsidian, GitHub).
    if (isWhitespace(input[openEnd])) return null;
    // Find the next `$$` that isn't whitespace-preceded.
    let j = openEnd;
    while (j < input.length - 1) {
      if (input[j] === '$' && input[j + 1] === '$') {
        // No whitespace just before the closer.
        if (!isWhitespace(input[j - 1])) {
          const source = input.slice(openEnd, j);
          // Reject empty or whitespace-only source.
          if (source.trim() === '') return null;
          return { kind: 'block', source, start, end: j + 2 };
        }
      }
      // Backslash-escape: a literal `\$` shouldn't close the math
      // (LaTeX-correct rendering of a dollar inside math is `\$`).
      if (input[j] === '\\' && input[j + 1] === '$') {
        j += 2;
        continue;
      }
      j++;
    }
    return null;
  }

  // --- $ ... $ --------------------------------------------------
  if (input[i] === '$') {
    const start = i;
    const openEnd = i + 1;
    if (isWhitespace(input[openEnd])) return null;
    // Opening `$` must not be preceded by an ASCII letter or digit
    // (so `m$x` isn't math) — Pandoc spec. Also: the char BEFORE
    // the opener must not itself be `$`, which would have matched
    // the `$$` branch above; if we're here, `input[i-1]` is not
    // `$`. We do allow opening at start-of-string.
    if (i > 0) {
      const prev = input[i - 1];
      if (/[A-Za-z0-9]/.test(prev)) return null;
    }
    let j = openEnd;
    while (j < input.length) {
      if (input[j] === '$') {
        if (
          !isWhitespace(input[j - 1]) &&
          !/[0-9]/.test(input[j + 1] ?? '')
        ) {
          const source = input.slice(openEnd, j);
          if (source.trim() === '') return null;
          // Reject sources that look obviously non-math: pure
          // whitespace or pure digits. "Pure digits" alone in
          // single-dollar form is almost always currency or
          // page-number style text rather than math.
          if (/^\s*\d+(\.\d+)?\s*$/.test(source)) return null;
          return { kind: 'inline', source, start, end: j + 1 };
        }
      }
      if (input[j] === '\\' && input[j + 1] === '$') {
        j += 2;
        continue;
      }
      // Math inline doesn't cross a blank line — protects against
      // a stray `$` matching another `$` paragraphs later. Two
      // consecutive newlines = bail.
      if (input[j] === '\n' && input[j + 1] === '\n') return null;
      j++;
    }
    return null;
  }

  // --- \[ ... \] ------------------------------------------------
  if (input[i] === '\\' && input[i + 1] === '[') {
    const start = i;
    const openEnd = i + 2;
    let j = openEnd;
    while (j < input.length - 1) {
      if (input[j] === '\\' && input[j + 1] === ']') {
        const source = input.slice(openEnd, j);
        if (source.trim() === '') return null;
        return { kind: 'block', source, start, end: j + 2 };
      }
      j++;
    }
    return null;
  }

  // --- \( ... \) ------------------------------------------------
  if (input[i] === '\\' && input[i + 1] === '(') {
    const start = i;
    const openEnd = i + 2;
    let j = openEnd;
    while (j < input.length - 1) {
      if (input[j] === '\\' && input[j + 1] === ')') {
        const source = input.slice(openEnd, j);
        if (source.trim() === '') return null;
        // Same "don't cross a blank line" guard as $...$.
        return { kind: 'inline', source, start, end: j + 2 };
      }
      if (input[j] === '\n' && input[j + 1] === '\n') return null;
      j++;
    }
    return null;
  }

  return null;
}

function isWhitespace(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}
