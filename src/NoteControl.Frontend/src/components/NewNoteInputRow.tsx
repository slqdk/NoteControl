import { useEffect, useRef, useState } from 'react';

/**
 * Inline new-note input. Mirrors NewFolderInputRow but for note
 * creation: the user types a name (with or without .md), submit
 * appends .md if missing and POSTs to create the note.
 *
 * Validation:
 *   - empty/whitespace rejected
 *   - "/" and "\\" rejected (note creation is scoped to one folder)
 *   - dup against existing notes-in-folder rejected (case-insensitive,
 *     comparing both with and without .md)
 */
export interface NewNoteInputRowProps {
  depth: number;
  /** Lowercase basenames already in this folder, with .md still on. */
  existingNoteFileNames: string[];
  onSubmit: (noteFileName: string) => Promise<void>;
  onCancel: () => void;
}

const INDENT_PX = 14;

export function NewNoteInputRow({
  depth,
  existingNoteFileNames,
  onSubmit,
  onCancel,
}: NewNoteInputRowProps) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function ensureMdExtension(s: string): string {
    return s.toLowerCase().endsWith('.md') ? s : s + '.md';
  }

  function validate(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return 'Name is required.';
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      return 'Note name cannot contain slashes.';
    }
    if (trimmed === '.' || trimmed === '..') {
      return 'Reserved name.';
    }
    const fileName = ensureMdExtension(trimmed).toLowerCase();
    if (existingNoteFileNames.includes(fileName)) {
      return 'A note with that name already exists.';
    }
    return null;
  }

  async function tryCommit() {
    const validationError = validate(name);
    if (validationError) {
      setError(validationError);
      return;
    }
    const fileName = ensureMdExtension(name.trim());
    setBusy(true);
    setError(null);
    try {
      await onSubmit(fileName);
    } catch (e) {
      setBusy(false);
      const message = e instanceof Error ? e.message : 'Could not create note.';
      setError(message);
    }
  }

  return (
    <div
      className="nc-tree-row nc-tree-newfolder"
      style={{ paddingLeft: depth * INDENT_PX }}
    >
      <span className="nc-tree-chevron nc-tree-chevron-empty" aria-hidden="true" />
      <span className="nc-tree-icon" aria-hidden="true">📄</span>
      <input
        ref={inputRef}
        type="text"
        className="nc-tree-newfolder-input"
        value={name}
        disabled={busy}
        placeholder="New note name…"
        onChange={(e) => {
          setName(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void tryCommit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!busy) {
            setTimeout(() => onCancel(), 100);
          }
        }}
        aria-label="New note name"
      />
      {error && <span className="nc-tree-newfolder-error" title={error}>!</span>}
    </div>
  );
}
