import { useEffect, useRef, useState } from 'react';

/**
 * Inline editable row that appears in the tree when the user starts a
 * "New folder" action. Mimics Visual Studio's add-folder UX:
 *   - Auto-focuses on mount.
 *   - Enter submits.
 *   - Escape cancels.
 *   - Blur (clicking outside) cancels too.
 *
 * Validation is local: empty/whitespace, names containing '/' or '\',
 * and duplicates of existing siblings are rejected with an inline
 * error and no submit.
 */
export interface NewFolderInputRowProps {
  depth: number;
  /** Lowercase names already present at this level — used for dup check. */
  existingNames: string[];
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}

const INDENT_PX = 14;

export function NewFolderInputRow({
  depth,
  existingNames,
  onSubmit,
  onCancel,
}: NewFolderInputRowProps) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount so the user can just start typing.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function validate(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return 'Name is required.';
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      return 'Folder name cannot contain slashes.';
    }
    if (trimmed === '.' || trimmed === '..') {
      return 'Reserved name.';
    }
    if (existingNames.includes(trimmed.toLowerCase())) {
      return 'A folder with that name already exists.';
    }
    return null;
  }

  async function tryCommit() {
    const trimmed = name.trim();
    const validationError = validate(name);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      // Caller cancels the prompt on success — don't touch state here
      // because the component will be unmounted by then.
    } catch (e) {
      setBusy(false);
      const message = e instanceof Error ? e.message : 'Could not create folder.';
      setError(message);
    }
  }

  return (
    <div
      className="nc-tree-row nc-tree-newfolder"
      style={{ paddingLeft: depth * INDENT_PX }}
    >
      <span className="nc-tree-chevron nc-tree-chevron-empty" aria-hidden="true" />
      <span className="nc-tree-icon" aria-hidden="true">📁</span>
      <input
        ref={inputRef}
        type="text"
        className="nc-tree-newfolder-input"
        value={name}
        disabled={busy}
        placeholder="New folder name…"
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
        // We use a slight blur delay so a click on a tooltip or an
        // adjacent button doesn't immediately cancel us. In practice
        // the inline tree has nothing to click on alongside; this is
        // just defensive.
        onBlur={() => {
          if (!busy) {
            // Defer cancel so an Enter-press has a chance to fire first.
            setTimeout(() => onCancel(), 100);
          }
        }}
        aria-label="New folder name"
      />
      {error && <span className="nc-tree-newfolder-error" title={error}>!</span>}
    </div>
  );
}
