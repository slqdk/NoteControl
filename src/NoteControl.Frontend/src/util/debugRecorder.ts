// Debug recorder. Captures a rolling buffer of frontend events
// (API calls, console errors/warnings, clicks, navigation, image
// load failures) so an admin can reproduce a "weird thing", then
// copy the JSON log and paste it into a bug report / chat with
// Claude.
//
// Design notes:
//
//   - Recording is off by default. The whole point is to be silent
//     unless an admin flipped it on; we never want a stray buffer
//     to grow in normal use.
//
//   - Storage is in-memory only. No localStorage, no IndexedDB.
//     Closing or reloading the tab clears the log. This is a debug
//     aid, not an audit trail. Persisting would also leak
//     potentially-sensitive request/response bodies.
//
//   - Ring buffer with a bounded entry count. When full, oldest
//     entries fall off. Default 500 entries — enough to capture a
//     multi-step "I clicked X, then Y, then it broke" scenario
//     without using meaningful memory even if bodies are at the
//     truncation cap.
//
//   - Bodies (request/response/click target HTML) are truncated at
//     a per-field cap. The truncation is visible in the JSON
//     output so the reader knows something was elided.
//
//   - Hooks install lazily on first start() and stay installed for
//     the page lifetime. Turning recording off just flips a flag —
//     the hooks all early-return when not recording. This means
//     start/stop is cheap and doesn't require a reload.
//
//   - The `recordApi` export is what api/client.ts calls directly.
//     It exists in addition to the global fetch patch because the
//     api/client wrapper has the original input/output shapes
//     before they get serialized to JSON, which makes the entries
//     more useful (e.g. we get the parsed error object, not the
//     raw response stream). The global fetch patch is the safety
//     net for the few direct fetch() calls in the codebase
//     (multipart asset uploads).
//
// Caveats (be honest):
//
//   - Admin gating is purely a UI affordance. Anyone with the dev
//     console open can call window.__ncDebug.start() directly.
//     This is fine: the recorder doesn't grant any new access — it
//     records traffic the user could already see in DevTools'
//     Network/Console tabs. The toggle is ergonomic, not a
//     security boundary.
//
//   - Recording bodies means request payloads (e.g. note content
//     being saved) end up in the buffer. If you copy the log and
//     paste it somewhere, the contents go with it. The viewer
//     surfaces this with a small notice.
//
//   - Clicks are captured at document level. We log a CSS-ish
//     descriptor of the target (tag + classes + nearest button/
//     link text), not the full DOM. This avoids dumping the entire
//     editor surface every time someone types in a note.

const MAX_ENTRIES = 500;
const MAX_BODY_BYTES = 2048; // per request/response body

export type DebugEntryKind =
  | 'api'        // request through api/client.ts (typed)
  | 'fetch'      // raw fetch() (multipart uploads etc)
  | 'console'   // console.error/warn
  | 'click'      // pointerdown anywhere
  | 'nav'        // route change
  | 'image'      // <img> error event
  | 'error'      // window 'error' / 'unhandledrejection'
  | 'mark';      // user-inserted marker

export interface DebugEntry {
  /** Monotonically increasing across the page session. */
  seq: number;
  /** ISO timestamp. */
  t: string;
  /** Milliseconds since recording started (for relative timing). */
  ms: number;
  kind: DebugEntryKind;
  /** Free-form payload, kind-specific. Always JSON-serializable. */
  data: Record<string, unknown>;
}

interface RecorderState {
  recording: boolean;
  startedAt: number; // performance.now() when last started
  buffer: DebugEntry[];
  seq: number;
  hooksInstalled: boolean;
}

const state: RecorderState = {
  recording: false,
  startedAt: 0,
  buffer: [],
  seq: 0,
  hooksInstalled: false,
};

// Listeners get called whenever recording state or buffer changes,
// so React components can re-render. We don't bother debouncing —
// the viewer is only mounted while open and entries arrive at
// human-click cadence, not millions per second.
type Listener = () => void;
const listeners = new Set<Listener>();
function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      // A listener throwing must not break the recorder.
    }
  }
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function push(kind: DebugEntryKind, data: Record<string, unknown>): void {
  if (!state.recording) return;
  const entry: DebugEntry = {
    seq: ++state.seq,
    t: new Date().toISOString(),
    ms: Math.round(performance.now() - state.startedAt),
    kind,
    data,
  };
  state.buffer.push(entry);
  if (state.buffer.length > MAX_ENTRIES) {
    // Drop oldest. shift() is O(n) but n is bounded at MAX_ENTRIES
    // and this only fires once per overflow.
    state.buffer.splice(0, state.buffer.length - MAX_ENTRIES);
  }
  notify();
}

function truncate(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length > MAX_BODY_BYTES) {
      return `${value.slice(0, MAX_BODY_BYTES)}…[truncated, original ${value.length} chars]`;
    }
    return value;
  }
  if (value === null || value === undefined) return value;
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (json.length > MAX_BODY_BYTES) {
        return `${json.slice(0, MAX_BODY_BYTES)}…[truncated, original ${json.length} chars]`;
      }
      return value;
    } catch {
      return '[unserializable]';
    }
  }
  return value;
}

// --- Public API: typed API call recorder ---
//
// Called from api/client.ts's request() wrapper. We get start/end
// timing and the parsed error (if any), which is more useful than
// what the raw fetch hook can derive.

export interface ApiCallRecord {
  method: string;
  path: string;
  body?: unknown;
  status?: number;
  durationMs: number;
  errorMessage?: string;
  errorStatus?: number;
}

export function recordApi(rec: ApiCallRecord): void {
  if (!state.recording) return;
  const data: Record<string, unknown> = {
    method: rec.method,
    path: rec.path,
    durationMs: rec.durationMs,
  };
  if (rec.body !== undefined) data.body = truncate(rec.body);
  if (rec.status !== undefined) data.status = rec.status;
  if (rec.errorMessage) data.error = rec.errorMessage;
  if (rec.errorStatus !== undefined) data.errorStatus = rec.errorStatus;
  push('api', data);
}

// --- Hooks (installed once on first start) ---
//
// Each hook wraps the global it patches by capturing the original
// reference and forwarding to it. The wrapper short-circuits on
// state.recording === false so the cost when off is just a flag
// check.

function installHooks(): void {
  if (state.hooksInstalled) return;
  state.hooksInstalled = true;

  // 1. Global fetch patch — catches direct fetch() calls (asset
  // multipart uploads in api/client.ts, and anything else outside
  // the request() wrapper).
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const t0 = performance.now();
    const method = (init?.method ?? 'GET').toUpperCase();
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    try {
      const response = await originalFetch(input, init);
      // Only log calls NOT going through the typed wrapper.
      // The typed wrapper records itself with richer info; we'd
      // double-log otherwise. Heuristic: typed calls all have
      // 'Accept: application/json' and a JSON content-type set
      // by the wrapper. The cleanest signal is the 'X-Nc-Typed'
      // header — but we don't want to add a header solely for
      // this. Instead, the wrapper sets a flag on init we look
      // for here.
      const skip = (init as RequestInit & { __ncTyped?: boolean })?.__ncTyped;
      if (!skip) {
        push('fetch', {
          method,
          url,
          status: response.status,
          durationMs: Math.round(performance.now() - t0),
        });
      }
      return response;
    } catch (e) {
      const skip = (init as RequestInit & { __ncTyped?: boolean })?.__ncTyped;
      if (!skip) {
        push('fetch', {
          method,
          url,
          error: e instanceof Error ? e.message : String(e),
          durationMs: Math.round(performance.now() - t0),
        });
      }
      throw e;
    }
  };

  // 2. Console error/warn patch.
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    push('console', { level: 'error', args: args.map(formatConsoleArg) });
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    push('console', { level: 'warn', args: args.map(formatConsoleArg) });
    origWarn(...args);
  };

  // 3. Click capture. We listen at document level in the capture
  // phase so we see the click before any handlers run — useful when
  // the bug is "click handler didn't fire" because we still log
  // that the click happened.
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!state.recording) return;
      const target = e.target as Element | null;
      if (!target) return;
      push('click', {
        target: describeElement(target),
        button: e.button,
      });
    },
    { capture: true },
  );

  // 4. Navigation. react-router-dom uses pushState/replaceState
  // under the hood, so we patch those plus listen for popstate
  // (back/forward).
  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);
  history.pushState = function patchedPush(...args) {
    const result = origPushState(...args);
    push('nav', { kind: 'push', url: location.pathname + location.search });
    return result;
  };
  history.replaceState = function patchedReplace(...args) {
    const result = origReplaceState(...args);
    push('nav', { kind: 'replace', url: location.pathname + location.search });
    return result;
  };
  window.addEventListener('popstate', () => {
    push('nav', { kind: 'pop', url: location.pathname + location.search });
  });

  // 5. Image load errors — directly addresses "pictures
  // disappear". <img> elements fire 'error' events that don't
  // bubble, but they DO fire in capture. We'd miss it without
  // capture: true.
  document.addEventListener(
    'error',
    (e) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (target.tagName === 'IMG') {
        const img = target as HTMLImageElement;
        push('image', {
          src: img.currentSrc || img.src,
          alt: img.alt,
        });
      }
    },
    { capture: true },
  );

  // 6. Uncaught errors and unhandled promise rejections. These
  // are the smoking gun for "the action didn't happen" bugs.
  window.addEventListener('error', (e) => {
    push('error', {
      message: e.message,
      source: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error instanceof Error ? e.error.stack : undefined,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    push('error', {
      message:
        reason instanceof Error ? reason.message : String(reason),
      kind: 'unhandledrejection',
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

function formatConsoleArg(arg: unknown): unknown {
  if (arg instanceof Error) {
    return { message: arg.message, stack: arg.stack };
  }
  return truncate(arg);
}

function describeElement(el: Element): string {
  // Find the most useful ancestor for click context. If the click
  // landed on a <span> inside a <button>, the button is what we
  // want to describe.
  const interactive = el.closest('button, a, [role="button"], [role="menuitem"]');
  const target = interactive ?? el;
  const tag = target.tagName.toLowerCase();
  const id = target.id ? `#${target.id}` : '';
  const cls =
    typeof target.className === 'string' && target.className
      ? `.${target.className.trim().split(/\s+/).slice(0, 3).join('.')}`
      : '';
  const text = (target.textContent ?? '').trim().slice(0, 40);
  const title = target.getAttribute('title');
  const aria = target.getAttribute('aria-label');
  return `${tag}${id}${cls}${title ? `[title="${title}"]` : ''}${aria ? `[aria-label="${aria}"]` : ''}${text ? ` "${text}"` : ''}`;
}

// --- Public API: control + readback ---

export function isRecording(): boolean {
  return state.recording;
}

export function start(): void {
  if (state.recording) return;
  installHooks();
  state.recording = true;
  state.startedAt = performance.now();
  state.seq = 0;
  state.buffer = [];
  push('mark', { message: 'recording started' });
  notify();
}

export function stop(): void {
  if (!state.recording) return;
  push('mark', { message: 'recording stopped' });
  state.recording = false;
  notify();
}

export function clear(): void {
  state.buffer = [];
  state.seq = 0;
  notify();
}

export function getEntries(): readonly DebugEntry[] {
  return state.buffer;
}

export function entryCount(): number {
  return state.buffer.length;
}

/** Build a JSON document suitable for pasting into a chat. */
export function toJson(): string {
  const ua = navigator.userAgent;
  const url = location.href;
  return JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      url,
      userAgent: ua,
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
      },
      entries: state.buffer,
    },
    null,
    2,
  );
}

// Expose a console handle for advanced use. We don't document
// this in the UI — it's for power users who want to start/stop
// from devtools, e.g. to script a repro.
declare global {
  interface Window {
    __ncDebug?: {
      start: () => void;
      stop: () => void;
      clear: () => void;
      isRecording: () => boolean;
      getEntries: () => readonly DebugEntry[];
      toJson: () => string;
    };
  }
}
window.__ncDebug = { start, stop, clear, isRecording, getEntries, toJson };
