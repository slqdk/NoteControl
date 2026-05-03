import { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams, useSearchParams } from 'react-router-dom';

import { ApiError, notesApi } from '../api/client';
import type { NoteSummaryDto } from '../api/types';
import { SearchBox } from '../components/SearchBox';
import type { VaultLayoutContext } from '../components/VaultLayout';
import { formatNoteTimestamp } from '../utils/time';

/**
 * Main view for a folder.
 *
 * Layout, top → bottom:
 *   1. Folder title (full path, breadcrumb-style)
 *   2. Search box, scoped to this folder + descendants
 *   3. All notes under this folder, recursively, newest-updated first.
 *      Each row's label is the path **relative to the current folder**,
 *      with the .md stripped:
 *        - viewing root  →  "Projects/Q4/launch"
 *        - viewing Projects → "Q4/launch"
 *        - viewing Projects/Q4 → "launch"
 *
 * Folder navigation lives in the tree (left rail). Note creation
 * lives in the tree's right-click menu and the header's 📄+ button.
 *
 * Layout-route note: this page used to wrap itself in <VaultLayout>.
 * After the layout-route refactor, the surrounding shell is mounted
 * once by the parent route and we render only the inner content here.
 * Vault metadata for the breadcrumb is shared via outlet context
 * instead of being refetched per-page.
 */
export function FolderPage() {
  const { vaultId } = useParams<{ vaultId: string }>();
  const [searchParams] = useSearchParams();
  const folderPath = searchParams.get('path') ?? '';
  const { vault } = useOutletContext<VaultLayoutContext>();

  const [notes, setNotes] = useState<NoteSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!vaultId) return;
    let cancelled = false;
    setError(null);
    setNotes(null);

    (async () => {
      try {
        const flat = await notesApi.listFolderRecursive(vaultId, folderPath);
        if (!cancelled) setNotes(flat);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : 'Could not load notes.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [vaultId, folderPath]);

  if (!vaultId) {
    return null;
  }

  return (
    <div className="nc-page">
      <h1 className="nc-page-title">
        {folderPath || (vault?.name ?? 'Folder')}
      </h1>

      {error && <div className="nc-form-error">{error}</div>}

      <div className="nc-folder-search">
        <SearchBox
          vaultId={vaultId}
          folderPath={folderPath}
          placeholder="Search"
        />
      </div>

      <section className="nc-section">
        <h2 className="nc-section-heading">
          {folderPath ? `All notes under ${folderPath}` : 'All notes in this vault'}
        </h2>
        {notes === null ? (
          <p className="nc-empty">Loading…</p>
        ) : notes.length === 0 ? (
          <p className="nc-empty">No notes here yet.</p>
        ) : (
          <ul className="nc-list">
            {notes.map((note) => (
              <li key={note.path}>
                <Link
                  to={`/vaults/${vaultId}/note?path=${encodeURIComponent(note.path)}`}
                  className="nc-note-link"
                >
                  <span className="nc-note-name">
                    {stripMd(relativePath(note.path, folderPath))}
                  </span>
                  <span className="nc-note-time">
                    {formatNoteTimestamp(note.lastModified)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Compute the path of a note relative to the current folder.
 * <c>relativePath("Projects/Q4/launch.md", "Projects")</c> →
 * <c>"Q4/launch.md"</c>. Notes outside the prefix (shouldn't happen
 * for the recursive listing since the server already filters) fall
 * through to the full path.
 */
function relativePath(notePath: string, folderPath: string): string {
  if (!folderPath) return notePath;
  const prefix = folderPath + '/';
  return notePath.startsWith(prefix) ? notePath.slice(prefix.length) : notePath;
}

/** Drop the trailing `.md` so rows read like a path, not a filename. */
function stripMd(path: string): string {
  return path.toLowerCase().endsWith('.md') ? path.slice(0, -3) : path;
}
