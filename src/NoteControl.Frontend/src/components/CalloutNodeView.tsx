import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from '@tiptap/react';

import type { CalloutVariant } from '../editor/CalloutExtension';

/**
 * One callout variant's visual identity.
 */
const VARIANT_META: Record<
  CalloutVariant,
  { label: string; icon: string }
> = {
  error: { label: 'Error', icon: '🚨' },
  warning: { label: 'Warning', icon: '⚠️' },
  info: { label: 'Info', icon: 'ℹ️' },
  tip: { label: 'Tip', icon: '💡' },
  note: { label: 'Note', icon: '📝' },
};

/**
 * Callout block — minimal, no interactive picker.
 *
 * The variant is set when the callout is inserted (via the slash
 * menu's /error, /warning, /info, /tip, /note items) and is fixed
 * for the lifetime of that block. To "change variant" the user
 * deletes and re-inserts.
 *
 * Earlier iterations had a clickable variant chip with a dropdown
 * picker, but it kept popping open at the wrong times and stealing
 * focus from the body. Rather than ship something that interferes
 * with typing, we drop the interactive picker for v1. The chip is
 * still visually present as a label so users can see at a glance
 * what variant they've inserted.
 *
 * Layout: variant chip floats in the top-right corner; the rest
 * of the box is the editable body.
 */
export function CalloutNodeView({ node }: NodeViewProps) {
  const variant = (node.attrs.variant as CalloutVariant) ?? 'note';
  const meta = VARIANT_META[variant];

  return (
    <NodeViewWrapper
      className={`nc-callout nc-callout-${variant}`}
      data-variant={variant}
    >
      {/*
        Static chip in the top-right. contentEditable=false so
        ProseMirror leaves it alone. No interactive elements
        inside — it's purely a visual label.
      */}
      <div className="nc-callout-chip" contentEditable={false}>
        <span className="nc-callout-icon">{meta.icon}</span>
        <span className="nc-callout-label">{meta.label}</span>
      </div>
      <NodeViewContent className="nc-callout-body" />
    </NodeViewWrapper>
  );
}
