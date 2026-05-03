import { useCallback, useState } from 'react';

/**
 * What's currently being dragged. Tracked at the TreeView level
 * (not in HTML5 dataTransfer) so we can:
 *
 *   1. Cheaply check "is this row the source?" without parsing
 *      dataTransfer types
 *   2. Compute drop validity (cycle detection) without round-tripping
 *      through serialization
 *   3. Stay scoped to in-document drags — we don't accept external
 *      file drops here (that's handled by AssetPasteExtension in
 *      the editor)
 */
export interface DragSource {
  kind: 'folder' | 'note';
  /** Absolute (vault-relative) source path. */
  path: string;
}

/**
 * What folder is currently being hovered as a drop target. We
 * also remember whether the hover position is a valid drop so the
 * row can highlight green vs red.
 */
export interface DragHover {
  folderPath: string;     // empty string = vault root
  valid: boolean;
}

/**
 * Hook that exposes drag state + start/end + hover/leave helpers.
 * Owns all the bookkeeping; TreeView reads .source for "is this
 * row the source?" checks and uses .hover.folderPath / .hover.valid
 * to render highlights.
 *
 * Validity logic:
 *
 *   - Note source: any folder is a valid target except its own
 *     parent (no-op move).
 *   - Folder source: any folder EXCEPT the source itself OR any
 *     descendant of the source. The source's own parent is also
 *     a no-op move and we treat it as invalid.
 */
export function useTreeDragDrop() {
  const [source, setSource] = useState<DragSource | null>(null);
  const [hover, setHover] = useState<DragHover | null>(null);

  const start = useCallback((s: DragSource) => {
    setSource(s);
    setHover(null);
  }, []);

  const end = useCallback(() => {
    setSource(null);
    setHover(null);
  }, []);

  const setHoverFolder = useCallback(
    (folderPath: string, valid: boolean) => {
      setHover({ folderPath, valid });
    },
    [],
  );

  const clearHoverFolder = useCallback((folderPath: string) => {
    // Only clear if the cleared folder matches the currently
    // hovered one — avoids leftover races between rapid
    // dragenter/dragleave events.
    setHover((h) => (h && h.folderPath === folderPath ? null : h));
  }, []);

  return { source, hover, start, end, setHoverFolder, clearHoverFolder };
}

/**
 * Vault-relative parent of a path. Empty string for top-level
 * paths.
 *
 *   parentOf("foo/bar/baz.md")  → "foo/bar"
 *   parentOf("foo.md")          → ""
 *   parentOf("")                → ""
 */
export function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/**
 * Last path segment.
 *
 *   basename("foo/bar/baz.md") → "baz.md"
 *   basename("foo")            → "foo"
 *   basename("")               → ""
 */
export function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Compute the destination path when dropping a source into a
 * target folder. Joins the target folder with the source's
 * basename. If the target is the vault root, the result is the
 * basename alone.
 *
 *   computeDropDest("a/b/foo.md", "x/y") → "x/y/foo.md"
 *   computeDropDest("a/b/foo.md", "")    → "foo.md"
 *   computeDropDest("a/b",       "x/y") → "x/y/b"
 */
export function computeDropDest(sourcePath: string, targetFolder: string): string {
  const name = basename(sourcePath);
  if (targetFolder === '') return name;
  return `${targetFolder}/${name}`;
}

/**
 * Check whether a candidate target folder is a valid drop site
 * for the given source. Returns true if the move would actually
 * do something useful (move the source to a different parent
 * without creating a cycle).
 */
export function isValidDropTarget(
  source: DragSource,
  targetFolder: string,
): boolean {
  // Reject moving into the same parent as the source — would be a
  // no-op move and is a useless action.
  if (parentOf(source.path) === targetFolder) return false;

  // For folder sources, prevent dropping into the source itself or
  // any of its descendants. The descendant check uses string-prefix
  // — if the target starts with `${sourcePath}/`, it's a descendant.
  if (source.kind === 'folder') {
    if (targetFolder === source.path) return false;
    if (targetFolder.startsWith(`${source.path}/`)) return false;
  }

  return true;
}
