import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';

import { VideoNodeView } from '../components/VideoNodeView';

/**
 * Inline video block.
 *
 * Mirrors ImageWithControls but for videos. Renders a real <video>
 * element with browser-default controls. Pasting/dropping a video
 * file inserts one of these nodes immediately, so the user sees
 * the player without needing to save+reload.
 *
 * Markdown has no native video syntax. The serialiser emits raw
 * HTML <video src="..." controls></video>, and parseHTML reads
 * the same shape back. CommonMark accepts inline HTML transparently
 * so this round-trips through any markdown viewer that preserves
 * raw HTML (which is most of them).
 *
 * Attributes carried per-node:
 *   src     — relative path to the video file (e.g. "Plan.assets/clip.mp4")
 *   width   — pixels, optional. Set by drag-resize handles.
 *
 * No border attribute (like images have) because video frames are
 * always self-contained rectangles; a border around a video looks
 * like a window-chrome artifact. We can add one later if needed.
 *
 * No autoplay/loop/muted attributes — videos always render with
 * just the standard controls. User clicks play. Reduces surprise
 * audio when navigating between notes.
 *
 * Accepted source extensions: anything the browser will play. We
 * don't gate on extension here — if the browser can decode it, the
 * `<video>` element shows it; if not, it shows a broken-video
 * indicator and the user can fall back to right-click → save-as.
 */
export interface VideoOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    video: {
      /** Insert a video node at the current selection. */
      setVideo: (attrs: { src: string; width?: number | null }) => ReturnType;
    };
  }
}

export const VideoExtension = Node.create<VideoOptions>({
  name: 'video',
  group: 'block',
  draggable: true,
  selectable: true,
  // No content — the node is "atomic" from ProseMirror's POV. We
  // don't store text inside; the src attribute carries everything.
  atom: true,

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (element) => element.getAttribute('src'),
        renderHTML: (attributes) => {
          if (!attributes.src) return {};
          return { src: attributes.src };
        },
      },
      width: {
        default: null,
        parseHTML: (element) => {
          // Width may come from the explicit attribute or an inline
          // style — prefer the attribute since it's what we emit.
          const attr = element.getAttribute('width');
          if (attr) {
            const n = parseInt(attr, 10);
            return Number.isFinite(n) ? n : null;
          }
          const style = (element as HTMLElement).style?.width;
          if (style && style.endsWith('px')) {
            const n = parseInt(style, 10);
            return Number.isFinite(n) ? n : null;
          }
          return null;
        },
        renderHTML: (attributes) => {
          if (!attributes.width) return {};
          return {
            width: attributes.width,
            style: `width: ${attributes.width}px; height: auto;`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      // Match plain <video> tags. No `data-type` filter — any
      // <video> in pasted markdown / HTML becomes a video node.
      { tag: 'video' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    // The `controls` attribute is hardcoded — every emitted video
    // has the browser playback chrome. This isn't an attribute
    // because we don't expose a toggle for it.
    return [
      'video',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        controls: 'true',
      }),
    ];
  },

  addCommands() {
    return {
      setVideo:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs,
          }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(VideoNodeView);
  },

  /**
   * Markdown round-trip via tiptap-markdown's storage hook.
   *
   * Always emit raw HTML — markdown has no video syntax.
   * Width is included as an attribute when non-default, so the
   * resize state survives save+load.
   */
  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            write: (s: string) => void;
            closeBlock: (n: unknown) => void;
          },
          node: { attrs: Record<string, unknown> },
        ) {
          const src = (node.attrs.src as string) ?? '';
          const width = node.attrs.width as number | null;

          const parts: string[] = ['<video'];
          parts.push(` src="${escapeAttr(src)}"`);
          parts.push(' controls');
          if (width) {
            parts.push(` width="${width}"`);
            parts.push(` style="width: ${width}px; height: auto;"`);
          }
          parts.push('></video>');
          state.write(parts.join(''));
          state.closeBlock(node);
        },
      },
    };
  },
});

/**
 * Minimal HTML attribute escaping. Same as ImageWithControls — keeps
 * the round-tripped HTML well-formed without pulling in a full
 * encoder.
 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');
}
