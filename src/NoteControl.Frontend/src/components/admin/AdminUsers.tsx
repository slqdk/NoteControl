import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { usersApi, type UpdateUserBody } from '../../api/client';
import type { UserDto } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { SessionList } from './SessionList';
import { errorText, formatDateTime, generatePassword } from './adminUtil';

type Role = UserDto['role'];
type Status = UserDto['status'];

/** Which inline panel is open under a user row. */
type Panel = { userId: string; kind: 'edit' | 'password' | 'sessions' } | null;

/**
 * Admin → Users tab. Mirrors the old tray Users window:
 * list, add, edit (email / role / status), reset password,
 * per-user sessions, delete.
 */
export function AdminUsers() {
  const { state } = useAuth();
  const meId = state.status === 'authenticated' ? state.user.id : null;

  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await usersApi.list();
      list.sort((a, b) => a.username.localeCompare(b.username));
      setUsers(list);
    } catch (e) {
      setError(errorText(e, 'Could not load users.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replaceUser = (u: UserDto) =>
    setUsers((prev) => (prev ? prev.map((x) => (x.id === u.id ? u : x)) : prev));

  const togglePanel = (userId: string, kind: NonNullable<Panel>['kind']) =>
    setPanel((p) => (p && p.userId === userId && p.kind === kind ? null : { userId, kind }));

  const remove = async (u: UserDto) => {
    if (!window.confirm(`Delete user "${u.username}"? Their sessions end immediately. This can't be undone.`)) return;
    setError(null);
    setNotice(null);
    try {
      await usersApi.remove(u.id);
      setUsers((prev) => (prev ? prev.filter((x) => x.id !== u.id) : prev));
      setNotice(`Deleted ${u.username}.`);
    } catch (e) {
      setError(errorText(e, 'Could not delete the user.'));
    }
  };

  return (
    <section className="nc-admin-section">
      <div className="nc-admin-section-head">
        <h2>Users</h2>
        <button type="button" className="nc-btn nc-btn-primary" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? 'Cancel' : 'Add user'}
        </button>
      </div>

      {error && <div className="nc-form-error">{error}</div>}
      {notice && <div className="nc-admin-notice">{notice}</div>}

      {showAdd && (
        <AddUserForm
          onCreated={(u) => {
            setUsers((prev) => (prev ? [...prev, u].sort((a, b) => a.username.localeCompare(b.username)) : [u]));
            setShowAdd(false);
            setNotice(`Created ${u.username}.`);
          }}
        />
      )}

      {users === null && !error && <p className="nc-empty">Loading…</p>}

      {users !== null && (
        <table className="nc-admin-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last login</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const open = panel?.userId === u.id ? panel.kind : null;
              return (
                <UserRows
                  key={u.id}
                  user={u}
                  isMe={u.id === meId}
                  open={open}
                  onToggle={(kind) => togglePanel(u.id, kind)}
                  onUpdated={(nu) => {
                    replaceUser(nu);
                    setPanel(null);
                    setNotice(`Saved ${nu.username}.`);
                  }}
                  onPasswordReset={() => {
                    setPanel(null);
                    setNotice(
                      u.id === meId
                        ? 'Password changed. All your sessions were ended — sign in again.'
                        : `Password for ${u.username} reset; their sessions were ended.`,
                    );
                  }}
                  onDelete={() => void remove(u)}
                />
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function UserRows({
  user,
  isMe,
  open,
  onToggle,
  onUpdated,
  onPasswordReset,
  onDelete,
}: {
  user: UserDto;
  isMe: boolean;
  open: NonNullable<Panel>['kind'] | null;
  onToggle: (kind: NonNullable<Panel>['kind']) => void;
  onUpdated: (u: UserDto) => void;
  onPasswordReset: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <tr className={open ? 'nc-admin-row-open' : undefined}>
        <td>
          <strong>{user.username}</strong>
          {isMe && <span className="nc-admin-badge nc-admin-badge-after">you</span>}
        </td>
        <td>{user.email}</td>
        <td>
          <span className={user.role === 'admin' ? 'nc-admin-badge nc-admin-badge-accent' : 'nc-admin-badge'}>
            {user.role}
          </span>
        </td>
        <td>
          <span className={`nc-admin-status nc-admin-status-${user.status}`}>{user.status}</span>
        </td>
        <td>{formatDateTime(user.lastLoginAt)}</td>
        <td className="nc-admin-actions">
          <button type="button" className={`nc-btn${open === 'edit' ? ' nc-admin-btn-on' : ''}`} onClick={() => onToggle('edit')}>
            Edit
          </button>
          <button type="button" className={`nc-btn${open === 'password' ? ' nc-admin-btn-on' : ''}`} onClick={() => onToggle('password')}>
            Password
          </button>
          <button type="button" className={`nc-btn${open === 'sessions' ? ' nc-admin-btn-on' : ''}`} onClick={() => onToggle('sessions')}>
            Sessions
          </button>
          <button
            type="button"
            className="nc-btn nc-btn-danger"
            onClick={onDelete}
            disabled={isMe}
            title={isMe ? "You can't delete your own account here" : undefined}
          >
            Delete
          </button>
        </td>
      </tr>
      {open && (
        <tr className="nc-admin-panel-row">
          <td colSpan={6}>
            {open === 'edit' && <EditUserForm user={user} isMe={isMe} onSaved={onUpdated} />}
            {open === 'password' && <ResetPasswordForm user={user} isMe={isMe} onDone={onPasswordReset} />}
            {open === 'sessions' && <SessionList userId={user.id} />}
          </td>
        </tr>
      )}
    </>
  );
}

function AddUserForm({ onCreated }: { onCreated: (u: UserDto) => void }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await usersApi.create({ username: username.trim(), email: email.trim(), password, role });
      onCreated(u);
    } catch (err) {
      setError(errorText(err, 'Could not create the user.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="nc-admin-form" onSubmit={(e) => void submit(e)}>
      <div className="nc-admin-form-grid">
        <label className="nc-field">
          <span className="nc-field-label">Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus autoComplete="off" />
        </label>
        <label className="nc-field">
          <span className="nc-field-label">Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
        </label>
        <label className="nc-field">
          <span className="nc-field-label">Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <PasswordField
          label="Initial password"
          value={password}
          onChange={setPassword}
          show={showPw}
          onShowChange={setShowPw}
        />
      </div>
      {error && <div className="nc-form-error">{error}</div>}
      <div className="nc-admin-form-actions">
        <button type="submit" className="nc-btn nc-btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create user'}
        </button>
        <span className="nc-fg-muted">The user can change it under Account after signing in.</span>
      </div>
    </form>
  );
}

function EditUserForm({ user, isMe, onSaved }: { user: UserDto; isMe: boolean; onSaved: (u: UserDto) => void }) {
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<Role>(user.role);
  const [status, setStatus] = useState<Status>(user.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: UpdateUserBody = {};
    if (email.trim() !== user.email) body.email = email.trim();
    if (role !== user.role) body.role = role;
    if (status !== user.status) body.status = status;
    if (Object.keys(body).length === 0) {
      onSaved(user);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(await usersApi.update(user.id, body));
    } catch (err) {
      setError(errorText(err, 'Could not save.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="nc-admin-form" onSubmit={(e) => void submit(e)}>
      <div className="nc-admin-form-grid">
        <label className="nc-field">
          <span className="nc-field-label">Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="nc-field">
          <span className="nc-field-label">Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label className="nc-field">
          <span className="nc-field-label">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            <option value="active">active</option>
            <option value="locked">locked</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
      </div>
      {isMe && (role !== user.role || status !== user.status) && (
        <p className="nc-admin-warning">You are changing your own account — you may lose admin access.</p>
      )}
      {error && <div className="nc-form-error">{error}</div>}
      <div className="nc-admin-form-actions">
        <button type="submit" className="nc-btn nc-btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function ResetPasswordForm({ user, isMe, onDone }: { user: UserDto; isMe: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await usersApi.resetPassword(user.id, password);
      onDone();
    } catch (err) {
      setError(errorText(err, 'Could not reset the password.'));
      setBusy(false);
    }
  };

  return (
    <form className="nc-admin-form" onSubmit={(e) => void submit(e)}>
      <div className="nc-admin-form-grid">
        <PasswordField label={`New password for ${user.username}`} value={password} onChange={setPassword} show={show} onShowChange={setShow} />
      </div>
      <p className="nc-fg-muted">
        {isMe
          ? 'This ends all of your sessions, including this one. Use Account → Change password to keep this session.'
          : 'All of this user’s sessions are ended.'}
      </p>
      {error && <div className="nc-form-error">{error}</div>}
      <div className="nc-admin-form-actions">
        <button type="submit" className="nc-btn nc-btn-primary" disabled={busy || password.length === 0}>
          {busy ? 'Saving…' : 'Set password'}
        </button>
      </div>
    </form>
  );
}

/** Password input with Show and Generate buttons. */
export function PasswordField({
  label,
  value,
  onChange,
  show,
  onShowChange,
  autoComplete = 'new-password',
  allowGenerate = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onShowChange: (v: boolean) => void;
  autoComplete?: string;
  allowGenerate?: boolean;
}) {
  return (
    <label className="nc-field nc-admin-password-field">
      <span className="nc-field-label">{label}</span>
      <span className="nc-admin-password-row">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          autoComplete={autoComplete}
          spellCheck={false}
        />
        <button type="button" className="nc-btn" onClick={() => onShowChange(!show)}>
          {show ? 'Hide' : 'Show'}
        </button>
        {allowGenerate && (
          <button
            type="button"
            className="nc-btn"
            onClick={() => {
              onChange(generatePassword());
              onShowChange(true);
            }}
          >
            Generate
          </button>
        )}
      </span>
    </label>
  );
}
