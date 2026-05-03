import { Link } from 'react-router-dom';

import type { FolderListingDto } from '../api/types';
import { formatNoteTimestamp } from '../utils/time';

interface NoteListProps {
  vaultId: string;
  listing: FolderListingDto;
}

export function NoteList({ vaultId, listing }: NoteListProps) {
  const noteHref = (path: string) =>
    `/vaults/${vaultId}/note?path=${encodeURIComponent(path)}`;
  const folderHref = (path: string) =>
    `/vaults/${vaultId}?path=${encodeURIComponent(path)}`;

  return (
    <div className="nc-folder-view">
      {listing.subfolders.length > 0 && (
        <section className="nc-section">
          <h2 className="nc-section-heading">Folders</h2>
          <ul className="nc-list">
            {listing.subfolders.map((sub) => (
              <li key={sub.path}>
                <Link to={folderHref(sub.path)} className="nc-folder-link">
                  📁 {sub.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="nc-section">
        <h2 className="nc-section-heading">
          {listing.folderPath ? `Notes in ${listing.folderPath}` : 'Notes in this vault'}
        </h2>
        {listing.notes.length === 0 ? (
          <p className="nc-empty">No notes here yet.</p>
        ) : (
          <ul className="nc-list">
            {listing.notes.map((note) => (
              <li key={note.path}>
                <Link to={noteHref(note.path)} className="nc-note-link">
                  <span className="nc-note-name">{note.name}</span>
                  <span className="nc-note-time">
                    {formatNoteTimestamp(note.lastModified)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {listing.recentlyUpdated.length > 0 && (
        <section className="nc-section">
          <h2 className="nc-section-heading">Recently updated</h2>
          <ul className="nc-list">
            {listing.recentlyUpdated.map((note) => (
              <li key={note.path}>
                <Link to={noteHref(note.path)} className="nc-note-link">
                  <span className="nc-note-name">{note.name}</span>
                  <span className="nc-note-path-hint">{note.path}</span>
                  <span className="nc-note-time">
                    {formatNoteTimestamp(note.lastModified)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
