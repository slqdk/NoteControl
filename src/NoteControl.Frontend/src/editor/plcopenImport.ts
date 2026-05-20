/**
 * PLCOpen XML import.
 *
 * Reads a PLCOpen XML file (the format TwinCAT 3 produces from
 * "Export PLCopenXML…" on a POU) and extracts each POU's
 * declaration + implementation as plain ST text, plus any
 * contained Methods / Actions / Properties and the folder
 * hierarchy that groups them. The output is suitable for
 * inserting into the editor as a tree-view header followed by
 * paired code blocks.
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
 *           <data name=".../interfaceasplaintext">
 *             <InterfaceAsPlainText>
 *               <xhtml>FUNCTION_BLOCK X
 * VAR_INPUT ...</xhtml>
 *             </InterfaceAsPlainText>
 *           </data>
 *
 *           <!-- One <data name=".../method"> per method -->
 *           <data name=".../method">
 *             <Method name="DoSomething" ObjectId="...">
 *               <interface> ...returnType + localVars... </interface>
 *               <body><ST><xhtml>...</xhtml></ST></body>
 *             </Method>
 *           </data>
 *
 *           <!-- One <data name=".../action"> per action -->
 *           <data name=".../action">
 *             <Action name="Step1" ObjectId="...">
 *               <body><ST><xhtml>...</xhtml></ST></body>
 *             </Action>
 *           </data>
 *
 *           <!-- One <data name=".../property"> per property -->
 *           <data name=".../property">
 *             <Property name="Count" ObjectId="...">
 *               <interface>...return type...</interface>
 *               <Get  ObjectId="..."> ...interface+body... </Get>
 *               <Set  ObjectId="..."> ...interface+body... </Set>
 *             </Property>
 *           </data>
 *         </addData>
 *       </pou>
 *     </pous></types>
 *
 *     <!-- Project-level addData carries the folder hierarchy. -->
 *     <addData>
 *       <data name=".../projectstructure">
 *         <ProjectStructure>
 *           <Object Name="X" ObjectId="...">
 *             <Folder Name="InternalMethods">
 *               <Object Name="Helper" ObjectId="..." />
 *             </Folder>
 *             <Object Name="DoSomething" ObjectId="..." />
 *             ...
 *           </Object>
 *         </ProjectStructure>
 *       </data>
 *     </addData>
 *   </project>
 *
 * Beckhoff-flavoured exports include the **InterfaceAsPlainText**
 * extension (an addData block carrying the human-readable
 * declaration as one ST string). That's the gold path: it's
 * exactly what TwinCAT shows as the declaration area. We prefer
 * it when present, both for the POU itself and for each Method /
 * Property Get / Property Set.
 *
 * If a declaration has no InterfaceAsPlainText (a non-Beckhoff
 * exporter, or a stripped-down file), we synthesise a minimal
 * declaration by walking the structured <interface> elements.
 * That output is correct ST but lacks the original whitespace /
 * comments.
 *
 * Actions in TwinCAT have NO declaration — they execute in their
 * parent FB's scope. We surface them as implementation-only.
 *
 * Bodies in non-ST languages (LD, FBD, SFC) are NOT supported —
 * the POU itself is rejected with a clear error if its body is
 * non-ST, and individual non-ST members within an importable POU
 * are simply skipped (their names are surfaced in `skippedMembers`).
 */

const PLC_NS = 'http://www.plcopen.org/xml/tc6_0200';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

// addData "name" attribute markers (the 3S/Beckhoff URI namespace).
// We match by substring on the lower-case URL because the host
// segment varies between exporter versions but the trailing slug
// is stable.
const ADDDATA_INTERFACE = 'interfaceasplaintext';
const ADDDATA_METHOD = '/method';
const ADDDATA_ACTION = '/action';
const ADDDATA_PROPERTY = '/property';
const ADDDATA_PROJECTSTRUCTURE = 'projectstructure';

/** Member kind tag used by tree-view rendering and the editor
 *  insertion code. The string values double as user-visible
 *  labels in the tree-view bullets ("METHOD: AbortMover"). */
export type PlcopenMemberKind =
  | 'method'
  | 'action'
  | 'property-get'
  | 'property-set';

/** A single Method / Action / Property accessor with its
 *  declaration + implementation text. ObjectId is the GUID the
 *  PLCOpen file uses to link tree entries to definitions; we
 *  carry it through so the tree-view emitter can match folders
 *  to members. */
export interface PlcopenMember {
  /** The artefact's own name (e.g. "AbortMover").
   *  For property accessors this is the property's name; use
   *  `kind` to disambiguate get vs set. */
  name: string;
  /** Stable identifier from the source XML, when present.
   *  Empty string if the source didn't supply one. */
  objectId: string;
  kind: PlcopenMemberKind;
  /**
   * Declaration text (METHOD ... : RETURN_TYPE / VAR / END_VAR
   * for methods; PROPERTY GET/SET signature for property
   * accessors). Empty string for actions, which have no
   * declaration of their own.
   */
  declaration: string;
  /** Implementation text — the body <ST><xhtml>. */
  implementation: string;
}

/** A node in the tree-view hierarchy.
 *
 * The tree is rooted at the POU. Folders contain other folders
 * and/or member references; member references are leaves that
 * point at the matching `PlcopenMember.objectId`.
 *
 * Order is preserved in document order so the tree-view bullets
 * match TwinCAT's Solution Explorer ordering. */
export type PlcopenTreeNode =
  | { kind: 'folder'; name: string; children: PlcopenTreeNode[] }
  | { kind: 'member'; name: string; objectId: string; memberKind: PlcopenMemberKind };

/** Per-POU import shape — a backwards-compatible superset of the
 *  previous shape. Existing callers that only read
 *  `name`/`pouType`/`declaration`/`implementation` keep working. */
export interface PlcopenPou {
  /** The POU name, e.g. "XPlanarMoverControl". */
  name: string;
  /** "program" | "functionBlock" | "function" | "" if missing. */
  pouType: string;
  /**
   * Declaration text for the POU itself — the PROGRAM/VAR/END_VAR
   * area or FUNCTION_BLOCK equivalent. Formatted exactly as the
   * source file presented it (when an InterfaceAsPlainText block
   * was available) or synthesised from the structured <interface>
   * elements (fallback).
   */
  declaration: string;
  /**
   * Implementation text for the POU's main body — the contents of
   * <body><ST><xhtml>. Empty string if the POU has no body (rare
   * but legal).
   */
  implementation: string;
  /**
   * All Methods, Actions, and Property accessors contained in this
   * POU. Order is document order. Empty array when none.
   */
  members: PlcopenMember[];
  /**
   * Folder + member hierarchy for the tree-view header.
   *
   * Each entry is either a folder (recursive) or a reference to a
   * member by objectId. The list represents the POU's TOP-LEVEL
   * contents (folders + members directly under the POU). It does
   * NOT contain the POU itself — the POU is implied as the root
   * the caller renders.
   *
   * If the source file has no ProjectStructure block, the tree is
   * synthesised: all members at the root, in document order, no
   * folders. That gives a useful flat overview even for non-
   * Beckhoff exporters.
   */
  tree: PlcopenTreeNode[];
}

export interface PlcopenImportResult {
  pous: PlcopenPou[];
  /**
   * Names of POUs that were skipped because their MAIN body wasn't
   * ST (e.g. LD, FBD, SFC). Populated alongside `pous` so a single
   * import can succeed for the ST POUs while warning about the
   * rest. Empty when nothing was skipped.
   */
  skippedNonST: string[];
  /**
   * Names of MEMBERS (methods/actions/property accessors) that
   * were skipped because their body wasn't ST. These were members
   * of a POU that DID import successfully — the rest of the POU
   * is in `pous`. Format: "PouName.MemberName". Empty when none.
   */
  skippedMembers: string[];
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
  // BOM, and a stricter parser path might not.
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

  // Parse the project-level ProjectStructure once. It maps
  // ObjectId → tree position for every member across all POUs.
  // Returns null when absent (non-Beckhoff exporter or older
  // schema); we'll fall back to synthesising a flat tree per POU.
  const projectTrees = readProjectStructure(root);

  const pouElements = Array.from(
    root.getElementsByTagNameNS(PLC_NS, 'pou'),
  );

  if (pouElements.length === 0) {
    throw new Error('The file contains no POUs to import.');
  }

  const pous: PlcopenPou[] = [];
  const skippedNonST: string[] = [];
  const skippedMembers: string[] = [];

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

    // Walk the POU's addData for Methods / Actions / Properties.
    // Members whose body isn't ST are skipped and surfaced through
    // skippedMembers so the user sees they were dropped.
    const members = readMembers(pouEl, name, skippedMembers);

    // Build the tree. If the project-level structure has a tree
    // for THIS pou (by name), use it. Otherwise synthesise a flat
    // root listing of all members in document order.
    const tree = projectTrees?.get(name) ?? synthesiseFlatTree(members);

    pous.push({ name, pouType, declaration, implementation, members, tree });
  }

  if (pous.length === 0) {
    if (skippedNonST.length > 0) {
      throw new Error(
        `No ST POUs found. The file contains ${skippedNonST.length} ` +
          `POU(s) in non-ST languages (LD/FBD/SFC) which can't be imported: ` +
          skippedNonST.join(', '),
      );
    }
    throw new Error('No importable POUs found in the file.');
  }

  return { pous, skippedNonST, skippedMembers };
}

/**
 * The Beckhoff-flavoured "InterfaceAsPlainText" addData block
 * carries the declaration area as a single pre-formatted string.
 * It can appear under the POU itself OR under the <localVars>
 * inside <interface> — both seen in real exports. Search both.
 *
 * For Methods/Property accessors the same block appears nested
 * inside their own <interface> — caller scopes the search by
 * passing the appropriate parent element.
 *
 * Returns null when no such block exists.
 */
function readInterfaceAsPlainText(parentEl: Element): string | null {
  // Walk addData children at any depth, filtering by the
  // interfaceasplaintext slug to avoid matching e.g. the project
  // structure block.
  const dataEls = Array.from(
    parentEl.getElementsByTagNameNS(PLC_NS, 'data'),
  );
  for (const dEl of dataEls) {
    const nameAttr = (dEl.getAttribute('name') ?? '').toLowerCase();
    if (!nameAttr.includes(ADDDATA_INTERFACE)) continue;
    // The container element is <InterfaceAsPlainText> directly
    // inside <data>. Its first descendant <xhtml> holds the text.
    const ipt = firstChildElement(dEl);
    if (ipt) {
      return extractXhtmlText(ipt);
    }
  }
  return null;
}

/**
 * Read all Method / Action / Property accessors out of a POU's
 * direct addData block. Returns them in document order. Members
 * with non-ST bodies are appended to `skippedMembersOut` (as
 * "PouName.MemberName") and not returned.
 *
 * Note: PLCOpen nests these inside the POU's <addData>; we
 * deliberately restrict the search to *direct* addData on the
 * POU (not arbitrary depth) so we don't accidentally pick up
 * something inside an <interface>'s <localVars><addData>. The
 * <data name="..."> entries inside that direct addData are the
 * member carriers.
 */
function readMembers(
  pouEl: Element,
  pouName: string,
  skippedMembersOut: string[],
): PlcopenMember[] {
  const members: PlcopenMember[] = [];

  const directAddData = firstChildNS(pouEl, PLC_NS, 'addData');
  if (!directAddData) return members;

  for (const dEl of Array.from(directAddData.children)) {
    if (dEl.localName !== 'data') continue;
    const nameAttr = (dEl.getAttribute('name') ?? '').toLowerCase();

    if (nameAttr.includes(ADDDATA_METHOD)) {
      const m = parseMethod(dEl, pouName, skippedMembersOut);
      if (m) members.push(m);
    } else if (nameAttr.includes(ADDDATA_ACTION)) {
      const a = parseAction(dEl, pouName, skippedMembersOut);
      if (a) members.push(a);
    } else if (nameAttr.includes(ADDDATA_PROPERTY)) {
      // A property contributes 0, 1, or 2 members (get and/or set).
      members.push(...parseProperty(dEl, pouName, skippedMembersOut));
    }
    // Other addData kinds (interfaceasplaintext, objectid, ...)
    // are ignored at this level.
  }

  return members;
}

/** Parse a <data name=".../method"> wrapper. Returns null when
 *  the method's body isn't ST. */
function parseMethod(
  dataEl: Element,
  pouName: string,
  skippedMembersOut: string[],
): PlcopenMember | null {
  const methodEl = childElementByLocalName(dataEl, 'Method');
  if (!methodEl) return null;

  const name = methodEl.getAttribute('name') ?? '(unnamed)';
  const objectId = methodEl.getAttribute('ObjectId') ?? '';

  const interfaceEl = childElementByLocalName(methodEl, 'interface');
  const bodyEl = childElementByLocalName(methodEl, 'body');
  const stEl = bodyEl ? firstChildNS(bodyEl, PLC_NS, 'ST') : null;

  if (!stEl) {
    // Body present but non-ST → skip with a record. Body absent →
    // legal (declaration-only method); we accept and emit empty
    // implementation.
    if (bodyEl && bodyEl.children.length > 0) {
      skippedMembersOut.push(`${pouName}.${name}`);
      return null;
    }
  }

  const implementation = stEl ? extractXhtmlText(stEl) : '';
  const declaration =
    (interfaceEl ? readInterfaceAsPlainText(interfaceEl) : null) ??
    `METHOD ${name}`;

  return { name, objectId, kind: 'method', declaration, implementation };
}

/** Parse a <data name=".../action"> wrapper. Actions have no own
 *  declaration — they execute in their parent FB's scope — so the
 *  member's `declaration` field is left empty. Returns null when
 *  the body isn't ST. */
function parseAction(
  dataEl: Element,
  pouName: string,
  skippedMembersOut: string[],
): PlcopenMember | null {
  const actionEl = childElementByLocalName(dataEl, 'Action');
  if (!actionEl) return null;

  const name = actionEl.getAttribute('name') ?? '(unnamed)';
  const objectId = actionEl.getAttribute('ObjectId') ?? '';

  const bodyEl = childElementByLocalName(actionEl, 'body');
  const stEl = bodyEl ? firstChildNS(bodyEl, PLC_NS, 'ST') : null;

  if (!stEl) {
    if (bodyEl && bodyEl.children.length > 0) {
      skippedMembersOut.push(`${pouName}.${name}`);
      return null;
    }
  }

  const implementation = stEl ? extractXhtmlText(stEl) : '';
  return { name, objectId, kind: 'action', declaration: '', implementation };
}

/** Parse a <data name=".../property"> wrapper. A property may have
 *  a <Get> child, a <Set> child, or both. Each accessor is its own
 *  PlcopenMember with kind 'property-get' / 'property-set' and the
 *  property's name (not the accessor's — there's only one name per
 *  property). Returns an empty array when neither accessor parses. */
function parseProperty(
  dataEl: Element,
  pouName: string,
  skippedMembersOut: string[],
): PlcopenMember[] {
  const propEl = childElementByLocalName(dataEl, 'Property');
  if (!propEl) return [];

  const name = propEl.getAttribute('name') ?? '(unnamed)';
  const objectId = propEl.getAttribute('ObjectId') ?? '';
  const out: PlcopenMember[] = [];

  for (const accessor of Array.from(propEl.children)) {
    const tag = accessor.localName;
    if (tag !== 'Get' && tag !== 'Set') continue;

    const kind: PlcopenMemberKind =
      tag === 'Get' ? 'property-get' : 'property-set';

    const interfaceEl = childElementByLocalName(accessor, 'interface');
    const bodyEl = childElementByLocalName(accessor, 'body');
    const stEl = bodyEl ? firstChildNS(bodyEl, PLC_NS, 'ST') : null;

    if (!stEl) {
      if (bodyEl && bodyEl.children.length > 0) {
        skippedMembersOut.push(`${pouName}.${name}.${tag.toLowerCase()}`);
        continue;
      }
    }

    const implementation = stEl ? extractXhtmlText(stEl) : '';
    const declaration =
      (interfaceEl ? readInterfaceAsPlainText(interfaceEl) : null) ??
      `PROPERTY ${name} ${tag.toUpperCase()}`;

    // Accessors carry their own ObjectId in the XML; we prefer it
    // over the property-level ObjectId so ProjectStructure entries
    // that target Get/Set individually can still link up.
    const accessorObjectId = accessor.getAttribute('ObjectId') ?? objectId;
    out.push({
      name,
      objectId: accessorObjectId,
      kind,
      declaration,
      implementation,
    });
  }

  return out;
}

/**
 * Build a declaration string for the POU itself by walking the
 * <interface> sub-tree. Used only when no InterfaceAsPlainText
 * was present. Output is intentionally minimal: PROGRAM/VAR/END_VAR
 * scaffolding plus one line per variable with its type. Initial
 * values, attributes, and pragmas are NOT preserved — they live in
 * the structured XML but reproducing TwinCAT's exact formatting
 * from them is more effort than this fallback warrants.
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
 */
function describeType(typeEl: Element | null): string {
  if (!typeEl) return '?';
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

/** First direct-child Element of any namespace, or null. */
function firstChildElement(parent: Element): Element | null {
  for (const child of Array.from(parent.children)) {
    return child;
  }
  return null;
}

/** First direct child with the given localName, ignoring namespace.
 *  Used for elements that live outside the PLCOpen namespace —
 *  Method, Action, Property, Get, Set, Folder, Object, etc. all
 *  appear without an explicit namespace declaration in the XML
 *  (they inherit the project default, which is PLC_NS, but the
 *  CDATA-quoting on some exports can occasionally drop that).
 *  Matching by localName alone is the robust read. */
function childElementByLocalName(parent: Element, local: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (child.localName === local) return child;
  }
  return null;
}

// --------------------------------------------------------------------
// ProjectStructure parsing — the project-level addData block that
// describes the folder hierarchy and the per-POU ordering.
//
// Format (Beckhoff-flavoured):
//
//   <project>
//     ...
//     <addData>
//       <data name=".../projectstructure">
//         <ProjectStructure>
//           <Object Name="MyPou" ObjectId="...">
//             <Folder Name="InternalMethods">
//               <Object Name="HelperFn" ObjectId="..." />
//             </Folder>
//             <Object Name="DoThing" ObjectId="..." />
//             ...
//           </Object>
//           <Object Name="AnotherPou" ObjectId="...">...</Object>
//         </ProjectStructure>
//       </data>
//     </addData>
//   </project>
//
// We turn each top-level <Object Name="PouX"> into a list of
// PlcopenTreeNode entries (the POU's CONTENTS, not the POU itself).
// Returns null when the block is absent — caller will fall back to
// synthesising a flat tree per POU.
// --------------------------------------------------------------------

function readProjectStructure(
  projectRoot: Element,
): Map<string, PlcopenTreeNode[]> | null {
  // Look in direct addData of the project root.
  const addDataEl = firstChildNS(projectRoot, PLC_NS, 'addData');
  if (!addDataEl) return null;

  for (const dEl of Array.from(addDataEl.children)) {
    if (dEl.localName !== 'data') continue;
    const nameAttr = (dEl.getAttribute('name') ?? '').toLowerCase();
    if (!nameAttr.includes(ADDDATA_PROJECTSTRUCTURE)) continue;

    const psEl = childElementByLocalName(dEl, 'ProjectStructure');
    if (!psEl) continue;

    const byPou = new Map<string, PlcopenTreeNode[]>();
    for (const pouObj of Array.from(psEl.children)) {
      if (pouObj.localName !== 'Object') continue;
      const pouName = pouObj.getAttribute('Name') ?? '';
      if (!pouName) continue;
      byPou.set(pouName, parseTreeChildren(pouObj));
    }
    return byPou;
  }
  return null;
}

/** Walk the children of a ProjectStructure <Object> (or a nested
 *  <Folder>) and turn them into PlcopenTreeNode entries.
 *
 *  ProjectStructure leaves are <Object Name="..." ObjectId="..." />
 *  WITHOUT a Kind attribute — the ObjectId is the key that links
 *  back to a method/action/property accessor. The kind is resolved
 *  later by the rendering layer (it cross-references the POU's
 *  members[] by objectId). For tree-view nodes whose ObjectId
 *  isn't found among the POU's members, we emit them with
 *  memberKind 'method' as a placeholder; the renderer's
 *  cross-reference step will simply drop unmatched entries. */
function parseTreeChildren(parent: Element): PlcopenTreeNode[] {
  const out: PlcopenTreeNode[] = [];
  for (const child of Array.from(parent.children)) {
    const tag = child.localName;
    if (tag === 'Folder') {
      const folderName = child.getAttribute('Name') ?? '(folder)';
      out.push({
        kind: 'folder',
        name: folderName,
        children: parseTreeChildren(child),
      });
    } else if (tag === 'Object') {
      const objName = child.getAttribute('Name') ?? '(unnamed)';
      const objId = child.getAttribute('ObjectId') ?? '';
      // memberKind is a placeholder. The renderer resolves the
      // actual kind by looking up objectId in pou.members.
      out.push({
        kind: 'member',
        name: objName,
        objectId: objId,
        memberKind: 'method',
      });
    }
    // Anything else (attributes, comments) is ignored.
  }
  return out;
}

/** When the source file has no ProjectStructure, synthesise a flat
 *  tree: every member at the root, document order, no folders.
 *  Resolves memberKind correctly because we have the parsed
 *  members in hand. */
function synthesiseFlatTree(members: PlcopenMember[]): PlcopenTreeNode[] {
  return members.map((m) => ({
    kind: 'member' as const,
    name:
      m.kind === 'property-get' ? `${m.name} (GET)` :
      m.kind === 'property-set' ? `${m.name} (SET)` :
      m.name,
    objectId: m.objectId,
    memberKind: m.kind,
  }));
}
