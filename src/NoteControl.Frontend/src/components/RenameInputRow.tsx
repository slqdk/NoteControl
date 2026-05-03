import { useEffect, useRef, useState } from 'react';

/**
 * Inline editable row for renaming an existing tree node. Mirrors
 * NewFolderInputRow's UX but pre-fills the current name and runs a
 * different validation:
 *   - empty/whitespace rejected
 *   - "/" and "\\" rejected (would change the parent folder, which
 *     is what move-to-folder is for, not rename)
 *   - dup against siblings rejected, but the *current* name itself
 *     is allowed (so the user can hit Enter without typing if they
 *     change their mind)
 */
export interface RenameInputRowProps {
  depth: number;
  initialName: string;
  /** Lowercase names already present at this level — used for dup check. */
  siblingNames: string[];
  /** Tree-style icon to render (e.g. 📁 / 📄). */
  icon: string;
  onSubmit: (newName: string) => Promise<void>;
  onCancel: () => void;
}

const INDENT_PX = 14;

export function RenameInputRow({
  depth,
  initialName,
  siblingNames,
  icon,
  onSubmit,
  onCancel,
}: RenameInputRowProps) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus + select-all on mount. Selecting all means typing
  // immediately replaces the name (matches Win Explorer F2 rename).
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  function validate(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return 'Name is required.';
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      return 'Name cannot contain slashes.';
    }
    if (trimmed === '.' || trimmed === '..') {
      return 'Reserved name.';
    }
    // Same-name is allowed (no-op rename); only reject true dup with a
    // different existing sibling.
    const lower = trimmed.toLowerCase();
    if (
      lower !== initialName.toLowerCase() &&
      siblingNames.includes(lower)
    ) {
      return 'Another item at this level already has that name.';
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
    // No-op if the name didn't change.
    if (trimmed === initialName) {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      setBusy(false);
      const message = e instanceof Error ? e.message : 'Could not rename.';
      setError(message);
    }
  }

  return (
    <div
      className="nc-tree-row nc-tree-renaming"
      style={{ paddingLeft: depth * INDENT_PX }}
    >
      <span className="nc-tree-chevron nc-tree-chevron-empty" aria-hidden="true" />
      <span className="nc-tree-icon" aria-hidden="true">{icon}</span>
      <input
        ref={inputRef}
        type="text"
        className="nc-tree-newfolder-input"
        value={name}
        disabled={busy}
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
        aria-label="Rename"
      />
      {error && <span className="nc-tree-newfolder-error" title={error}>!</span>}
    </div>
  );
}
