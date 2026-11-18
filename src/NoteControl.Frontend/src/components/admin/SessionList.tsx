import { useCallback, useEffect, useState } from 'react';

import { sessionsApi } from '../../api/client';
import type { SessionDto } from '../../api/types';
import { describeUserAgent, errorText, formatDateTime } from './adminUtil';

/**
 * Active sessions for one user, with a Revoke button per row.
 * Used by the Account page (own sessions) and the admin Users tab
 * (any user's sessions). The current session is marked and can't be
 * revoked from here — Sign out does that.
 */
export function SessionList({ userId }: { userId: string }) {
  const [sessions, setSessions] = useState<SessionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await sessionsApi.listForUser(userId);
      list.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      setSessions(list);
    } catch (e) {
      setError(errorText(e, 'Could not load sessions.'));
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (s: SessionDto) => {
    setBusyId(s.id);
    setError(null);
    try {
      await sessionsApi.revoke(s.id);
      setSessions((prev) => (prev ? prev.filter((x) => x.id !== s.id) : prev));
    } catch (e) {
      setError(errorText(e, 'Could not revoke the session.'));
    } finally {
      setBusyId(null);
    }
  };

  if (error && sessions === null) return <div className="nc-form-error">{error}</div>;
  if (sessions === null) return <p className="nc-empty">Loading sessions…</p>;

  return (
    <div className="nc-admin-sessions">
      {error && <div className="nc-form-error">{error}</div>}
      {sessions.length === 0 ? (
        <p className="nc-empty">No active sessions.</p>
      ) : (
        <table className="nc-admin-table nc-admin-table-compact">
          <thead>
            <tr>
              <th>Device</th>
              <th>IP</th>
              <th>Last active</th>
              <th>Signed in</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td title={s.userAgent ?? ''}>
                  {describeUserAgent(s.userAgent)}
                  {s.isCurrent && <span className="nc-admin-badge nc-admin-badge-accent nc-admin-badge-after">this session</span>}
                </td>
                <td>{s.ipAddress ?? '—'}</td>
                <td>{formatDateTime(s.lastActivityAt)}</td>
                <td>{formatDateTime(s.createdAt)}</td>
                <td className="nc-admin-actions">
                  {!s.isCurrent && (
                    <button
                      type="button"
                      className="nc-btn nc-btn-danger"
                      disabled={busyId === s.id}
                      onClick={() => void revoke(s)}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
