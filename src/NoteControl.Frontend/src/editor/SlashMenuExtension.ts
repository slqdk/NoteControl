import { Extension } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';

import {
  buildSlashMenuItems,
  filterSlashItems,
  type SlashMenuContext,
  type SlashMenuItem,
} from './slashMenuItems';
import {
  SlashMenuList,
  type SlashMenuListHandle,
} from '../components/SlashMenuList';

/**
 * Slash-menu extension. Triggers on "/" at the start of a line
 * (or after whitespace), shows a popup of insertable blocks, and
 * runs the chosen item's command on Enter / click.
 *
 * Built on `@tiptap/suggestion` + `tippy.js`, the standard recipe
 * from TipTap's docs. The suggestion plugin handles the heavy
 * lifting (matching the trigger char, tracking the range, fielding
 * keystrokes); we plug in the React popup via tippy.
 *
 * Configurable bits:
 *   - vaultId / getNotePath are passed to the items registry so
 *     the Image command can upload to the right note.
 *   - items + filter are exposed for testing / future extension
 *     (e.g. step 10 will register template items here).
 */

export interface SlashMenuOptions {
  context: SlashMenuContext;
}

export const SlashMenuExtension = Extension.create<SlashMenuOptions>({
  name: 'slashMenu',

  addOptions() {
    return {
      context: { vaultId: '', getNotePath: () => '' },
    };
  },

  addProseMirrorPlugins() {
    const ctx = this.options.context;

    // Shared popup ref so the suggestion's command callback can
    // explicitly hide the popup before running the item's command.
    // Without this, the popup occasionally stayed visible after an
    // item was picked — e.g. inserting a callout left the menu
    // floating because the editor's selection moved into the new
    // node's body in a way that didn't trigger the suggestion
    // plugin's onExit reliably. Hiding here is bulletproof.
    let activePopup: TippyInstance | null = null;

    return [
      Suggestion({
        editor: this.editor,
        char: '/',
        // Trigger only when "/" starts a line or follows whitespace;
        // saves us from popup interruptions when "/" is typed inside
        // a URL or as a literal forward-slash in prose.
        startOfLine: false,
        allowSpaces: false,
        items: ({ query }) => {
          const all = buildSlashMenuItems(ctx);
          return filterSlashItems(all, query);
        },
        command: ({ editor, range, props }) => {
          // Hide the popup IMMEDIATELY, before the item's command
          // runs. If we wait for the plugin to call onExit, the
          // popup can hover briefly while the command is still
          // executing — which looks like the popup "stuck open"
          // after picking an item. Destroying it now is safe; the
          // plugin will also call onExit later, which is a no-op
          // because we null out the ref.
          if (activePopup) {
            activePopup.destroy();
            activePopup = null;
          }
          const item = props as SlashMenuItem;
          // Items that ONLY open a submenu have no command — they
          // were handled inside SlashMenuList's selectItem before
          // reaching us. But guard anyway in case a future item
          // shape doesn't have one.
          if (item.command) {
            void item.command({ editor, range });
          }
        },
        render: () => {
          let component: ReactRenderer<SlashMenuListHandle> | null = null;
          let popup: TippyInstance | null = null;

          return {
            onStart: (props) => {
              component = new ReactRenderer(SlashMenuList, {
                props,
                editor: props.editor,
              });

              if (!props.clientRect) return;

              popup = tippy(document.body, {
                getReferenceClientRect: props.clientRect as () => DOMRect,
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: 'manual',
                placement: 'bottom-start',
                // No arrow — we want a clean dropdown, not a tooltip.
                arrow: false,
                // Light theme by default; tippy.js's dark theme is
                // optional and we don't ship it. CSS overrides it
                // for our look anyway.
                theme: 'light-border',
                // Match popup width to a sensible default; the
                // content sets its own min-width via CSS.
                maxWidth: 320,
              });
              // Share the popup reference with the outer command
              // callback so it can hide the popup explicitly when
              // an item is picked.
              activePopup = popup;
            },

            onUpdate: (props) => {
              component?.updateProps(props);
              if (props.clientRect && popup) {
                popup.setProps({
                  getReferenceClientRect: props.clientRect as () => DOMRect,
                });
              }
            },

            onKeyDown: (props) => {
              if (props.event.key === 'Escape') {
                popup?.hide();
                return true;
              }
              return component?.ref?.onKeyDown(props) ?? false;
            },

            onExit: () => {
              // Destroy may have already happened in our command
              // callback; that's fine, tippy's destroy is
              // idempotent for our purposes (a destroyed instance
              // doesn't throw on a second destroy() call).
              popup?.destroy();
              component?.destroy();
              popup = null;
              component = null;
              if (activePopup) activePopup = null;
            },
          };
        },
      } as SuggestionOptions),
    ];
  },
});
