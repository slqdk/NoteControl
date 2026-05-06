import type { Editor, Range } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';

import { ApiError, assetsApi, templatesApi } from '../api/client';
import { getCachedTemplates } from './templateCache';

/**
 * One row in the slash-menu popup.
 *
 *   title    — primary label shown in the menu
 *   subtitle — secondary description (one line, optional)
 *   icon     — single-character glyph or short emoji
 *   keywords — extra strings that should match in the filter beyond
 *              the title (e.g. "h1" for heading-1)
 *   command  — invoked when the user picks the item. It receives
 *              the editor and the range that should be REPLACED
 *              (i.e. the "/" plus whatever filter text the user
 *              typed). The command must consume that range itself,
 *              typically via an editor.chain().focus().deleteRange().run()
 *              before doing its own insertion.
 *
 *              Optional when `submenuItems` is set — picking the
 *              item opens the submenu instead of running a command.
 *
 *   submenuItems — if set, picking the item navigates the slash
 *              menu's UI into a submenu showing these items
 *              instead. The submenu inherits the same trigger
 *              range; selecting an item in the submenu runs that
 *              item's command using the original range.
 */
export interface SlashMenuItem {
  title: string;
  subtitle?: string;
  icon: string;
  keywords?: string[];
  /** Optional. Required unless submenuItems is set. */
  command?: (args: { editor: Editor; range: Range }) => void | Promise<void>;
  /** Optional. If present, picking this item swaps the popup into submenu mode. */
  submenuItems?: () => SlashMenuItem[];
  /**
   * If true, this row is rendered with a different visual style
   * to indicate it's a back-navigation rather than an action.
   * Used in submenus to provide a way back to the main list.
   */
  isBack?: boolean;
}

/**
 * Args passed to the command-resolver below by the suggestion
 * plugin. `getNotePath` and `vaultId` are needed for the Image
 * picker, which uploads to the current note's assets folder.
 *
 * Two flags control which dynamic items appear:
 *
 *   allowImages    — include the "Image" item that opens a file
 *                    picker. Pre-Ship-98 templates set this false
 *                    because they had no asset folder. Ship 98
 *                    introduces template asset folders, so the
 *                    template editor now sets allowImages=true and
 *                    sets `templateName` to route uploads through
 *                    the template-asset endpoint instead.
 *
 *   allowTemplates — include the per-template items pulled from
 *                    the cache. Templates set this false to avoid
 *                    nested-template recursion in the picker
 *                    experience (a template inserting another
 *                    template is technically fine but confusing).
 *
 * Both default to true (the note-editor's behaviour).
 *
 * `templateName` (Ship 98): when set, the Image command uploads
 * via `templatesApi.uploadAsset` instead of `assetsApi.upload`.
 * When unset (the note editor's case), uploads go through the
 * note-asset path. The two are mutually exclusive — a given
 * editor instance is either editing a note (uses getNotePath) or
 * a template (uses templateName).
 */
export interface SlashMenuContext {
  getNotePath: () => string;
  vaultId: string;
  allowImages?: boolean;
  allowTemplates?: boolean;
  templateName?: string;
}

/**
 * After the user picks a slash-menu item we want them to land on
 * a fresh empty paragraph BELOW the just-inserted block, ready to
 * keep typing. Without this the cursor sits at the end of the
 * inserted node — fine for inline things like "Heading 1" (you
 * can still type the heading text), but awkward for blocks like
 * code, quote, or divider where the natural next step is to keep
 * writing prose.
 *
 * Strategy: after the item's command finishes, find the position
 * AFTER the node currently containing the selection, insert an
 * empty paragraph there if one isn't already, and place the
 * cursor inside it.
 */
function insertTrailingParagraph(editor: Editor): void {
  const { state, view } = editor;
  const { $to } = state.selection;

  // Walk up to the nearest top-level (depth 1) node containing the
  // selection. For a heading we want the paragraph AFTER the
  // heading — not after the whole document.
  let depth = $to.depth;
  while (depth > 1) depth--;
  const containerEnd = $to.end(depth);
  const after = containerEnd + 1;
  const docSize = state.doc.content.size;

  if (after > docSize) {
    // Already at the very end of the doc. Append a paragraph and
    // move the cursor into it.
    const tr = state.tr.insert(
      docSize,
      state.schema.nodes.paragraph.create(),
    );
    tr.setSelection(Selection.near(tr.doc.resolve(docSize + 1)));
    view.dispatch(tr.scrollIntoView());
    return;
  }

  // If the next node is already an empty paragraph, just move the
  // cursor into it instead of inserting another one.
  const $next = state.doc.resolve(after);
  const nextNode = $next.nodeAfter;
  if (
    nextNode &&
    nextNode.type.name === 'paragraph' &&
    nextNode.content.size === 0
  ) {
    const tr = state.tr.setSelection(Selection.near($next));
    view.dispatch(tr.scrollIntoView());
    return;
  }

  const tr = state.tr.insert(after, state.schema.nodes.paragraph.create());
  tr.setSelection(Selection.near(tr.doc.resolve(after + 1)));
  view.dispatch(tr.scrollIntoView());
}

/**
 * Build the full item list. Curried with the context so each item's
 * command can capture vaultId / current note path without us having
 * to thread state through the suggestion plugin's filter calls.
 */
export function buildSlashMenuItems(ctx: SlashMenuContext): SlashMenuItem[] {
  const items: SlashMenuItem[] = [
    // --- Headings ----------------------------------------------------
    {
      title: 'Heading 1',
      subtitle: 'Big section title',
      icon: 'H1',
      keywords: ['h1', 'heading', 'title'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode('heading', { level: 1 })
          .run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Heading 2',
      subtitle: 'Section heading',
      icon: 'H2',
      keywords: ['h2', 'heading'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode('heading', { level: 2 })
          .run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Heading 3',
      subtitle: 'Subsection heading',
      icon: 'H3',
      keywords: ['h3', 'heading'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode('heading', { level: 3 })
          .run();
        insertTrailingParagraph(editor);
      },
    },

    // --- Lists -------------------------------------------------------
    {
      title: 'Bullet list',
      subtitle: 'Unordered list',
      icon: '•',
      keywords: ['ul', 'unordered', 'list', 'bullets'],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleBulletList().run();
        // Lists naturally get an empty <li> as their first child;
        // adding a trailing paragraph here would put a blank line
        // between the list and whatever comes next which is what
        // the user expects when they type out of the list. We
        // leave the cursor in the first <li>.
      },
    },
    {
      title: 'Numbered list',
      subtitle: 'Ordered list',
      icon: '1.',
      keywords: ['ol', 'ordered', 'list', 'numbered'],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleOrderedList().run();
      },
    },

    // --- Code & quote ------------------------------------------------
    {
      title: 'Code block',
      subtitle: 'Multi-line code with editable title',
      icon: '</>',
      keywords: ['code', 'snippet', 'pre'],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Quote',
      subtitle: 'Blockquote for citing or emphasising',
      icon: '❝',
      keywords: ['quote', 'blockquote', 'cite'],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleBlockquote().run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Divider',
      subtitle: 'Horizontal line separator',
      icon: '—',
      keywords: ['hr', 'horizontal', 'rule', 'separator', 'line'],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setHorizontalRule().run();
        insertTrailingParagraph(editor);
      },
    },

    // --- Table -------------------------------------------------------
    {
      title: 'Table',
      subtitle: '3×3 table with header row',
      icon: '⊞',
      keywords: ['table', 'grid', 'rows', 'columns'],
      command: ({ editor, range }) => {
        // Insert a 3x3 with a header row. The TipTap table command
        // is provided by @tiptap/extension-table.
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run();
        insertTrailingParagraph(editor);
      },
    },

    // --- Callouts ----------------------------------------------------
    // Each callout variant gets its own slash item so users can type
    // /error, /warning etc. The variant attribute drives the colour.
    {
      title: 'Error callout',
      subtitle: 'Red box for errors / problems',
      icon: '🚨',
      keywords: ['error', 'callout', 'admonition', 'fejl'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertCallout('error')
          .run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Warning callout',
      subtitle: 'Yellow box for warnings / cautions',
      icon: '⚠️',
      keywords: ['warning', 'caution', 'callout', 'admonition'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertCallout('warning')
          .run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Info callout',
      subtitle: 'Blue box for informational content',
      icon: 'ℹ️',
      keywords: ['info', 'information', 'callout', 'admonition'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertCallout('info')
          .run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Tip callout',
      subtitle: 'Green box for tips / solutions',
      icon: '💡',
      keywords: ['tip', 'solution', 'l\u00f8sning', 'callout', 'admonition'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertCallout('tip')
          .run();
        insertTrailingParagraph(editor);
      },
    },
    {
      title: 'Note callout',
      subtitle: 'Gray box for general notes',
      icon: '📝',
      keywords: ['note', 'callout', 'admonition'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertCallout('note')
          .run();
        insertTrailingParagraph(editor);
      },
    },
  ];

  // --- Asset upload ------------------------------------------------
  // Gated: pre-Ship-98 templates passed allowImages=false because
  // they had no asset folder. Ship 98 introduces template asset
  // folders, so the template editor now keeps allowImages=true and
  // sets ctx.templateName — the command branches based on that to
  // hit either the note-asset endpoint or the template-asset
  // endpoint.
  if (ctx.allowImages !== false) {
    items.push({
      title: 'Image',
      subtitle: 'Pick a file to upload and insert',
      icon: '🖼',
      keywords: ['image', 'picture', 'photo', 'upload', 'img'],
      command: async ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        document.body.appendChild(input);

        const cleanup = () => {
          if (input.parentNode) input.parentNode.removeChild(input);
        };

        input.addEventListener('change', async () => {
          try {
            const file = input.files?.[0];
            if (!file) return;

            // Branch based on context: template-mode (Ship 98) goes
            // through templatesApi.uploadAsset; note-mode keeps the
            // existing assetsApi.upload path. We don't fall back —
            // an editor with allowImages=true must have either a
            // notePath or a templateName, and it's a real bug if
            // neither is set.
            let res;
            if (ctx.templateName) {
              res = await templatesApi.uploadAsset(
                ctx.vaultId,
                ctx.templateName,
                file,
                file.name,
              );
            } else {
              const notePath = ctx.getNotePath();
              if (!notePath) return;
              res = await assetsApi.upload(ctx.vaultId, notePath, file, file.name);
            }

            editor
              .chain()
              .focus()
              .setImage({
                src: res.relativeMarkdownPath,
                alt: res.originalFileName,
                title: res.originalFileName,
              })
              .run();
            insertTrailingParagraph(editor);
          } finally {
            cleanup();
          }
        });

        const onFocusBack = () => {
          window.removeEventListener('focus', onFocusBack);
          setTimeout(() => {
            if (!input.files || input.files.length === 0) {
              cleanup();
            }
          }, 300);
        };
        window.addEventListener('focus', onFocusBack);

        input.click();
      },
    });
  }

  // --- Templates (dynamic submenu) -------------------------------
  //
  // We expose ONE "Templates" item which, when picked, swaps the
  // slash menu's UI into submenu mode showing the available
  // templates. Picking a template from the submenu inserts its
  // body at the original / position.
  //
  // This is added at the END of the items array here, but the
  // caller (buildSlashMenuItemsWithTemplatesFirst below) splices
  // it into position 0 so it sits at the top of the menu.
  //
  // Gated by allowTemplates — the template editor itself doesn't
  // offer this submenu (avoids template-of-template recursion).
  if (ctx.allowTemplates !== false) {
    const templates = getCachedTemplates(ctx.vaultId);
    if (templates.length > 0) {
      const submenuItems: () => SlashMenuItem[] = () => {
        // Build fresh on every open so the cache is current. The
        // back row sits at index 0; templates follow.
        const back: SlashMenuItem = {
          title: '← Back',
          subtitle: 'Return to the main menu',
          icon: '↩',
          keywords: ['back', 'return'],
          isBack: true,
        };
        const list: SlashMenuItem[] = [back];
        for (const tpl of templates) {
          list.push({
            title: tpl.name,
            subtitle: 'Template',
            icon: '📋',
            keywords: [tpl.name.toLowerCase()],
            command: async ({ editor, range }) => {
              try {
                const full = await templatesApi.get(ctx.vaultId, tpl.name);
                editor
                  .chain()
                  .focus()
                  .deleteRange(range)
                  .insertContent(full.body)
                  .run();
              } catch (e) {
                if (e instanceof ApiError) {
                  editor.chain().focus().deleteRange(range).run();
                }
              }
            },
          });
        }
        return list;
      };

      // Stick the Templates entry at the TOP of the menu — it's
      // a frequent action and keeping it visible without
      // scrolling matters.
      items.unshift({
        title: 'Templates',
        subtitle: `${templates.length} available · click for list`,
        icon: '📋',
        keywords: ['template', 'templates'],
        submenuItems,
      });
    }
  }

  return items;
}

/**
 * Filter the items for a given query (the text after "/"). Matches
 * against title and keywords, case-insensitively. An empty query
 * returns the full list in original order.
 *
 * Scoring is simple: prefix match on title beats infix match beats
 * keyword match. Exact prefix is the strongest signal.
 */
export function filterSlashItems(
  items: SlashMenuItem[],
  query: string,
): SlashMenuItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;

  type Scored = { item: SlashMenuItem; score: number };
  const scored: Scored[] = [];

  for (const item of items) {
    const title = item.title.toLowerCase();
    let score = 0;
    if (title === q) score = 1000;
    else if (title.startsWith(q)) score = 500;
    else if (title.includes(q)) score = 200;
    else if (item.keywords?.some((k) => k.toLowerCase().startsWith(q))) score = 150;
    else if (item.keywords?.some((k) => k.toLowerCase().includes(q))) score = 100;

    if (score > 0) {
      scored.push({ item, score });
    }
  }

  // Stable sort by score descending. items.indexOf preserves
  // original order within a score band.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return items.indexOf(a.item) - items.indexOf(b.item);
  });

  return scored.map((s) => s.item);
}
