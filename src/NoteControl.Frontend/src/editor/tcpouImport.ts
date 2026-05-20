/**
 * TcPOU / TcMethod / TcAction / TcProperty import from GitHub.
 *
 * The TcPOU family is TwinCAT 3's source-file format on disk —
 * the same format you see when you open a `.TcPOU` file from
 * Solution Explorer in a text editor. Compared to PLCOpenXML
 * (which is an *export* format) the on-disk format is simpler:
 *
 *   <?xml version="1.0" encoding="utf-8"?>
 *   <TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4020.6">
 *     <POU Name="FB_Foo" Id="{...}" SpecialFunc="None">
 *       <Declaration><![CDATA[FUNCTION_BLOCK FB_Foo
 *   VAR_INPUT ... END_VAR
 *   ]]></Declaration>
 *       <Implementation>
 *         <ST><![CDATA[...body text...]]></ST>
 *       </Implementation>
 *
 *       <!-- Methods/Actions/Properties are either inline here -->
 *       <Method Name="DoThing" Id="{...}">
 *         <Declaration><![CDATA[METHOD DoThing : INT
 *   VAR_INPUT ... END_VAR]]></Declaration>
 *         <Implementation>
 *           <ST><![CDATA[...]]></ST>
 *         </Implementation>
 *       </Method>
 *
 *       <Action Name="Step1" Id="{...}">
 *         <Implementation>
 *           <ST><![CDATA[...]]></ST>
 *         </Implementation>
 *       </Action>
 *
 *       <Property Name="Count" Id="{...}">
 *         <Declaration><![CDATA[PROPERTY Count : INT]]></Declaration>
 *         <Get Name="Get" Id="{...}">
 *           <Declaration><![CDATA[...]]></Declaration>
 *           <Implementation><ST><![CDATA[...]]></ST></Implementation>
 *         </Get>
 *         <Set Name="Set" Id="{...}">
 *           <Declaration><![CDATA[...]]></Declaration>
 *           <Implementation><ST><![CDATA[...]]></ST></Implementation>
 *         </Set>
 *       </Property>
 *     </POU>
 *   </TcPlcObject>
 *
 * — OR live in sibling files (the "folder export" layout). In
 * that case the URL the user pastes points at a folder containing
 * `FB_Foo.TcPOU` plus one file each for the methods / actions /
 * properties: `DoThing.TcMethod`, `Step1.TcAction`,
 * `Count.TcProperty`. The standalone files have the SAME
 * <TcPlcObject> wrapper, but their <POU Name="..."> contains a
 * single nested <Method>/<Action>/<Property> (with the parent POU
 * name carried on the outer <POU>). Stitching them together
 * gives the equivalent of the inline form.
 *
 * No namespace on these files — `<TcPlcObject>` is the no-namespace
 * root. That's the format's choice; we just don't check the
 * namespace.
 *
 * Output shape: identical to the PLCOpenXML parser. We produce
 * PlcopenPou[] so the same insertPousAtSelection() emits the
 * same header + tree + code blocks layout. That's deliberate:
 * one renderer, two parsers in front. Whatever changes there
 * land both formats automatically.
 *
 * --------------------------------------------------------------
 * GitHub URL resolution
 * --------------------------------------------------------------
 *
 * Three URL shapes accepted:
 *
 *   A) Single blob URL:
 *        https://github.com/{o}/{r}/blob/{b}/{path}.TcPOU
 *      → fetch the raw equivalent:
 *        https://raw.githubusercontent.com/{o}/{r}/{b}/{path}.TcPOU
 *      → parse as a single-file POU.
 *
 *   B) Raw URL the user already produced:
 *        https://raw.githubusercontent.com/{o}/{r}/{b}/{path}.TcPOU
 *      → fetch as-is, parse single-file.
 *
 *   C) Tree (folder) URL:
 *        https://github.com/{o}/{r}/tree/{b}/{path}
 *      → use GitHub Contents API to list the folder:
 *        https://api.github.com/repos/{o}/{r}/contents/{path}?ref={b}
 *      → identify the *primary* .TcPOU file in the folder.
 *      → identify sibling .TcMethod / .TcAction / .TcProperty
 *        files (in the same folder OR in a same-named
 *        subfolder — TwinCAT writes both layouts).
 *      → fetch each file, parse, stitch together as one POU.
 *
 * GitHub Contents API caveats:
 *   - Unauthenticated rate limit is 60 req/hour. A typical FB
 *     folder needs 1 listing + N file fetches; for N ≤ 20 that
 *     blows two import attempts before throttling. We don't
 *     handle 403/rate-limit prettily — the user just sees the
 *     fetch error. Authenticated tokens are a future ship.
 *   - CORS: api.github.com sends ACAO:* for unauthenticated
 *     requests, so direct browser fetch works.
 */

import type {
  PlcopenPou,
  PlcopenMember,
  PlcopenTreeNode,
  PlcopenImportResult,
} from './plcopenImport';

// --------------------------------------------------------------------
// Public entry: resolve URL → fetch → parse → produce PlcopenImportResult.
// --------------------------------------------------------------------

/**
 * Import from a GitHub URL — file or folder.
 *
 * Throws Error with a human-readable .message on any failure.
 * Caller surfaces it directly (same pattern as parsePlcopenXml).
 */
export async function importFromGitHubUrl(
  url: string,
): Promise<PlcopenImportResult> {
  const resolved = resolveGitHubUrl(url);
  if (resolved.kind === 'unsupported') {
    throw new Error(
      'Unsupported URL. Paste a GitHub blob URL (single .TcPOU file) or ' +
        'a GitHub tree URL (folder containing .TcPOU + related files). ' +
        'Other hosts are not supported in this version.',
    );
  }

  if (resolved.kind === 'raw-file') {
    const text = await fetchText(resolved.rawUrl);
    const pou = parseTcPouXml(text);
    if (pou === null) {
      throw new Error('The file does not contain a TcPlcObject POU.');
    }
    return { pous: [pou], skippedNonST: [], skippedMembers: [] };
  }

  // resolved.kind === 'folder'
  return await importFolder(resolved.owner, resolved.repo, resolved.branch, resolved.path);
}

// --------------------------------------------------------------------
// URL resolution
// --------------------------------------------------------------------

/** Discriminated union of what the user might have pasted. */
type ResolvedUrl =
  | { kind: 'raw-file'; rawUrl: string }
  | { kind: 'folder'; owner: string; repo: string; branch: string; path: string }
  | { kind: 'unsupported' };

/**
 * Inspect the URL and decide what to do.
 *
 * Exported (not just internal) so the slash menu can do an early
 * "this URL looks importable" check before kicking off the
 * async chain, if it wants to. Today it doesn't — the URL is
 * fed straight to importFromGitHubUrl which calls this — but
 * keeping it exposed lets future UI evolve without touching
 * this module.
 */
export function resolveGitHubUrl(url: string): ResolvedUrl {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { kind: 'unsupported' };
  }

  const host = parsed.host.toLowerCase();

  if (host === 'raw.githubusercontent.com') {
    // Already raw; pass through.
    return { kind: 'raw-file', rawUrl: parsed.toString() };
  }

  if (host !== 'github.com') {
    return { kind: 'unsupported' };
  }

  // Path shapes we recognise:
  //   /{owner}/{repo}/blob/{branch}/...path
  //   /{owner}/{repo}/tree/{branch}/...path
  // Anything else → unsupported. We deliberately reject the
  // tree-root path (just /{owner}/{repo}/) because that's a
  // whole-repo URL and importing a repo's worth of POUs isn't
  // something we want to do silently.
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length < 4) return { kind: 'unsupported' };
  const [owner, repo, kind, branch, ...rest] = segments;
  if (kind !== 'blob' && kind !== 'tree') return { kind: 'unsupported' };
  if (rest.length === 0) return { kind: 'unsupported' };

  // GitHub URL-encodes spaces in path segments as %20; the
  // Contents API and raw.githubusercontent.com both expect the
  // same encoding back. URL parses the path then re-percent-
  // encodes safe chars; rejoin with raw segments preserves
  // user encoding.
  const decodedPath = rest.map((s) => decodeURIComponent(s)).join('/');

  if (kind === 'blob') {
    return {
      kind: 'raw-file',
      rawUrl:
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/` +
        rest.join('/'),
    };
  }
  return { kind: 'folder', owner, repo, branch, path: decodedPath };
}

// --------------------------------------------------------------------
// Network helpers
// --------------------------------------------------------------------

async function fetchText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(
      `Couldn't fetch ${url}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Fetch failed for ${url} — HTTP ${res.status} ${res.statusText}.`,
    );
  }
  return await res.text();
}

interface GitHubContentItem {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'submodule' | 'symlink';
  download_url: string | null;
}

async function fetchFolderListing(
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<GitHubContentItem[]> {
  const apiUrl =
    `https://api.github.com/repos/${owner}/${repo}/contents/` +
    encodeURIPath(path) +
    `?ref=${encodeURIComponent(branch)}`;
  let res: Response;
  try {
    res = await fetch(apiUrl, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
  } catch (e) {
    throw new Error(
      `Couldn't list the GitHub folder: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (res.status === 403) {
    // Rate-limit responses have status 403 with a specific body;
    // we don't parse it but we do flag the likely cause.
    throw new Error(
      `GitHub API rate-limited or forbidden (HTTP 403). ` +
        `Unauthenticated requests are limited to 60/hour per IP. ` +
        `Wait a while and try again, or import the .TcPOU file directly.`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `GitHub API request failed — HTTP ${res.status} ${res.statusText}. ` +
        `URL: ${apiUrl}`,
    );
  }
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) {
    throw new Error(
      `Expected a folder listing from the GitHub API but got a single file. ` +
        `Did you mean to paste the URL of a .TcPOU file instead?`,
    );
  }
  return json as GitHubContentItem[];
}

/** percent-encode each path segment but leave the '/' separators
 *  intact. encodeURIComponent on the whole path would encode the
 *  slashes too. */
function encodeURIPath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

// --------------------------------------------------------------------
// Folder import — listing + identifying primary + stitching
// --------------------------------------------------------------------

async function importFolder(
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<PlcopenImportResult> {
  const items = await fetchFolderListing(owner, repo, branch, path);

  // Identify the primary .TcPOU file. There should be exactly
  // one; if there are multiple, we pick the first and warn via
  // an Error. If there are none — but there ARE method/action/
  // property files — that's a malformed folder (or a folder
  // belonging to a child POU whose parent is one level up); we
  // surface that too.
  const tcpouFiles = items.filter(
    (i) => i.type === 'file' && i.name.toLowerCase().endsWith('.tcpou'),
  );
  if (tcpouFiles.length === 0) {
    throw new Error(
      `No .TcPOU file found in this folder. ` +
        `Either you're looking at a parent folder containing several POUs ` +
        `(point at one POU's folder instead), or the folder doesn't ` +
        `contain TwinCAT source files.`,
    );
  }
  if (tcpouFiles.length > 1) {
    throw new Error(
      `Multiple .TcPOU files found in this folder ` +
        `(${tcpouFiles.map((f) => f.name).join(', ')}). ` +
        `Folder import expects exactly one POU per folder. ` +
        `Point at the parent of just one POU instead.`,
    );
  }

  const primary = tcpouFiles[0];
  const pouNameFromFile = primary.name.replace(/\.tcpou$/i, '');

  // Collect sibling member files. Two layouts:
  //   1. Flat: methods/actions/properties as files in the SAME folder
  //      as the .TcPOU.
  //   2. Nested: methods/actions/properties live in a subfolder
  //      named exactly like the POU (e.g. FB_Foo/).
  // We support both. Items already listed in `items` cover layout 1;
  // for layout 2 we make a second listing call if a same-named
  // subfolder exists.

  const memberSources: Array<{ url: string; ext: 'method' | 'action' | 'property'; baseName: string }> = [];

  for (const it of items) {
    if (it.type !== 'file' || !it.download_url) continue;
    const lower = it.name.toLowerCase();
    if (lower === primary.name.toLowerCase()) continue; // skip the POU itself
    const ext = getMemberExtension(lower);
    if (ext === null) continue;
    memberSources.push({
      url: it.download_url,
      ext,
      baseName: it.name.replace(/\.(tcmethod|tcaction|tcproperty)$/i, ''),
    });
  }

  // Layout 2: same-named subfolder.
  const nestedDir = items.find(
    (it) => it.type === 'dir' && it.name === pouNameFromFile,
  );
  if (nestedDir) {
    const nestedItems = await fetchFolderListing(
      owner, repo, branch,
      `${path}/${pouNameFromFile}`,
    );
    for (const it of nestedItems) {
      if (it.type !== 'file' || !it.download_url) continue;
      const ext = getMemberExtension(it.name.toLowerCase());
      if (ext === null) continue;
      memberSources.push({
        url: it.download_url,
        ext,
        baseName: it.name.replace(/\.(tcmethod|tcaction|tcproperty)$/i, ''),
      });
    }
  }

  // Fetch the primary POU and parse it. Anything that's embedded
  // already (methods/actions/properties as direct children of
  // <POU>) is picked up here.
  const pouText = await fetchText(primary.download_url ?? '');
  const pou = parseTcPouXml(pouText);
  if (pou === null) {
    throw new Error('The .TcPOU file does not contain a TcPlcObject POU.');
  }

  // Fetch every member file in parallel. Each member file becomes
  // ONE PlcopenMember (or two for a property with both Get and
  // Set). Failures on individual member files become entries in
  // skippedMembers — the import as a whole succeeds with what we
  // could fetch.
  const skippedMembers: string[] = [];
  const memberResults = await Promise.all(
    memberSources.map(async (src) => {
      try {
        const text = await fetchText(src.url);
        return parseMemberFile(text, src.ext, pou.name, skippedMembers);
      } catch (e) {
        skippedMembers.push(
          `${src.baseName} (fetch failed: ${e instanceof Error ? e.message : String(e)})`,
        );
        return [];
      }
    }),
  );

  // Flatten and append.
  for (const ms of memberResults) {
    pou.members.push(...ms);
  }

  // The TcPOU format doesn't include a ProjectStructure (folder
  // hierarchy) the way PLCOpenXML does — the *file system* IS the
  // hierarchy. So we synthesise the same flat tree the PLCOpenXML
  // parser uses as a fallback: every member at the root, document
  // order. The renderer's append-orphans pass would already do
  // this anyway because pou.tree is empty when synthesised, but
  // we set it explicitly so the structure header still renders.
  if (pou.tree.length === 0 && pou.members.length > 0) {
    pou.tree = pou.members.map((m): PlcopenTreeNode => ({
      kind: 'member',
      name:
        m.kind === 'property-get' ? `${m.name} (GET)` :
        m.kind === 'property-set' ? `${m.name} (SET)` :
        m.name,
      objectId: m.objectId,
      memberKind: m.kind,
    }));
  }

  return { pous: [pou], skippedNonST: [], skippedMembers };
}

/** Return 'method' | 'action' | 'property' for a recognised
 *  filename (case-insensitive), or null otherwise. */
function getMemberExtension(
  lowerName: string,
): 'method' | 'action' | 'property' | null {
  if (lowerName.endsWith('.tcmethod')) return 'method';
  if (lowerName.endsWith('.tcaction')) return 'action';
  if (lowerName.endsWith('.tcproperty')) return 'property';
  return null;
}

/**
 * Parse a standalone .TcMethod / .TcAction / .TcProperty file
 * and return its PlcopenMember(s). A property file produces up
 * to two members (get + set). Returns an empty array if the
 * file's body isn't ST (logged via skippedMembersOut), or if
 * the file is malformed (also logged).
 */
function parseMemberFile(
  xmlText: string,
  ext: 'method' | 'action' | 'property',
  pouName: string,
  skippedMembersOut: string[],
): PlcopenMember[] {
  const doc = parseXmlText(xmlText);
  if (!doc) {
    skippedMembersOut.push(`(unparseable .${ext} file)`);
    return [];
  }
  // Walk down to find the wrapped Method/Action/Property
  // element. Real-world layout is:
  //   <TcPlcObject>
  //     <POU Name="parent">
  //       <Method ...> ... </Method>     (or Action, or Property)
  //     </POU>
  //   </TcPlcObject>
  // But we accept either nesting depth — some exporters write
  // the Method/Action/Property as a direct child of TcPlcObject
  // (no wrapping POU). Searching by localName at any depth is
  // the robust read.
  const root = doc.documentElement;
  if (!root) return [];

  if (ext === 'method') {
    const el = findFirstByLocalName(root, 'Method');
    if (!el) {
      skippedMembersOut.push(`(no <Method> in .TcMethod file)`);
      return [];
    }
    const m = parseInlineMethod(el, pouName, skippedMembersOut);
    return m ? [m] : [];
  }
  if (ext === 'action') {
    const el = findFirstByLocalName(root, 'Action');
    if (!el) {
      skippedMembersOut.push(`(no <Action> in .TcAction file)`);
      return [];
    }
    const a = parseInlineAction(el, pouName, skippedMembersOut);
    return a ? [a] : [];
  }
  // property
  const el = findFirstByLocalName(root, 'Property');
  if (!el) {
    skippedMembersOut.push(`(no <Property> in .TcProperty file)`);
    return [];
  }
  return parseInlineProperty(el, pouName, skippedMembersOut);
}

// --------------------------------------------------------------------
// TcPOU XML parsing — single-file form (POU + inline members)
// --------------------------------------------------------------------

/**
 * Parse a single .TcPOU file. Returns a PlcopenPou or null when
 * the document doesn't contain a recognisable <POU> element.
 *
 * Throws when the document is unparseable XML — the user gets a
 * clearer error than a silent null.
 */
export function parseTcPouXml(xmlText: string): PlcopenPou | null {
  const doc = parseXmlText(xmlText);
  if (!doc) {
    throw new Error('Could not parse the file as XML.');
  }
  const root = doc.documentElement;
  if (!root || root.localName !== 'TcPlcObject') {
    throw new Error(
      'Not a TcPOU file — expected a <TcPlcObject> root element.',
    );
  }

  const pouEl = childByLocalName(root, 'POU');
  if (!pouEl) return null;

  const name = pouEl.getAttribute('Name') ?? '(unnamed)';

  // SpecialFunc / pouType handling: TwinCAT writes the POU kind
  // implicitly via the declaration's first keyword. We sniff the
  // declaration text once it's read.
  const declarationText = extractCDATA(childByLocalName(pouEl, 'Declaration'));
  const implementationText = extractImplementationST(childByLocalName(pouEl, 'Implementation'));

  // Decide pouType from the declaration's first keyword. This
  // matters for the header row's "(functionBlock)" / "(program)"
  // / etc. label — the renderer pulls it from pouType.
  const pouType = sniffPouType(declarationText);

  // Inline member walk. Methods/Actions/Properties as direct
  // children of <POU>.
  const members: PlcopenMember[] = [];
  const skippedMembers: string[] = []; // Not surfaced for single-file
                                       // parse — the caller can't show
                                       // them per-member because
                                       // there's only one POU. Members
                                       // that fail to parse are simply
                                       // omitted; documentation noting
                                       // this would be appropriate.
  for (const child of Array.from(pouEl.children)) {
    if (child.localName === 'Method') {
      const m = parseInlineMethod(child, name, skippedMembers);
      if (m) members.push(m);
    } else if (child.localName === 'Action') {
      const a = parseInlineAction(child, name, skippedMembers);
      if (a) members.push(a);
    } else if (child.localName === 'Property') {
      members.push(...parseInlineProperty(child, name, skippedMembers));
    }
  }

  // Synthesise a flat tree (TcPOU format has no project-structure
  // metadata of its own).
  const tree: PlcopenTreeNode[] = members.map((m) => ({
    kind: 'member',
    name:
      m.kind === 'property-get' ? `${m.name} (GET)` :
      m.kind === 'property-set' ? `${m.name} (SET)` :
      m.name,
    objectId: m.objectId,
    memberKind: m.kind,
  }));

  return {
    name,
    pouType,
    declaration: declarationText,
    implementation: implementationText,
    members,
    tree,
  };
}

/** Return "program" / "functionBlock" / "function" / "" by
 *  looking at the first keyword in the declaration text. */
function sniffPouType(declaration: string): string {
  // Strip leading whitespace, look at the first word.
  const m = /^\s*(\w+)/.exec(declaration);
  if (!m) return '';
  const kw = m[1].toUpperCase();
  if (kw === 'PROGRAM') return 'program';
  if (kw === 'FUNCTION_BLOCK') return 'functionBlock';
  if (kw === 'FUNCTION') return 'function';
  return '';
}

/** Parse a <Method> element (inline in TcPOU or wrapped in a
 *  .TcMethod file). Returns null on a non-ST body. */
function parseInlineMethod(
  el: Element,
  pouName: string,
  skippedMembersOut: string[],
): PlcopenMember | null {
  const name = el.getAttribute('Name') ?? '(unnamed)';
  const objectId = el.getAttribute('Id') ?? '';
  const declaration = extractCDATA(childByLocalName(el, 'Declaration'));
  const implEl = childByLocalName(el, 'Implementation');
  const implementation = extractImplementationST(implEl);
  if (implEl && !childByLocalName(implEl, 'ST')) {
    skippedMembersOut.push(`${pouName}.${name}`);
    return null;
  }
  return {
    name,
    objectId,
    kind: 'method',
    declaration,
    implementation,
  };
}

/** Parse an <Action> element. Actions have no Declaration in
 *  TcPOU format (they execute in the parent FB's scope). */
function parseInlineAction(
  el: Element,
  pouName: string,
  skippedMembersOut: string[],
): PlcopenMember | null {
  const name = el.getAttribute('Name') ?? '(unnamed)';
  const objectId = el.getAttribute('Id') ?? '';
  const implEl = childByLocalName(el, 'Implementation');
  const implementation = extractImplementationST(implEl);
  if (implEl && !childByLocalName(implEl, 'ST')) {
    skippedMembersOut.push(`${pouName}.${name}`);
    return null;
  }
  return {
    name,
    objectId,
    kind: 'action',
    declaration: '',
    implementation,
  };
}

/** Parse a <Property> element. Yields 0, 1, or 2 members
 *  (depending on which of Get/Set are present). */
function parseInlineProperty(
  el: Element,
  pouName: string,
  skippedMembersOut: string[],
): PlcopenMember[] {
  const name = el.getAttribute('Name') ?? '(unnamed)';
  const propertyId = el.getAttribute('Id') ?? '';
  const propertyDeclaration = extractCDATA(childByLocalName(el, 'Declaration'));

  const out: PlcopenMember[] = [];

  for (const tag of ['Get', 'Set'] as const) {
    const accessor = childByLocalName(el, tag);
    if (!accessor) continue;

    const accessorId = accessor.getAttribute('Id') ?? propertyId;
    // Accessor's own <Declaration> typically holds the VAR
    // sections; the property-level declaration holds the
    // PROPERTY signature. We concatenate them so users see
    // the full picture in one block, matching how TwinCAT
    // shows it in the editor.
    const accessorDecl = extractCDATA(childByLocalName(accessor, 'Declaration'));
    const declaration =
      propertyDeclaration && accessorDecl
        ? propertyDeclaration + '\n' + accessorDecl
        : propertyDeclaration || accessorDecl ||
          `PROPERTY ${name} ${tag.toUpperCase()}`;

    const implEl = childByLocalName(accessor, 'Implementation');
    const implementation = extractImplementationST(implEl);
    if (implEl && !childByLocalName(implEl, 'ST')) {
      skippedMembersOut.push(`${pouName}.${name}.${tag.toLowerCase()}`);
      continue;
    }
    out.push({
      name,
      objectId: accessorId,
      kind: tag === 'Get' ? 'property-get' : 'property-set',
      declaration,
      implementation,
    });
  }

  return out;
}

// --------------------------------------------------------------------
// XML helpers
// --------------------------------------------------------------------

function parseXmlText(xmlText: string): Document | null {
  // Strip a leading UTF-8 BOM. TwinCAT files start with one.
  if (xmlText.charCodeAt(0) === 0xfeff) {
    xmlText = xmlText.slice(1);
  }
  const parser = new DOMParser();
  // Browser DOMParser doesn't throw on malformed XML — it returns
  // a document containing a <parsererror>. Some non-browser DOM
  // shims (e.g. @xmldom/xmldom) throw synchronously instead. We
  // handle both: catch any throw, AND check for parsererror in
  // the returned doc.
  let doc: Document;
  try {
    doc = parser.parseFromString(xmlText, 'application/xml');
  } catch {
    return null;
  }
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) return null;
  return doc;
}

/** Direct child with the given localName, ignoring namespace. */
function childByLocalName(parent: Element, local: string): Element | null {
  for (const c of Array.from(parent.children)) {
    if (c.localName === local) return c;
  }
  return null;
}

/** First descendant (any depth) with the given localName. */
function findFirstByLocalName(root: Element, local: string): Element | null {
  if (root.localName === local) return root;
  for (const c of Array.from(root.children)) {
    const got = findFirstByLocalName(c, local);
    if (got) return got;
  }
  return null;
}

/**
 * Get the text content of an element wrapping CDATA — that's the
 * shape <Declaration><![CDATA[...]]></Declaration> takes after
 * DOM parsing (the CDATA shows up as a CDATASection child).
 * textContent collapses CDATA sections into their string body,
 * which is exactly what we want. Returns "" when the element is
 * missing or empty.
 *
 * Whitespace: TwinCAT's CDATA bodies use CRLF line endings on
 * Windows-checkout exports. We normalise to LF, consistent with
 * the rest of the app's editor storage.
 */
function extractCDATA(el: Element | null): string {
  if (!el) return '';
  const raw = el.textContent ?? '';
  return raw.replace(/\r\n/g, '\n');
}

/** <Implementation><ST><![CDATA[...]]></ST></Implementation> →
 *  the CDATA body, or "" when the ST child is absent. Used both
 *  for the main POU implementation and for member implementations. */
function extractImplementationST(implEl: Element | null): string {
  if (!implEl) return '';
  const stEl = childByLocalName(implEl, 'ST');
  if (!stEl) return '';
  return extractCDATA(stEl);
}

// Re-export the result type for the slash menu's import.
export type { PlcopenImportResult };
