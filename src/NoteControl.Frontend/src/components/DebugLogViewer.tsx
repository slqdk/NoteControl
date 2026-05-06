import { useEffect, useState } from 'react';

import {
  clear,
  getEntries,
  isRecording,
  start,
  stop,
  subscribe,
  toJson,
  type DebugEntry,
} from '../util/debugRecorder';

/**
 * Debug log viewer. An admin-only overlay that lists the recorded
 * entries (api calls, console errors, clicks, navigation, image
 * load failures) and offers Copy-as-JSON / Clear / Start-Stop
 * controls.
 *
 * Mounted as a fixed-position overlay (full-page modal feel), not
 * a popover, because the log can grow long and benefits from
 * scrollable real estate. The user dismisses with the Close button
 * or Escape.
 *
 * The list re-renders whenever the recorder pushes a new entry,
 * via the subscribe() hook in debugRecorder.ts. We don't bother
 * with virtualisation — MAX_ENTRIES is 500, and each row is light.
 *
 * Caveat surfaced in the UI: recorded bodies may include note
 * content, so the user is reminded before they hit Copy.
 */
interface DebugLogViewerProps {
  onClose: () => void;
}

export function DebugLogViewer({ onClose }: DebugLogViewerProps) {
  // Bump a counter on every recorder notify() so we re-render.
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);

  // Esc to close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const recording = isRecording();
  const entries = getEntries();

  async function onCopy() {
    const json = toJson();
    try {
      await navigator.clipboard.writeText(json);
      // Brief visual confirmation. We don't want a full toast
      // system just for this — a tiny class flip on the button
      // would be enough but isn't strictly necessary.
      // eslint-disable-next-line no-alert
      alert(`Copied ${entries.length} entries to clipboard.`);
    } catch {
      // Clipboard API requires HTTPS or localhost. Fall back to
      // a textarea-select dance that works on plain HTTP.
      const ta = document.createElement('textarea');
      ta.value = json;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
        // eslint-disable-next-line no-alert
        alert(`Copied ${entries.length} entries to clipboard.`);
      } catch {
        // eslint-disable-next-line no-alert
        alert('Could not copy to clipboard. Use the JSON below.');
      }
      ta.remove();
    }
  }

  return (
    <div
      className="nc-debug-overlay"
      role="dialog"
      aria-label="Debug recording log"
      onClick={(e) => {
        // Click on the backdrop closes; clicks inside the panel
        // don't bubble here because of the inner div's stopPropagation.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nc-debug-panel" onClick={(e) => e.stopPropagation()}>
        <div className="nc-debug-header">
          <strong>Debug recording</strong>
          <span className="nc-debug-status">
            {recording ? '● Recording' : '○ Stopped'} · {entries.length} entries
          </span>
          <div className="nc-debug-actions">
            {recording ? (
              <button type="button" className="nc-debug-btn" onClick={() => stop()}>
                Stop
              </button>
            ) : (
              <button type="button" className="nc-debug-btn" onClick={() => start()}>
                Start
              </button>
            )}
            <button
              type="button"
              className="nc-debug-btn"
              onClick={() => clear()}
              disabled={entries.length === 0}
            >
              Clear
            </button>
            <button
              type="button"
              className="nc-debug-btn nc-debug-btn-primary"
              onClick={onCopy}
              disabled={entries.length === 0}
            >
              Copy JSON
            </button>
            <button type="button" className="nc-debug-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="nc-debug-notice">
          Note content from save requests is captured here. Don't
          paste this log somewhere public if your notes are sensitive.
        </div>

        <div className="nc-debug-list">
          {entries.length === 0 ? (
            <div className="nc-debug-empty">
              {recording
                ? 'Recording — interact with the app to capture events.'
                : 'No entries. Click Start to begin recording.'}
            </div>
          ) : (
            entries.map((e) => <DebugRow key={e.seq} entry={e} />)
          )}
        </div>
      </div>
    </div>
  );
}

function DebugRow({ entry }: { entry: DebugEntry }) {
  // Compact one-liner with the fields that matter for the kind,
  // plus a click-to-expand details block for the full payload.
  const [expanded, setExpanded] = useState(false);
  const summary = summarise(entry);
  const klass = `nc-debug-kind-${entry.kind}`;
  return (
    <div className={`nc-debug-row ${klass}`}>
      <button
        type="button"
        className="nc-debug-row-summary"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="nc-debug-ms">+{entry.ms}ms</span>
        <span className="nc-debug-kind">{entry.kind}</span>
        <span className="nc-debug-summary-text">{summary}</span>
      </button>
      {expanded && (
        <pre className="nc-debug-row-details">
          {JSON.stringify(entry.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function summarise(entry: DebugEntry): string {
  const d = entry.data as Record<string, unknown>;
  switch (entry.kind) {
    case 'api':
    case 'fetch': {
      const status = d.status ?? d.errorStatus ?? '—';
      const dur = d.durationMs !== undefined ? `${d.durationMs}ms` : '';
      const err = d.error ? ` ⚠ ${d.error}` : '';
      return `${d.method} ${d.path ?? d.url} → ${status} ${dur}${err}`;
    }
    case 'console': {
      const args = d.args as unknown[];
      const first = args && args[0];
      const text =
        typeof first === 'string'
          ? first
          : first && typeof first === 'object' && 'message' in (first as object)
            ? (first as { message: string }).message
            : JSON.stringify(first);
      return `[${d.level}] ${truncateLine(text, 120)}`;
    }
    case 'click':
      return `${d.target}`;
    case 'nav':
      return `${d.kind}: ${d.url}`;
    case 'image':
      return `failed: ${d.src}`;
    case 'error':
      return `${d.message ?? '(no message)'}${d.kind ? ` [${d.kind}]` : ''}`;
    case 'mark':
      return `— ${d.message} —`;
    default:
      return '';
  }
}

function truncateLine(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}
