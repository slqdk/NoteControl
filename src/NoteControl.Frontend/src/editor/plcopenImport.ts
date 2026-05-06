/**
 * PLCOpen XML import.
 *
 * Reads a PLCOpen XML file (the format TwinCAT 3 produces from
 * "Export PLCopenXML…" on a POU) and extracts each POU's
 * declaration + implementation as plain ST text, suitable for
 * inserting into the editor as paired code blocks.
 *
 * The PLCOpen format pertinent to us:
 *
 *   <project xmlns="http://www.plcopen.org/xml/tc6_0200">
 *     <types><pous>
 *       <pou name="X" pouType="program|functionBlock|function">
 *         <interface>
 *           <localVars> ...declared variables in XML form... </localVars>
 *         </interface>
 *         <body>
 *           <ST><xhtml>// implementation as plain ST</xhtml></ST>
 *         </body>
 *         <addData>
 *           <data name="...interfaceasplaintext">
 *             <InterfaceAsPlainText>
 *               <xhtml>PROGRAM X
 * VAR
 *   Counter : UDINT;
 * END_VAR</xhtml>
 *             </InterfaceAsPlainText>
 *           </data>
 *         </addData>
 *       </pou>
 *     </pous></types>
 *   </project>
 *
 * Beckhoff-flavoured exports include the **InterfaceAsPlainText**
 * extension (an addData block carrying the human-readable
 * declaration as one ST string). That's the gold path: it's
 * exactly what TwinCAT shows as the declaration area, with
 * formatting preserved. We prefer it when present.
 *
 * If a POU has no InterfaceAsPlainText (a non-Beckhoff exporter,
 * or a stripped-down file), we synthesise a minimal declaration
 * by walking the structured <interface> elements. That output
 * is correct ST but lacks the original whitespace / comments.
 *
 * The body is always taken from <body><ST><xhtml>. POU bodies
 * in other languages (LD, FBD, SFC) are NOT supported — we
 * surface a clear error rather than silently dropping them.
 */

const PLC_NS = 'http://www.plcopen.org/xml/tc6_0200';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

export interface PlcopenPou {
  /** The POU name, e.g. "PLCOpenXMLExample". */
  name: string;
  /** "program" | "functionBlock" | "function" | "" if missing. */
  pouType: string;
  /**
   * Declaration text — the PROGRAM/VAR/END_VAR area, formatted
   * exactly as the source file presented it (when an
   * InterfaceAsPlainText block was available) or synthesised
   * from the structured <interface> elements (fallback).
   */
  declaration: string;
  /**
   * Implementation text — the contents of <body><ST><xhtml>.
   * Empty string if the POU has no body (rare but legal).
   */
  implementation: string;
}

export interface PlcopenImportResult {
  pous: PlcopenPou[];
  /**
   * Names of POUs that were skipped because their body wasn't ST
   * (e.g. LD, FBD, SFC). Populated alongside `pous` so a single
   * import can succeed for the ST POUs while warning about the
   * rest. Empty when nothing was skipped.
   */
  skippedNonST: string[];
}

/**
 * Parse a PLCOpen XML string. Throws on:
 *   - XML parse errors (malformed file)
 *   - Root element isn't <project> in the PLCOpen namespace
 *   - No POUs found at all (or all POUs were non-ST)
 *
 * Throws Error with a human-readable `.message` — caller is
 * expected to surface it directly.
 */
export function parsePlcopenXml(xmlText: string): PlcopenImportResult {
  // Strip a leading UTF-8 BOM if present. Browsers' File.text()
  // decodes UTF-8 and DOES strip the BOM, so this is mostly a
  // belt-and-braces guard — but TwinCAT exports do start with a
  // BOM, and a stricter parser path (e.g. clipboard-pasted XML
  // via some other code path in the future) might not.
  if (xmlText.charCodeAt(0) === 0xfeff) {
    xmlText = xmlText.slice(1);
  }

  // DOMParser is built into all modern browsers. It does NOT
  // throw on malformed XML — instead the returned document
  // contains a <parsererror> element. We have to check for it.
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');

  const parserErr = doc.getElementsByTagName('parsererror')[0];
  if (parserErr) {
    // Browsers vary on the exact text; trim aggressively for the
    // user-facing alert.
    const detail = (parserErr.textContent ?? '').replace(/\s+/g, ' ').trim();
    throw new Error(
      `Couldn't parse the file as XML.${detail ? ' ' + detail.slice(0, 200) : ''}`,
    );
  }

  const root = doc.documentElement;
  if (
    !root ||
    root.localName !== 'project' ||
    root.namespaceURI !== PLC_NS
  ) {
    throw new Error(
      'Not a PLCOpen XML file — expected a <project> root in the ' +
        '"http://www.plcopen.org/xml/tc6_0200" namespace.',
    );
  }

  const pouElements = Array.from(
    root.getElementsByTagNameNS(PLC_NS, 'pou'),
  );

  if (pouElements.length === 0) {
    throw new Error('The file contains no POUs to import.');
  }

  const pous: PlcopenPou[] = [];
  const skippedNonST: string[] = [];

  for (const pouEl of pouElements) {
    const name = pouEl.getAttribute('name') ?? '(unnamed)';
    const pouType = pouEl.getAttribute('pouType') ?? '';

    // Body must be ST. Anything else (LD/FBD/SFC) we skip — the
    // editor has no way to render graphical languages.
    const bodyEl = firstChildNS(pouEl, PLC_NS, 'body');
    const stEl = bodyEl ? firstChildNS(bodyEl, PLC_NS, 'ST') : null;

    if (!stEl) {
      // Either no body at all or a non-ST body. Distinguish the
      // two: a missing body is legal (declaration-only POU), but
      // a present-non-ST body is something we explicitly can't
      // import.
      if (bodyEl && bodyEl.children.length > 0) {
        skippedNonST.push(name);
        continue;
      }
    }

    const implementation = stEl ? extractXhtmlText(stEl) : '';
    const declaration =
      readInterfaceAsPlainText(pouEl) ?? synthesiseDeclaration(pouEl, name, pouType);

    pous.push({ name, pouType, declaration, implementation });
  }

  if (pous.length === 0) {
    if (skippedNonST.length > 0) {
      throw new Error(
        `No ST POUs found. The file contains ${skippedNonST.length} ` +
          `POU(s) in non-ST languages (LD/FBD/SFC) which can't be imported: ` +
          skippedNonST.join(', '),
      );
    }
    // Defensive — getElementsByTagNameNS gave us at least one above.
    throw new Error('No importable POUs found in the file.');
  }

  return { pous, skippedNonST };
}

/**
 * The Beckhoff-flavoured "InterfaceAsPlainText" addData block
 * carries the declaration area as a single pre-formatted string.
 * It can appear under the POU itself OR under the <localVars>
 * inside <interface> — both seen in real exports. Search both.
 *
 * Returns null when no such block exists.
 */
function readInterfaceAsPlainText(pouEl: Element): string | null {
  const candidates = pouEl.getElementsByTagNameNS(
    PLC_NS,
    'InterfaceAsPlainText',
  );
  if (candidates.length === 0) return null;
  // Take the first one we find. In practice TwinCAT writes
  // identical content in both locations, so first-wins is fine.
  return extractXhtmlText(candidates[0]);
}

/**
 * Build a declaration string by walking the <interface> sub-tree.
 * Used only when no InterfaceAsPlainText was present. Output is
 * intentionally minimal: PROGRAM/VAR/END_VAR scaffolding plus one
 * line per variable with its type. Initial values, attributes,
 * and pragmas are NOT preserved — they live in the structured XML
 * but reproducing TwinCAT's exact formatting from them is more
 * effort than this fallback warrants.
 */
function synthesiseDeclaration(
  pouEl: Element,
  name: string,
  pouType: string,
): string {
  const header = pouTypeKeyword(pouType);
  const lines: string[] = [];
  lines.push(`${header} ${name}`);

  const interfaceEl = firstChildNS(pouEl, PLC_NS, 'interface');
  if (!interfaceEl) {
    lines.push(`END_${header}`);
    return lines.join('\n');
  }

  // Variable sections we recognise. Mapped to their ST keyword.
  const SECTION_MAP: Record<string, string> = {
    inputVars: 'VAR_INPUT',
    outputVars: 'VAR_OUTPUT',
    inOutVars: 'VAR_IN_OUT',
    localVars: 'VAR',
    externalVars: 'VAR_EXTERNAL',
    globalVars: 'VAR_GLOBAL',
    tempVars: 'VAR_TEMP',
  };

  for (const [tag, keyword] of Object.entries(SECTION_MAP)) {
    const sections = Array.from(
      interfaceEl.getElementsByTagNameNS(PLC_NS, tag),
    );
    for (const section of sections) {
      const vars = Array.from(
        section.getElementsByTagNameNS(PLC_NS, 'variable'),
      );
      if (vars.length === 0) continue;
      lines.push(keyword);
      for (const v of vars) {
        const vName = v.getAttribute('name') ?? '?';
        const typeName = describeType(firstChildNS(v, PLC_NS, 'type'));
        lines.push(`\t${vName} : ${typeName};`);
      }
      lines.push('END_VAR');
    }
  }

  lines.push(`END_${header}`);
  return lines.join('\n');
}

/** "program" → "PROGRAM", default to "PROGRAM" for unknown values. */
function pouTypeKeyword(pouType: string): string {
  switch (pouType.toLowerCase()) {
    case 'function':
      return 'FUNCTION';
    case 'functionblock':
      return 'FUNCTION_BLOCK';
    case 'program':
    default:
      return 'PROGRAM';
  }
}

/**
 * Best-effort type name for the synth-fallback path. <type> can
 * hold:
 *   <BOOL/>, <UDINT/>, <INT/>, ... (atomic types as empty elements)
 *   <derived name="MyFB"/>          (named user type)
 *   <pointer><BaseType><INT/></BaseType></pointer>
 *   <array> ... </array>            (we punt and return ARRAY)
 *
 * Anything we don't recognise falls through to the element's
 * localName, which at least gives the user a hint.
 */
function describeType(typeEl: Element | null): string {
  if (!typeEl) return '?';
  // The first element child is the type spec. Iterate children
  // because type elements have no significant text.
  for (const child of Array.from(typeEl.children)) {
    if (child.localName === 'derived') {
      return child.getAttribute('name') ?? '?';
    }
    if (child.localName === 'pointer') {
      const baseType = firstChildNS(child, PLC_NS, 'baseType');
      return 'POINTER TO ' + describeType(baseType);
    }
    if (child.localName === 'array') {
      return 'ARRAY';
    }
    // Atomic — return uppercase (BOOL, UDINT, etc.). PLCOpen
    // writes them with the canonical case already.
    return child.localName.toUpperCase();
  }
  return '?';
}

/**
 * Extract the text content of an element that wraps an
 * <xhtml xmlns="..."> child. The xhtml child contains the
 * pre-formatted ST text we want; whitespace inside it must be
 * preserved exactly (significant for PROGRAM/VAR/END_VAR
 * formatting).
 *
 * If no xhtml wrapper is present, fall back to the element's
 * own textContent — covers exporters that put text directly
 * inside <ST> or <InterfaceAsPlainText>.
 */
function extractXhtmlText(el: Element): string {
  const xhtml = el.getElementsByTagNameNS(XHTML_NS, 'xhtml')[0];
  const raw = xhtml ? (xhtml.textContent ?? '') : (el.textContent ?? '');
  // PLCOpen XML preserves significant whitespace inside xhtml.
  // We just normalise line endings — CRLF in, LF out — so the
  // editor stores LF-only consistently with the rest of the app.
  return raw.replace(/\r\n/g, '\n');
}

/**
 * The standard DOM lookup helpers (getElementsByTagNameNS) are
 * recursive — they descend into any depth. Sometimes we want
 * the FIRST direct child with a given namespace+local name,
 * because grandchildren named the same thing would confuse us
 * (e.g. an "addData" block at POU level contains a deeper
 * "addData"). This walks only the immediate children.
 */
function firstChildNS(
  parent: Element,
  ns: string,
  local: string,
): Element | null {
  for (const child of Array.from(parent.children)) {
    if (child.namespaceURI === ns && child.localName === local) {
      return child;
    }
  }
  return null;
}
