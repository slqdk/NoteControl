import type { Environment, RuntimeValue } from '../runtime/interpreter';
import { formatRuntimeValue } from '../runtime/interpreter';
import type { ParsedProgram, VarRefExpr, Statement, Expr } from '../runtime/ast';

/**
 * Renders the implementation source text with inline value pills
 * spliced after every variable reference.
 *
 * Visual model (matches TwinCAT online view):
 *   - Plain monospace text with original whitespace preserved
 *     INSIDE each line.
 *   - After each variable reference identifier, an inline pill
 *     containing the current runtime value of that variable.
 *   - BOOLs get a coloured fill (blue=TRUE, grey=FALSE). Other
 *     types get a neutral border-only style.
 *
 * Why splice instead of overlay: TwinCAT does it this way too.
 * Pills shift the following text right; tabs may misalign on
 * lines with pills. Keeping the source's indentation perfectly
 * aligned would require absolute-positioning the pills over
 * the text, which causes overlap when several variables sit
 * close together. The shift-right tradeoff is the lesser evil
 * and matches the reference UI.
 *
 * Inputs:
 *   source — the raw implementation text, as it appears in the
 *            code block. Newlines split into lines.
 *   program — the parsed program. We walk every VarRefExpr in
 *            the body and collect (line, column, nameLower)
 *            tuples — those are the splice sites.
 *   env — the current runtime environment. May be null when
 *            execution hasn't started yet — in that case pills
 *            still render but show the variable's INITIAL value
 *            (taken from a static-init env passed through env).
 *   errorLine — when a runtime error fires, the offending line
 *            gets a red left-border accent. null when no error.
 */
export interface InlineSourceProps {
  source: string;
  program: ParsedProgram;
  env: Environment;
  errorLine: number | null;
}

interface Decoration {
  /** 1-indexed column of the identifier's first character. */
  column: number;
  /** Number of source characters to skip after the identifier
   *  begins, before splicing the pill. We splice AFTER the
   *  identifier, so this equals the identifier's length. */
  length: number;
  /** Lowercase name to look up in env. */
  nameLower: string;
  /** Original spelling — used as the pill's tooltip. */
  name: string;
}

export function InlineSource({
  source, program, env, errorLine,
}: InlineSourceProps) {
  // Build per-line decoration lists once. Memoising would be
  // ideal but the parsed program is stable across renders for
  // a given modal instance, and walking the AST is cheap, so
  // we do it inline. If perf bites later we can useMemo.
  const decorations = collectDecorations(program);

  const lines = source.split('\n');

  return (
    <div className="nc-runtime-inline-source">
      {lines.map((lineText, index) => {
        const lineNum = index + 1;
        const decos = decorations.get(lineNum) ?? [];
        const isErr = errorLine === lineNum;
        return (
          <div
            key={lineNum}
            className={
              'nc-runtime-inline-line' + (isErr ? ' nc-runtime-inline-line-err' : '')
            }
          >
            <span className="nc-runtime-inline-gutter">{lineNum}</span>
            <span className="nc-runtime-inline-content">
              {renderLine(lineText, decos, env)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Walk the parsed program's body and return a map from 1-indexed
 * line number to a sorted list of decoration sites on that line.
 *
 * Decoration sources, in order:
 *   - the LHS of every assignment statement
 *   - the FOR loop variable
 *   - every VarRefExpr inside expressions
 *
 * We DON'T decorate FB-call argument expressions in v1 because
 * v1 has no FB calls. When/if we add them we revisit the
 * "literal pill at the call site" question.
 *
 * The returned per-line list is sorted by column ascending so
 * the renderer can splice in document order.
 */
function collectDecorations(
  program: ParsedProgram,
): Map<number, Decoration[]> {
  const out = new Map<number, Decoration[]>();

  function add(line: number, column: number, name: string, nameLower: string) {
    const list = out.get(line);
    if (list) list.push({ line, column, length: name.length, name, nameLower } as Decoration & { line: number });
    else out.set(line, [{ column, length: name.length, name, nameLower }]);
  }

  function visitExpr(e: Expr) {
    switch (e.kind) {
      case 'Literal': return;
      case 'VarRef':
        add(e.line, e.column, e.name, e.nameLower);
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

  function visitStmt(s: Statement) {
    switch (s.kind) {
      case 'Assign':
        // Assignment target is itself a VarRef with line/col.
        visitVarRef(s.target);
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
        visitVarRef(s.loopVar);
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

  function visitVarRef(v: VarRefExpr) {
    add(v.line, v.column, v.name, v.nameLower);
  }

  for (const s of program.body) visitStmt(s);

  // Sort each line's decorations by column ascending.
  for (const list of out.values()) {
    list.sort((a, b) => a.column - b.column);
  }
  return out;
}

/**
 * Render one line of text with its decoration pills spliced in.
 *
 * Algorithm:
 *   - Track a running source-text cursor at the START of the
 *     line (column 1).
 *   - For each decoration in column-sorted order:
 *       - Emit text from cursor up to AND INCLUDING the
 *         identifier (column-1 + length characters).
 *       - Emit a pill <span> for that variable's value.
 *       - Advance cursor.
 *   - Emit any remaining text after the last decoration.
 *
 * Edge case: a decoration whose column extends past the line's
 * length (shouldn't happen, but if column tracking ever drifts)
 * is silently skipped. We log to console for visibility.
 */
function renderLine(
  text: string,
  decos: Decoration[],
  env: Environment,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let cursor = 0; // 0-indexed character position in this line
  let pillKey = 0;

  for (const d of decos) {
    // d.column is 1-indexed; the character at column N has 0-index N-1.
    const idStart = d.column - 1;
    const idEnd = idStart + d.length;

    if (idStart < cursor) {
      // Decorations should never overlap; if they do, skip the
      // out-of-order one. (Could happen if the parser ever made
      // a column mistake — defensive.)
      // eslint-disable-next-line no-console
      console.warn('inline-source: overlapping decorations', d);
      continue;
    }

    if (idEnd > text.length) {
      // Past EOL — bail.
      // eslint-disable-next-line no-console
      console.warn('inline-source: decoration past EOL', d, text);
      continue;
    }

    // Text up to and including the identifier
    out.push(text.slice(cursor, idEnd));

    // The pill itself
    out.push(renderPill(d, env, pillKey++));

    cursor = idEnd;
  }

  // Trailing text
  if (cursor < text.length) {
    out.push(text.slice(cursor));
  } else if (text.length === 0 && decos.length === 0) {
    // Empty line — render a zero-width space so the line still
    // has its proper height. (CSS could do this but the explicit
    // node makes it copy-paste-friendly too.)
    out.push('\u200b');
  }

  return out;
}

function renderPill(
  d: Decoration, env: Environment, key: number,
): React.ReactNode {
  const v: RuntimeValue | undefined = env.get(d.nameLower);
  if (!v) {
    // Should be unreachable — every reference was validated at
    // parse time. Render a placeholder so the layout doesn't
    // collapse.
    return (
      <span
        key={key}
        className="nc-runtime-pill nc-runtime-pill-missing"
        title={`unknown variable "${d.name}"`}
      >
        ?
      </span>
    );
  }

  const formatted = formatRuntimeValue(v);
  let cls = 'nc-runtime-pill';
  if (v.type === 'BOOL') {
    cls += (v.value as boolean)
      ? ' nc-runtime-pill-bool nc-runtime-pill-bool-true'
      : ' nc-runtime-pill-bool nc-runtime-pill-bool-false';
  }

  return (
    <span
      key={key}
      className={cls}
      title={`${d.name} : ${v.type}`}
    >
      {formatted}
    </span>
  );
}
