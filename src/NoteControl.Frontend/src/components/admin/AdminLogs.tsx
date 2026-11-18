import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { adminApi, usersApi } from '../../api/client';
import type { AuditEntryDto, ServerLogLineDto, ServerLogTailDto, UserDto } from '../../api/types';
import { errorText, formatDateTime } from './adminUtil';

/**
 * Admin → Logs tab (replaces the tray's Logs window):
 *   - Audit: who did what (logins, password changes, vault and user
 *     changes, backups, exports), filterable, paged backwards.
 *   - Server log: tail of today's Serilog file with level filter and
 *     optional auto-refresh.
 */
export function AdminLogs() {
  const [view, setView] = useState<'audit' | 'server'>('audit');
  return (
    <section className="nc-admin-section">
      <div className="nc-admin-section-head">
        <div className="nc-admin-segment" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'audit'}
            className={view === 'audit' ? 'nc-admin-segment-on' : undefined}
            onClick={() => setView('audit')}
          >
            Audit
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'server'}
            className={view === 'server' ? 'nc-admin-segment-on' : undefined}
            onClick={() => setView('server')}
          >
            Server log
          </button>
        </div>
      </div>
      {view === 'audit' ? <AuditView /> : <ServerLogView />}
    </section>
  );
}

// ------------------------------------------------------------------ Audit

const PAGE = 200;

function AuditView() {
  const [entries, setEntries] = useState<AuditEntryDto[] | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [users, setUsers] = useState<UserDto[]>([]);
  const [eventType, setEventType] = useState('');
  const [userId, setUserId] = useState('');
  const [sinceDate, setSinceDate] = useState('');
  const [text, setText] = useState('');
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [t, u] = await Promise.all([adminApi.auditEventTypes(), usersApi.list()]);
        setTypes([...t].sort());
        setUsers([...u].sort((a, b) => a.username.localeCompare(b.username)));
      } catch {
        // Filters are a convenience; the list itself reports errors.
      }
    })();
  }, []);

  const query = useCallback(
    (until?: string) =>
      adminApi.audit({
        eventType: eventType || undefined,
        userId: userId || undefined,
        since: sinceDate ? new Date(`${sinceDate}T00:00:00`).toISOString() : undefined,
        until,
        limit: PAGE,
      }),
    [eventType, userId, sinceDate],
  );

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await query();
      setEntries(list);
      setMore(list.length >= PAGE);
    } catch (e) {
      setError(errorText(e, 'Could not load the audit log.'));
    } finally {
      setBusy(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadOlder = async () => {
    if (!entries || entries.length === 0) return;
    setBusy(true);
    try {
      const oldest = entries[entries.length - 1].timestamp;
      const older = await query(oldest);
      const seen = new Set(entries.map((e) => e.id));
      const fresh = older.filter((e) => !seen.has(e.id));
      setEntries([...entries, ...fresh]);
      setMore(older.length >= PAGE && fresh.length > 0);
    } catch (e) {
      setError(errorText(e, 'Could not load older entries.'));
    } finally {
      setBusy(false);
    }
  };

  const shown = useMemo(() => {
    if (!entries) return null;
    const needle = text.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((e) =>
      [e.eventType, e.username ?? '', e.ipAddress ?? '', e.details ?? ''].some((v) => v.toLowerCase().includes(needle)),
    );
  }, [entries, text]);

  return (
    <>
      <div className="nc-admin-filters">
        <select value={eventType} onChange={(e) => setEventType(e.target.value)} aria-label="Event type">
          <option value="">All events</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="User">
          <option value="">All users</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </select>
        <label className="nc-admin-filter-label">
          From
          <input type="date" value={sinceDate} onChange={(e) => setSinceDate(e.target.value)} />
        </label>
        <input
          className="nc-admin-filter-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search in loaded entries…"
        />
        <button type="button" className="nc-btn" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>

      {error && <div className="nc-form-error">{error}</div>}
      {shown === null && !error && <p className="nc-empty">Loading…</p>}
      {shown !== null && shown.length === 0 && <p className="nc-empty">No entries.</p>}

      {shown !== null && shown.length > 0 && (
        <table className="nc-admin-table nc-admin-table-compact nc-admin-log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Event</th>
              <th>User</th>
              <th>IP</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id}>
                <td className="nc-admin-nowrap">{formatDateTime(e.timestamp)}</td>
                <td>
                  <span className={`nc-admin-event ${eventClass(e.eventType, e.details)}`}>{e.eventType}</span>
                </td>
                <td>{e.username ?? '—'}</td>
                <td className="nc-admin-nowrap">{e.ipAddress ?? '—'}</td>
                <td className="nc-admin-details">{formatDetails(e.details)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {more && !text && (
        <div className="nc-admin-form-actions nc-admin-more">
          <button type="button" className="nc-btn" onClick={() => void loadOlder()} disabled={busy}>
            {busy ? 'Loading…' : 'Load older'}
          </button>
        </div>
      )}
    </>
  );
}

function eventClass(type: string, details: string | null): string {
  if (type.includes('failure') || type.includes('locked_out')) return 'nc-admin-event-bad';
  if (details && /"success"\s*:\s*false/.test(details)) return 'nc-admin-event-bad';
  if (type.includes('deleted') || type.includes('restart') || type.includes('restored')) return 'nc-admin-event-warn';
  return '';
}

/** Compact one-line "key: value · key: value" view of the details JSON. */
function formatDetails(details: string | null): string {
  if (!details) return '';
  try {
    const obj = JSON.parse(details) as Record<string, unknown>;
    if (obj === null || typeof obj !== 'object') return details;
    return Object.entries(obj)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' · ');
  } catch {
    return details;
  }
}

// ------------------------------------------------------------------ Server log

const LEVEL_RANK: Record<string, number> = {
  Verbose: 0,
  Debug: 1,
  Information: 2,
  Warning: 3,
  Error: 4,
  Fatal: 5,
};

interface ParsedLine extends ServerLogLineDto {
  source: string | null;
  text: string;
}

/**
 * Serilog's output template appends the event's properties as JSON
 * ({"SourceContext":"NoteControl.Server.X", ...}). Split that off and
 * keep the class name as a short "source".
 */
function parseLine(l: ServerLogLineDto): ParsedLine {
  const m = /\s(\{.*\})\s*$/s.exec(l.message);
  if (m) {
    try {
      const props = JSON.parse(m[1]) as Record<string, unknown>;
      const ctx = typeof props.SourceContext === 'string' ? props.SourceContext : null;
      return { ...l, source: ctx ? ctx.split('.').pop() ?? ctx : null, text: l.message.slice(0, m.index) };
    } catch {
      // Not JSON after all — show the whole message.
    }
  }
  return { ...l, source: null, text: l.message };
}

function ServerLogView() {
  const [tail, setTail] = useState<ServerLogTailDto | null>(null);
  const [count, setCount] = useState(500);
  const [minLevel, setMinLevel] = useState('Information');
  const [text, setText] = useState('');
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      setTail(await adminApi.logTail(count));
      setError(null);
    } catch (e) {
      setError(errorText(e, 'Could not read the server log.'));
    }
  }, [count]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [auto, load]);

  const lines = useMemo(() => {
    if (!tail) return [];
    const rank = LEVEL_RANK[minLevel] ?? 0;
    const needle = text.trim().toLowerCase();
    // API is newest-first; show oldest at top like a terminal.
    return [...tail.lines]
      .reverse()
      .map(parseLine)
      .filter((l) => (LEVEL_RANK[l.level] ?? 2) >= rank)
      .filter((l) => !needle || l.message.toLowerCase().includes(needle));
  }, [tail, minLevel, text]);

  // Keep the newest line in view after each refresh.
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines]);

  return (
    <>
      <div className="nc-admin-filters">
        <select value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="Lines">
          {[200, 500, 1000, 2000].map((n) => (
            <option key={n} value={n}>
              Last {n} lines
            </option>
          ))}
        </select>
        <select value={minLevel} onChange={(e) => setMinLevel(e.target.value)} aria-label="Minimum level">
          {Object.keys(LEVEL_RANK).map((l) => (
            <option key={l} value={l}>
              {l} and up
            </option>
          ))}
        </select>
        <input
          className="nc-admin-filter-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Filter…"
        />
        <label className="nc-admin-filter-label">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Auto-refresh
        </label>
        <button type="button" className="nc-btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {error && <div className="nc-form-error">{error}</div>}
      {tail?.note && <p className="nc-empty">{tail.note}</p>}

      <div className="nc-admin-logbox" ref={boxRef}>
        {lines.length === 0 && tail && !tail.note && <div className="nc-empty">No lines match.</div>}
        {lines.map((l, i) => (
          <div key={`${l.timestamp}-${i}`} className={`nc-admin-logline nc-admin-log-${l.level.toLowerCase()}`}>
            <span className="nc-admin-log-time">{l.timestamp.slice(11, 19)}</span>
            <span className="nc-admin-log-level">{l.level.slice(0, 3).toUpperCase()}</span>
            {l.source && <span className="nc-admin-log-source">{l.source}</span>}
            <span className="nc-admin-log-text">{l.text}</span>
          </div>
        ))}
      </div>
      {tail?.logFilePath && (
        <p className="nc-admin-subtle">
          <code>{tail.logFilePath}</code> · older days are in the same folder; the full service log is in{' '}
          <code>journalctl -u notecontrol</code>.
        </p>
      )}
    </>
  );
}
