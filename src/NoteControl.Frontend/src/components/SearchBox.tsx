import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Link } from 'react-router-dom';

import { ApiError, searchApi } from '../api/client';
import type { SearchResultDto } from '../api/types';

const SEARCH_DEBOUNCE_MS = 250;

interface SearchBoxProps {
  vaultId: string;
  folderPath?: string;
  placeholder?: string;
}

export function SearchBox({ vaultId, folderPath = '', placeholder = 'Search…' }: SearchBoxProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      setError(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const r = await searchApi.query(vaultId, query.trim(), folderPath);
        setResults(r.results);
        setError(null);
      } catch (e) {
        if (e instanceof ApiError) {
          setError(e.message);
        } else {
          setError('Search failed.');
        }
        setResults([]);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, vaultId, folderPath]);

  // Outside-click dismissal. Ship 85: pointerdown so iOS taps that
  // become scrolls reliably close the dropdown — mousedown sometimes
  // doesn't fire under those circumstances on Safari iOS. Same
  // change applied to AccountMenu, ContextMenu, TopBar (Widgets+),
  // and the settings popover.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  return (
    <div ref={containerRef} className="nc-search">
      <input
        type="search"
        className="nc-search-input"
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        aria-label="Search notes"
      />
      {open && query.trim() && (
        <div className="nc-search-dropdown" role="listbox">
          {error && <div className="nc-search-error">{error}</div>}
          {!error && results !== null && results.length === 0 && (
            <div className="nc-search-empty">No matches.</div>
          )}
          {!error &&
            results?.map((r) => (
              <Link
                key={r.path}
                className="nc-search-result"
                to={`/vaults/${vaultId}/note?path=${encodeURIComponent(r.path)}`}
                onClick={() => {
                  setOpen(false);
                  setQuery('');
                }}
                role="option"
              >
                <div className="nc-search-result-title">{r.title}</div>
                <div
                  className="nc-search-result-snippet"
                  dangerouslySetInnerHTML={{
                    __html: snippetToSafeHtml(r.snippet),
                  }}
                />
                <div className="nc-search-result-path">{r.path}</div>
              </Link>
            ))}
        </div>
      )}
    </div>
  );
}

function snippetToSafeHtml(raw: string): string {
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  let inside = false;
  const html = escaped.replace(/\*\*/g, () => {
    inside = !inside;
    return inside ? '<strong>' : '</strong>';
  });

  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ['strong'], ALLOWED_ATTR: [] });
}
