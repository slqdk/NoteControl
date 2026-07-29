/**
 * PLCOpen XML export — the inverse of plcopenImport.ts.
 *
 * Scans a note's ProseMirror document for the POU structure the
 * PLCOpen/TcPOU import inserts (and that users write by hand for
 * their own FBs), and produces a PLCOpen XML file that TwinCAT 3
 * can import via "Import PLCopenXML…".
 *
 * ## What we scan for (mirror of insertPousAtSelection)
 *
 * Walking the document's top-level nodes:
 *
 *   - A paragraph whose first text run is **bold** and is NOT one
 *     of the member kind labels (METHOD / ACTION / PROPERTY GET /
 *     PROPERTY SET) is remembered as a *pending POU header*. The
 *     bold text is the POU name; a trailing " (functionBlock)" /
 *     " (program)" / " (function)" suffix sets the pouType.
 *
 *   - A code block with language "st" and title "Declaration"
 *     (case-insensitive) STARTS a new POU. Name/type come from the
 *     pending header when present, otherwise from the declaration
 *     text itself (`FUNCTION_BLOCK X` / `PROGRAM X` / `FUNCTION X`).
 *
 *   - A code block with language "st" and title "Implementation"
 *     supplies the current POU's body.
 *
 *   - Member blocks use the prefixed titles the import writes:
 *     "METHOD Name — Declaration", "ACTION Name — Implementation",
 *     "PROPERTY GET Name — …", "PROPERTY SET Name — …". We accept
 *     em-dash, en-dash, or plain hyphen as the separator so
 *     hand-typed members work too. Members attach to the most
 *     recent POU; member blocks before any POU are skipped with a
 *     warning.
 *
 *   - The "Structure" text block is ignored — the folder layout is
 *     NOT reconstructed (see caveats).
 *
 * ## What we emit
 *
 * The Beckhoff-flavoured shape plcopenImport.ts documents:
 *
 *   - Per POU: <interface> with best-effort structured var
 *     sections PLUS the InterfaceAsPlainText addData carrying the
 *     declaration exactly as written in the note. TwinCAT prefers
 *     the plain text when present, so comments and formatting
 *     survive the round trip.
 *   - <body><ST><xhtml> with the implementation text.
 *   - One addData block per Method / Action / Property, with the
 *     3S addData names TwinCAT uses. Property Get/Set pairs from
 *     the note are merged back into a single <Property> element.
 *   - A pou-level ObjectId addData plus a project-level
 *     ProjectStructure so the imported POU shows its members in
 *     the TwinCAT solution tree.
 *
 * ## Honest caveats
 *
 *   - The structured <interface> sections are a line-based
 *     best-effort parse of the declaration ("name : type := init;").
 *     Multi-line declarations, arrays with initialisers, pragmas
 *     and attributes are carried ONLY by the plain-text interface.
 *     Non-elementary types are emitted as <derived name="…"/> with
 *     the raw type text.
 *   - Folder hierarchy inside a POU (the "Structure" block) is not
 *     reconstructed; all members import flat under the POU.
 *   - Real-TwinCAT acceptance is verified against the shapes our
 *     own importer documents, not against every TwinCAT build.
 */

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { newId } from '../util/id';

// ---------------------------------------------------------------
// Model
// ---------------------------------------------------------------

export type ExportMemberKind =
  | 'method'
  | 'action'
  | 'property-get'
  | 'property-set';

export interface ExportMember {
  kind: ExportMemberKind;
  name: string;
  declaration: string;   // empty for actions
  implementation: string;
}

export interface ExportPou {
  name: string;
  /** PLCOpen attribute value: "program" | "functionBlock" | "function". */
  pouType: string;
  declaration: string;
  implementation: string;
  members: ExportMember[];
}

export interface PlcopenExportResult {
  pous: ExportPou[];
  warnings: string[];
  /** Full XML document text (empty string when pous is empty). */
  xml: string;
  /** Suggested download filename. */
  fileName: string;
}

// ---------------------------------------------------------------
// Document scan
// ---------------------------------------------------------------

const KIND_LABELS: Record<string, ExportMemberKind> = {
  'METHOD': 'method',
  'ACTION': 'action',
  'PROPERTY GET': 'property-get',
  'PROPERTY SET': 'property-set',
};

/** "METHOD Name — Declaration" (em-dash, en-dash, or hyphen). */
const MEMBER_TITLE_RE =
  /^(METHOD|ACTION|PROPERTY GET|PROPERTY SET)\s+(.+?)\s*[—–-]\s*(Declaration|Implementation)$/i;

/** POU-type keyword in a declaration's first statement. Order
 *  matters: FUNCTION_BLOCK must be tried before FUNCTION. */
const DECL_HEADER_RE =
  /\b(FUNCTION_BLOCK|PROGRAM|FUNCTION)\s+([A-Za-z_][A-Za-z0-9_]*)/i;

interface PendingHeader {
  name: string;
  pouType: string | null;
}

/**
 * Scan the document and build the export model. `noteName` is the
 * note's base name (no extension) — used for the download filename
 * when the note holds more than one POU.
 */
export function scanDocForPous(
  doc: ProseMirrorNode,
  noteName: string,
): PlcopenExportResult {
  const pous: ExportPou[] = [];
  const warnings: string[] = [];

  let pendingHeader: PendingHeader | null = null;
  let current: ExportPou | null = null;
  // Member accumulation: declaration and implementation arrive as
  // two separate blocks; key by kind+name to pair them up.
  let memberIndex: Map<string, ExportMember> = new Map();

  const flushCurrent = () => {
    if (current) {
      current.members = Array.from(memberIndex.values());
      pous.push(current);
    }
    current = null;
    memberIndex = new Map();
  };

  doc.forEach((node) => {
    if (node.type.name === 'paragraph') {
      const header = readPouHeader(node);
      if (header) pendingHeader = header;
      return;
    }

    if (node.type.name !== 'codeBlock') return;

    const title = String(node.attrs.title ?? '').trim();
    const language = String(node.attrs.language ?? '');
    const text = node.textContent.replace(/\r\n/g, '\n');

    // "Structure" overview block: display-only, skip.
    if (title.toLowerCase() === 'structure') return;

    if (language !== 'st') return;

    if (title.toLowerCase() === 'declaration') {
      flushCurrent();
      const fromDecl = DECL_HEADER_RE.exec(text);
      const name =
        pendingHeader?.name ??
        (fromDecl ? fromDecl[2] : null);
      if (!name) {
        warnings.push(
          'Skipped a Declaration block: no POU name found (no bold header paragraph and no FUNCTION_BLOCK/PROGRAM/FUNCTION keyword).',
        );
        pendingHeader = null;
        return;
      }
      const pouType =
        pendingHeader?.pouType ??
        (fromDecl ? keywordToPouType(fromDecl[1]) : 'functionBlock');
      current = {
        name,
        pouType,
        declaration: text,
        implementation: '',
        members: [],
      };
      pendingHeader = null;
      return;
    }

    if (title.toLowerCase() === 'implementation') {
      if (!current) {
        warnings.push(
          'Skipped an Implementation block that had no preceding Declaration.',
        );
        return;
      }
      current.implementation = text;
      return;
    }

    const m = MEMBER_TITLE_RE.exec(title);
    if (m) {
      if (!current) {
        warnings.push(
          `Skipped member block "${title}": it appears before any POU Declaration.`,
        );
        return;
      }
      const kind = KIND_LABELS[m[1].toUpperCase()];
      const name = m[2].trim();
      const part = m[3].toLowerCase(); // "declaration" | "implementation"
      const key = `${kind}\u0000${name.toLowerCase()}`;
      let member = memberIndex.get(key);
      if (!member) {
        member = { kind, name, declaration: '', implementation: '' };
        memberIndex.set(key, member);
      }
      if (part === 'declaration') member.declaration = text;
      else member.implementation = text;
      return;
    }

    // Any other st block (custom titles) is left alone on purpose —
    // exporting it would guess at semantics we don't have.
  });

  flushCurrent();

  const fileName =
    pous.length === 1 ? `${sanitizeFileName(pous[0].name)}.xml`
    : `${sanitizeFileName(noteName || 'PLCopen')}.xml`;

  const xml = pous.length > 0 ? buildPlcopenXml(pous, noteName) : '';
  return { pous, warnings, xml, fileName };
}

/** Read a paragraph as a POU header: first child is bold text
 *  (the name), optional plain-text " (pouType)" suffix. Member
 *  headers ("**METHOD**  Name") are excluded by the kind-label
 *  check. Returns null when the paragraph doesn't match. */
function readPouHeader(p: ProseMirrorNode): PendingHeader | null {
  if (p.childCount === 0) return null;
  const first = p.child(0);
  if (!first.isText || !first.text) return null;
  const isBold = first.marks.some((mk) => mk.type.name === 'bold');
  if (!isBold) return null;
  const boldText = first.text.trim();
  if (!boldText) return null;
  if (KIND_LABELS[boldText.toUpperCase()]) return null; // member header

  // POU names are identifiers; a bold sentence isn't a header.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(boldText)) return null;

  let pouType: string | null = null;
  if (p.childCount > 1) {
    const rest = p.child(1);
    if (rest.isText && rest.text) {
      const suffix = /\(\s*([A-Za-z_]+)\s*\)\s*$/.exec(rest.text.trim());
      if (suffix) pouType = normalizePouType(suffix[1]);
    }
  }
  return { name: boldText, pouType };
}

function keywordToPouType(keyword: string): string {
  switch (keyword.toUpperCase()) {
    case 'PROGRAM': return 'program';
    case 'FUNCTION': return 'function';
    case 'FUNCTION_BLOCK':
    default: return 'functionBlock';
  }
}

function normalizePouType(raw: string): string {
  switch (raw.toLowerCase()) {
    case 'program': return 'program';
    case 'function': return 'function';
    case 'functionblock': return 'functionBlock';
    default: return 'functionBlock';
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'PLCopen';
}

// ---------------------------------------------------------------
// XML building
// ---------------------------------------------------------------

const NS_INTERFACE_PLAINTEXT =
  'http://www.3s-software.com/plcopenxml/interfaceasplaintext';
const NS_METHOD = 'http://www.3s-software.com/plcopenxml/method';
const NS_ACTION = 'http://www.3s-software.com/plcopenxml/action';
const NS_PROPERTY = 'http://www.3s-software.com/plcopenxml/property';
const NS_OBJECTID = 'http://www.3s-software.com/plcopenxml/objectid';
const NS_PROJECTSTRUCTURE =
  'http://www.3s-software.com/plcopenxml/projectstructure';

/** Elementary IEC types emitted as atomic elements (<BOOL/> etc).
 *  Everything else becomes <derived name="raw"/>. */
const ELEMENTARY_TYPES = new Set([
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
  'SINT', 'INT', 'DINT', 'LINT',
  'USINT', 'UINT', 'UDINT', 'ULINT',
  'REAL', 'LREAL',
  'TIME', 'LTIME', 'DATE', 'TOD', 'TIME_OF_DAY',
  'DT', 'DATE_AND_TIME', 'STRING', 'WSTRING', 'CHAR', 'WCHAR',
]);

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escAttr(text: string): string {
  return esc(text).replace(/"/g, '&quot;');
}

function xhtmlEl(text: string, indent: string): string {
  // Whitespace inside <xhtml> is significant — the ST text goes in
  // verbatim (escaped), no pretty-printing of the content itself.
  return `${indent}<xhtml xmlns="http://www.w3.org/1999/xhtml">${esc(text)}</xhtml>`;
}

/** The bare <data> element carrying the plain-text declaration —
 *  used directly inside the pou-level addData (which also holds
 *  the ObjectId data element). */
function interfaceAsPlainTextData(decl: string, indent: string): string {
  const i = indent;
  return [
    `${i}<data name="${NS_INTERFACE_PLAINTEXT}" handleUnknown="implementation">`,
    `${i}  <InterfaceAsPlainText>`,
    xhtmlEl(decl, `${i}    `),
    `${i}  </InterfaceAsPlainText>`,
    `${i}</data>`,
  ].join('\r\n');
}

/** The same data element wrapped in its own <addData> — the form
 *  nested inside each var section. */
function interfaceAsPlainTextAddData(decl: string, indent: string): string {
  const i = indent;
  return [
    `${i}<addData>`,
    interfaceAsPlainTextData(decl, `${i}  `),
    `${i}</addData>`,
  ].join('\r\n');
}

function stBody(impl: string, indent: string): string {
  const i = indent;
  return [
    `${i}<body>`,
    `${i}  <ST>`,
    xhtmlEl(impl, `${i}    `),
    `${i}  </ST>`,
    `${i}</body>`,
  ].join('\r\n');
}

// --- Structured interface (best-effort) -------------------------

interface ParsedVar {
  name: string;
  type: string;
  initial: string | null;
}

interface ParsedSection {
  tag: string;        // inputVars / outputVars / …
  vars: ParsedVar[];
}

const SECTION_TAGS: Array<[RegExp, string]> = [
  // Longest keywords first so VAR_INPUT doesn't match as VAR.
  [/^VAR_INPUT\b/i, 'inputVars'],
  [/^VAR_OUTPUT\b/i, 'outputVars'],
  [/^VAR_IN_OUT\b/i, 'inOutVars'],
  [/^VAR_EXTERNAL\b/i, 'externalVars'],
  [/^VAR_GLOBAL\b/i, 'globalVars'],
  [/^VAR_TEMP\b/i, 'tempVars'],
  [/^VAR_INST\b/i, 'localVars'],
  [/^VAR_STAT\b/i, 'localVars'],
  [/^VAR\b/i, 'localVars'],
];

/** One declaration line: `Name : Type;` / `Name : Type := Init;`
 *  Optional AT %address between name and colon. Deliberately does
 *  not attempt multi-line declarations. */
const VAR_LINE_RE =
  /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:AT\s+%[A-Za-z0-9.*]+\s*)?:\s*([^;]*?)\s*;/;

/**
 * Line-based split of a declaration into structured var sections.
 * Comments are stripped per line (// to EOL, single-line (* *)).
 * Anything that doesn't match VAR_LINE_RE inside a section is
 * skipped — the plain-text interface still carries it.
 */
function parseSections(decl: string): ParsedSection[] {
  const out: ParsedSection[] = [];
  let section: ParsedSection | null = null;

  for (const rawLine of decl.split('\n')) {
    let line = rawLine
      .replace(/\(\*.*?\*\)/g, ' ')  // single-line (* … *)
      .replace(/\/\/.*$/, '')         // // to EOL
      .trim();
    if (!line) continue;

    if (/^END_VAR\b/i.test(line)) {
      if (section) out.push(section);
      section = null;
      continue;
    }

    const tag = SECTION_TAGS.find(([re]) => re.test(line));
    if (tag) {
      if (section) out.push(section);
      section = { tag: tag[1], vars: [] };
      continue;
    }

    if (!section) continue; // header line / stray text

    const m = VAR_LINE_RE.exec(line);
    if (!m) continue;
    const name = m[1];
    let typeAndInit = m[2];
    let initial: string | null = null;
    const assignIdx = typeAndInit.indexOf(':=');
    if (assignIdx >= 0) {
      initial = typeAndInit.slice(assignIdx + 2).trim() || null;
      typeAndInit = typeAndInit.slice(0, assignIdx).trim();
    }
    const type = typeAndInit.trim();
    if (!type) continue;
    section.vars.push({ name, type, initial });
  }
  if (section) out.push(section);
  return out;
}

function typeEl(rawType: string, indent: string): string {
  const upper = rawType.toUpperCase();
  if (ELEMENTARY_TYPES.has(upper)) {
    // TOD / DT canonical forms.
    const canonical =
      upper === 'TIME_OF_DAY' ? 'TOD' :
      upper === 'DATE_AND_TIME' ? 'DT' : upper;
    return `${indent}<type><${canonical} /></type>`;
  }
  return `${indent}<type><derived name="${escAttr(rawType)}" /></type>`;
}

function varEl(v: ParsedVar, indent: string): string {
  const i = indent;
  const lines = [`${i}<variable name="${escAttr(v.name)}">`];
  lines.push(typeEl(v.type, `${i}  `));
  if (v.initial) {
    lines.push(
      `${i}  <initialValue><simpleValue value="${escAttr(v.initial)}" /></initialValue>`,
    );
  }
  lines.push(`${i}</variable>`);
  return lines.join('\r\n');
}

/** Structured var sections + optional returnType (for methods /
 *  properties) + the InterfaceAsPlainText addData. */
function interfaceEl(
  decl: string,
  indent: string,
  returnTypeRaw: string | null,
): string {
  const i = indent;
  const lines = [`${i}<interface>`];
  if (returnTypeRaw) {
    lines.push(`${i}  <returnType>`);
    lines.push(typeElInner(returnTypeRaw, `${i}    `));
    lines.push(`${i}  </returnType>`);
  }
  // TwinCAT's importer reads the plain-text declaration from an
  // addData nested INSIDE each var section (and from the pou-level
  // addData after </body>) — NOT from a direct child of
  // <interface>. Verified against a real TwinCAT 3.5.21 export
  // (FB_XTS_Init4C.xml), which repeats the identical full
  // declaration once per section plus once at pou level. We
  // mirror that exactly. When the line-based parse yields no
  // sections at all (e.g. a bare "PROPERTY Count : DINT" member
  // declaration), fall back to an interface-level copy so our own
  // importer's subtree search still finds the text.
  let emittedSections = 0;
  for (const s of parseSections(decl)) {
    if (s.vars.length === 0) continue;
    emittedSections++;
    lines.push(`${i}  <${s.tag}>`);
    for (const v of s.vars) lines.push(varEl(v, `${i}    `));
    lines.push(interfaceAsPlainTextAddData(decl, `${i}    `));
    lines.push(`${i}  </${s.tag}>`);
  }
  if (emittedSections === 0) {
    lines.push(interfaceAsPlainTextAddData(decl, `${i}  `));
  }
  lines.push(`${i}</interface>`);
  return lines.join('\r\n');
}

/** Bare type element without the <type> wrapper (returnType holds
 *  the type element directly). */
function typeElInner(rawType: string, indent: string): string {
  const upper = rawType.toUpperCase();
  if (ELEMENTARY_TYPES.has(upper)) {
    const canonical =
      upper === 'TIME_OF_DAY' ? 'TOD' :
      upper === 'DATE_AND_TIME' ? 'DT' : upper;
    return `${indent}<${canonical} />`;
  }
  return `${indent}<derived name="${escAttr(rawType)}" />`;
}

/** `METHOD Name : TYPE` / `PROPERTY Name : TYPE` → TYPE, else null. */
function parseReturnType(decl: string, keyword: 'METHOD' | 'PROPERTY' | 'FUNCTION'): string | null {
  const re = new RegExp(
    `\\b${keyword}\\b[^:\\n]*:\\s*([^\\s;\\n]+)`, 'i',
  );
  const m = re.exec(decl);
  return m ? m[1].trim() : null;
}

// --- Members ----------------------------------------------------

interface MemberIds {
  name: string;
  objectId: string;
}

function methodData(m: ExportMember, objectId: string, indent: string): string {
  const i = indent;
  const rt = parseReturnType(m.declaration, 'METHOD');
  return [
    `${i}<data name="${NS_METHOD}" handleUnknown="implementation">`,
    `${i}  <Method name="${escAttr(m.name)}" ObjectId="${objectId}">`,
    interfaceEl(m.declaration, `${i}    `, rt),
    stBody(m.implementation, `${i}    `),
    `${i}  </Method>`,
    `${i}</data>`,
  ].join('\r\n');
}

function actionData(m: ExportMember, objectId: string, indent: string): string {
  const i = indent;
  return [
    `${i}<data name="${NS_ACTION}" handleUnknown="implementation">`,
    `${i}  <Action name="${escAttr(m.name)}" ObjectId="${objectId}">`,
    stBody(m.implementation, `${i}    `),
    `${i}  </Action>`,
    `${i}</data>`,
  ].join('\r\n');
}

function propertyData(
  name: string,
  get: ExportMember | null,
  set: ExportMember | null,
  propObjectId: string,
  accessorIds: { get: string; set: string },
  indent: string,
): string {
  const i = indent;
  const rtRaw =
    (get && parseReturnType(get.declaration, 'PROPERTY')) ??
    (set && parseReturnType(set.declaration, 'PROPERTY')) ??
    'BOOL';
  const lines = [
    `${i}<data name="${NS_PROPERTY}" handleUnknown="implementation">`,
    `${i}  <Property name="${escAttr(name)}" ObjectId="${propObjectId}">`,
    `${i}    <interface>`,
    `${i}      <returnType>`,
    typeElInner(rtRaw, `${i}        `),
    `${i}      </returnType>`,
    `${i}    </interface>`,
  ];
  if (get) {
    lines.push(`${i}    <Get ObjectId="${accessorIds.get}">`);
    lines.push(interfaceEl(get.declaration, `${i}      `, null));
    lines.push(stBody(get.implementation, `${i}      `));
    lines.push(`${i}    </Get>`);
  }
  if (set) {
    lines.push(`${i}    <Set ObjectId="${accessorIds.set}">`);
    lines.push(interfaceEl(set.declaration, `${i}      `, null));
    lines.push(stBody(set.implementation, `${i}      `));
    lines.push(`${i}    </Set>`);
  }
  lines.push(`${i}  </Property>`);
  lines.push(`${i}</data>`);
  return lines.join('\r\n');
}

// --- Whole document ---------------------------------------------

function buildPlcopenXml(pous: ExportPou[], projectName: string): string {
  const now = localTimestamp();
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push('<project xmlns="http://www.plcopen.org/xml/tc6_0200">');
  lines.push(
    `  <fileHeader companyName="NoteControl" productName="NoteControl" productVersion="1.0" creationDateTime="${now}" />`,
  );
  lines.push(
    `  <contentHeader name="${escAttr(projectName || 'NoteControl export')}" modificationDateTime="${now}">`,
  );
  lines.push('    <coordinateInfo>');
  lines.push('      <fbd>');
  lines.push('        <scaling x="1" y="1" />');
  lines.push('      </fbd>');
  lines.push('      <ld>');
  lines.push('        <scaling x="1" y="1" />');
  lines.push('      </ld>');
  lines.push('      <sfc>');
  lines.push('        <scaling x="1" y="1" />');
  lines.push('      </sfc>');
  lines.push('    </coordinateInfo>');
  lines.push('    <addData>');
  lines.push('      <data name="http://www.3s-software.com/plcopenxml/projectinformation" handleUnknown="implementation">');
  lines.push('        <ProjectInformation />');
  lines.push('      </data>');
  lines.push('    </addData>');
  lines.push('  </contentHeader>');
  lines.push('  <types>');
  lines.push('    <dataTypes />');
  lines.push('    <pous>');

  // Per-POU member id bookkeeping for the ProjectStructure block.
  const structure: Array<{ pou: MemberIds; members: MemberIds[] }> = [];

  for (const pou of pous) {
    const pouId = newId();
    const memberIds: MemberIds[] = [];

    lines.push(
      `      <pou name="${escAttr(pou.name)}" pouType="${escAttr(pou.pouType)}">`,
    );
    // FUNCTION POUs carry their return type in the structured
    // interface; FB/PROGRAM don't have one.
    const pouReturnType =
      pou.pouType === 'function'
        ? parseReturnType(pou.declaration, 'FUNCTION')
        : null;
    lines.push(interfaceEl(pou.declaration, '        ', pouReturnType));
    lines.push(stBody(pou.implementation, '        '));
    lines.push('        <addData>');

    // Group property accessors back into single Property elements;
    // methods and actions emit one data block each, in note order.
    const properties = new Map<
      string,
      { get: ExportMember | null; set: ExportMember | null }
    >();
    for (const m of pou.members) {
      if (m.kind === 'property-get' || m.kind === 'property-set') {
        const key = m.name.toLowerCase();
        const entry = properties.get(key) ?? { get: null, set: null };
        if (m.kind === 'property-get') entry.get = m;
        else entry.set = m;
        properties.set(key, entry);
      }
    }
    const emittedProps = new Set<string>();

    for (const m of pou.members) {
      if (m.kind === 'method') {
        const id = newId();
        memberIds.push({ name: m.name, objectId: id });
        lines.push(methodData(m, id, '          '));
      } else if (m.kind === 'action') {
        const id = newId();
        memberIds.push({ name: m.name, objectId: id });
        lines.push(actionData(m, id, '          '));
      } else {
        const key = m.name.toLowerCase();
        if (emittedProps.has(key)) continue;
        emittedProps.add(key);
        const entry = properties.get(key)!;
        const propId = newId();
        memberIds.push({ name: m.name, objectId: propId });
        lines.push(
          propertyData(
            m.name,
            entry.get,
            entry.set,
            propId,
            { get: newId(), set: newId() },
            '          ',
          ),
        );
      }
    }

    // Pou-level plain-text copy — the location TwinCAT's importer
    // primarily reads (real exports carry it here in addition to
    // the per-section copies).
    lines.push(interfaceAsPlainTextData(pou.declaration, '          '));
    lines.push(`          <data name="${NS_OBJECTID}" handleUnknown="discard">`);
    lines.push(`            <ObjectId>${pouId}</ObjectId>`);
    lines.push('          </data>');
    lines.push('        </addData>');
    lines.push('      </pou>');

    structure.push({ pou: { name: pou.name, objectId: pouId }, members: memberIds });
  }

  lines.push('    </pous>');
  lines.push('  </types>');
  lines.push('  <instances>');
  lines.push('    <configurations />');
  lines.push('  </instances>');
  lines.push('  <addData>');
  lines.push(
    `    <data name="${NS_PROJECTSTRUCTURE}" handleUnknown="discard">`,
  );
  lines.push('      <ProjectStructure>');
  for (const s of structure) {
    if (s.members.length === 0) {
      lines.push(
        `        <Object Name="${escAttr(s.pou.name)}" ObjectId="${s.pou.objectId}" />`,
      );
    } else {
      lines.push(
        `        <Object Name="${escAttr(s.pou.name)}" ObjectId="${s.pou.objectId}">`,
      );
      for (const m of s.members) {
        lines.push(
          `          <Object Name="${escAttr(m.name)}" ObjectId="${m.objectId}" />`,
        );
      }
      lines.push('        </Object>');
    }
  }
  lines.push('      </ProjectStructure>');
  lines.push('    </data>');
  lines.push('  </addData>');
  lines.push('</project>');
  return lines.join('\r\n');
}

/** Local wall-clock timestamp in TwinCAT's export format:
 *  "2026-07-27T16:08:27.6428889" — no timezone suffix, 7-digit
 *  fraction. */
function localTimestamp(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const frac = String(d.getMilliseconds()).padStart(3, '0') + '0000';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${frac}`;
}

// ---------------------------------------------------------------
// Download
// ---------------------------------------------------------------

/** Trigger a browser download of the XML via a temporary blob URL.
 *  Kept here so callers only need one import. */
export function downloadPlcopenXml(xml: string, fileName: string): void {
  // UTF-8 BOM + CRLF markup matches TwinCAT's own export files.
  const blob = new Blob(['\uFEFF', xml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on a delay — revoking synchronously races the download
  // start in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
