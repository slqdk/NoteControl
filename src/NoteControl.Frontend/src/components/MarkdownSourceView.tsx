import { useEffect, useRef } from 'react';

import type { NoteDto } from '../api/types';
import { useNoteDefaults, resolveNoteAppearance } from '../settings/noteDefaults';

/**
 * Read-only "source view" for a note's markdown body.
 *
 * Rendered as a swap-in replacement for the live <NoteEditor> when
 * the user has flipped the View toggle in the properties panel.
 * Kept deliberately dumb: it shows the note body as plain monospace
 * text inside the same .nc-editor-page-area surface the editor uses,
 * so the swap is visually in-place and doesn't disturb the
 * surrounding shell (tree, properties panel, breadcrumb).
 *
 * Width / font-size / per-note appearance are honoured via the same
 * CSS custom properties the editor sets on its shell — see
 * NoteEditor.tsx for the rationale on using vars over inline styles.
 * Width / size resolution mirrors the editor exactly so the source
 * view feels like the same "page" the user was just looking at.
 *
 * Font on the source view is intentionally pinned to monospace
 * regardless of the note's `font` frontmatter — code is monospace,
 * and the user toggled this to see "the code behind" the note. We
 * still honour width and font-size so the page width matches the
 * rendered view.
 *
 * What this component does NOT do:
 *   - It does not allow editing. Source-view edits would need to
 *     parse markdown back into the editor's internal representation,
 *     which is the editor's whole job. If you need to hand-edit
 *     the on-disk markdown, use Export as .md / re-import.
 *   - It does not display the YAML frontmatter block. The body the
 *     server ships in NoteDto is markdown WITHOUT frontmatter — the
 *     frontmatter is broken out into the properties panel's own
 *     fields. Showing it twice would be misleading.
 *   - It does not refetch on its own. EditorPage flushes any
 *     pending save and refetches the note before swapping to source
 *     mode, so what we render here is the freshest available body.
 */
interface MarkdownSourceViewProps {
  note: NoteDto;
}

export function MarkdownSourceView({ note }: MarkdownSourceViewProps) {
  const noteDefaults = useNoteDefaults();
  const shellRef = useRef<HTMLDivElement>(null);

  // Mirror the appearance-variable wiring from NoteEditor so the
  // source-view "page" inherits the same width and font-size as
  // the rendered page. We deliberately don't apply the per-note
  // font — see component-level comment.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const resolved = resolveNoteAppearance(
      {
        font: note.frontmatter.font,
        fontSize: note.frontmatter.fontSize,
        width: note.frontmatter.width,
      },
      noteDefaults.defaults,
    );
    if (resolved.width) {
      shell.style.setProperty('--nc-note-width', resolved.width);
    } else {
      shell.style.removeProperty('--nc-note-width');
    }
    if (resolved.fontSize) {
      shell.style.setProperty('--nc-note-font-size', resolved.fontSize);
    } else {
      shell.style.removeProperty('--nc-note-font-size');
    }
    // No font setProperty: source view always uses monospace.
  }, [
    note.frontmatter.font,
    note.frontmatter.fontSize,
    note.frontmatter.width,
    noteDefaults.defaults.fontStack,
    noteDefaults.defaults.fontSize,
    noteDefaults.defaults.width,
  ]);

  return (
    <div className="nc-editor-shell" ref={shellRef}>
      <div className="nc-editor-page-area">
        {/*
          The body string from NoteDto is plain markdown without the
          YAML frontmatter. We render it inside <pre> so newlines and
          leading whitespace (indented list items, code blocks) are
          preserved verbatim.

          white-space: pre-wrap (set in CSS) lets long lines wrap at
          the page width instead of overflowing — a horizontal
          scrollbar would be jarring for prose content. Code blocks
          inside the markdown still read fine because they keep their
          fenced ``` markers and are paragraph-shaped anyway.
        */}
        <pre className="nc-editor nc-source-view">{note.body}</pre>
      </div>
    </div>
  );
}
