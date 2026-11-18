import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { usersApi, vaultsApi } from '../../api/client';
import type { UserDto, VaultDto, VaultMemberDto } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { errorText, formatDateTime } from './adminUtil';

/**
 * listAll() also returns vaults the admin has no permission row on,
 * with myRole "none". VaultDto.myRole is typed without it (every
 * other caller only ever sees owner/editor/viewer), so widen here.
 */
type AdminVault = Omit<VaultDto, 'myRole'> & { myRole: VaultDto['myRole'] | 'none' };

/**
 * Admin → Vaults tab. Lists every vault on the server, creates
 * vaults (personal for any user, or shared), manages members and
 * deletes vaults.
 *
 * Server rules this UI follows (see docs/vaults.md):
 *   - A server admin has no implicit access to vaults. Members and
 *     Delete are owner-only, so they're only offered where the admin
 *     is the vault's owner. Other vaults show their owner instead.
 *   - Creating on behalf of another user is admin-only; that user
 *     becomes the owner (and the admin gets no role on it).
 */
export function AdminVaults() {
  const { state } = useAuth();
  const me = state.status === 'authenticated' ? state.user : null;

  const [vaults, setVaults] = useState<AdminVault[] | null>(null);
  const [users, setUsers] = useState<UserDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openMembers, setOpenMembers] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try {
      const [v, u] = await Promise.all([vaultsApi.listAll(), usersApi.list()]);
      v.sort((a, b) => a.path.localeCompare(b.path));
      u.sort((a, b) => a.username.localeCompare(b.username));
      setVaults(v as AdminVault[]);
      setUsers(u);
    } catch (e) {
      setError(errorText(e, 'Could not load vaults.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (v: AdminVault) => {
    const typed = window.prompt(
      `Delete vault "${v.name}" and ALL of its notes, assets and history on disk?\n` +
        `There is no undo except a backup.\n\nType the vault name to confirm:`,
    );
    if (typed === null) return;
    if (typed !== v.name) {
      setError('The name did not match — nothing was deleted.');
      return;
    }
    setError(null);
    setNotice(null);
    try {
      await vaultsApi.remove(v.id);
      setVaults((prev) => (prev ? prev.filter((x) => x.id !== v.id) : prev));
      setNotice(`Deleted vault ${v.name}.`);
    } catch (e) {
      setError(errorText(e, 'Could not delete the vault.'));
    }
  };

  return (
    <section className="nc-admin-section">
      <div className="nc-admin-section-head">
        <h2>Vaults</h2>
        <button type="button" className="nc-btn nc-btn-primary" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Cancel' : 'Create vault'}
        </button>
      </div>

      {error && <div className="nc-form-error">{error}</div>}
      {notice && <div className="nc-admin-notice">{notice}</div>}

      {showCreate && me && (
        <CreateVaultForm
          me={me}
          users={users.filter((u) => u.status === 'active')}
          onCreated={(v, ownerName) => {
            setShowCreate(false);
            setNotice(
              v.ownerId === me.id
                ? `Created ${v.name}.`
                : `Created ${v.name} for ${ownerName}. You have no role on it — ${ownerName} can share it with you.`,
            );
            void load();
          }}
        />
      )}

      {vaults === null && !error && <p className="nc-empty">Loading…</p>}

      {vaults !== null && vaults.length === 0 && <p className="nc-empty">No vaults yet.</p>}

      {vaults !== null && vaults.length > 0 && (
        <table className="nc-admin-table">
          <thead>
            <tr>
              <th>Vault</th>
              <th>Scope</th>
              <th>Owner</th>
              <th>Your role</th>
              <th>Created</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {vaults.map((v) => {
              const isOwner = v.myRole === 'owner';
              const open = openMembers === v.id;
              return (
                <VaultRows
                  key={v.id}
                  vault={v}
                  isOwner={isOwner}
                  open={open}
                  users={users}
                  onToggleMembers={() => setOpenMembers(open ? null : v.id)}
                  onDelete={() => void remove(v)}
                />
              );
            })}
          </tbody>
        </table>
      )}
      <p className="nc-fg-muted nc-admin-footnote">
        Admins don&apos;t get access to other users&apos; vaults automatically. Members and Delete are
        available on vaults you own; the owner of any other vault can share it with you.
      </p>
    </section>
  );
}

function VaultRows({
  vault,
  isOwner,
  open,
  users,
  onToggleMembers,
  onDelete,
}: {
  vault: AdminVault;
  isOwner: boolean;
  open: boolean;
  users: UserDto[];
  onToggleMembers: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <tr className={open ? 'nc-admin-row-open' : undefined}>
        <td>
          {vault.myRole !== 'none' ? (
            <Link to={`/vaults/${vault.id}`}>
              <strong>{vault.name}</strong>
            </Link>
          ) : (
            <strong>{vault.name}</strong>
          )}
          <div className="nc-admin-subtle">{vault.path}</div>
        </td>
        <td>{vault.scope}</td>
        <td>{vault.ownerUsername}</td>
        <td>
          <span className={vault.myRole === 'none' ? 'nc-admin-badge nc-admin-badge-muted' : 'nc-admin-badge'}>
            {vault.myRole === 'none' ? 'no access' : vault.myRole}
          </span>
        </td>
        <td>{formatDateTime(vault.createdAt)}</td>
        <td className="nc-admin-actions">
          {isOwner && (
            <>
              <button type="button" className={`nc-btn${open ? ' nc-admin-btn-on' : ''}`} onClick={onToggleMembers}>
                Members
              </button>
              <button type="button" className="nc-btn nc-btn-danger" onClick={onDelete}>
                Delete
              </button>
            </>
          )}
        </td>
      </tr>
      {open && (
        <tr className="nc-admin-panel-row">
          <td colSpan={6}>
            <MembersPanel vault={vault} users={users} />
          </td>
        </tr>
      )}
    </>
  );
}

function CreateVaultForm({
  me,
  users,
  onCreated,
}: {
  me: UserDto;
  users: UserDto[];
  onCreated: (v: VaultDto, ownerName: string) => void;
}) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'personal' | 'shared'>('personal');
  const [ownerId, setOwnerId] = useState(me.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const owner = users.find((u) => u.id === ownerId) ?? me;
  const trimmed = name.trim();
  const nameProblem =
    trimmed.length === 0 ? null
    : /[/\\]/.test(trimmed) ? 'The name cannot contain / or \\.'
    : trimmed === '.' || trimmed === '..' ? 'Not a valid name.'
    : null;
  const path = scope === 'personal' ? `users/${owner.username}/${trimmed}` : `shared/${trimmed}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (nameProblem || trimmed.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const v = await vaultsApi.create({
        path,
        name: trimmed,
        ownerUserId: owner.id === me.id ? undefined : owner.id,
      });
      onCreated(v, owner.username);
    } catch (err) {
      setError(errorText(err, 'Could not create the vault.'));
      setBusy(false);
    }
  };

  return (
    <form className="nc-admin-form" onSubmit={(e) => void submit(e)}>
      <div className="nc-admin-form-grid">
        <label className="nc-field">
          <span className="nc-field-label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label className="nc-field">
          <span className="nc-field-label">Scope</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as 'personal' | 'shared')}>
            <option value="personal">personal</option>
            <option value="shared">shared</option>
          </select>
        </label>
        <label className="nc-field">
          <span className="nc-field-label">Owner</span>
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}
                {u.id === me.id ? ' (you)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="nc-fg-muted">
        Folder: <code>{trimmed ? path : scope === 'personal' ? `users/${owner.username}/…` : 'shared/…'}</code>
      </p>
      {nameProblem && <div className="nc-form-error">{nameProblem}</div>}
      {error && <div className="nc-form-error">{error}</div>}
      <div className="nc-admin-form-actions">
        <button type="submit" className="nc-btn nc-btn-primary" disabled={busy || !!nameProblem || trimmed.length === 0}>
          {busy ? 'Creating…' : 'Create vault'}
        </button>
      </div>
    </form>
  );
}

function MembersPanel({ vault, users }: { vault: AdminVault; users: UserDto[] }) {
  const [members, setMembers] = useState<VaultMemberDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addUser, setAddUser] = useState('');
  const [addRole, setAddRole] = useState<'editor' | 'viewer'>('editor');

  const load = useCallback(async () => {
    try {
      const list = await vaultsApi.listMembers(vault.id);
      const order = { owner: 0, editor: 1, viewer: 2 } as const;
      list.sort((a, b) => order[a.role] - order[b.role] || a.username.localeCompare(b.username));
      setMembers(list);
    } catch (e) {
      setError(errorText(e, 'Could not load members.'));
    }
  }, [vault.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const candidates = useMemo(() => {
    const taken = new Set((members ?? []).map((m) => m.userId));
    return users.filter((u) => !taken.has(u.id) && u.status === 'active');
  }, [members, users]);

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(errorText(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!addUser) return;
    void run(async () => {
      await vaultsApi.share(vault.id, addUser, addRole);
      setAddUser('');
    }, 'Could not add the member.');
  };

  if (members === null) {
    return error ? <div className="nc-form-error">{error}</div> : <p className="nc-empty">Loading members…</p>;
  }

  return (
    <div className="nc-admin-members">
      {error && <div className="nc-form-error">{error}</div>}
      <table className="nc-admin-table nc-admin-table-compact">
        <thead>
          <tr>
            <th>Member</th>
            <th>Role</th>
            <th>Since</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId}>
              <td>{m.username}</td>
              <td>
                {m.role === 'owner' ? (
                  <span className="nc-admin-badge nc-admin-badge-accent">owner</span>
                ) : (
                  <select
                    value={m.role}
                    disabled={busy}
                    onChange={(e) =>
                      void run(
                        () => vaultsApi.share(vault.id, m.username, e.target.value as 'editor' | 'viewer'),
                        'Could not change the role.',
                      )
                    }
                  >
                    <option value="editor">editor</option>
                    <option value="viewer">viewer</option>
                  </select>
                )}
              </td>
              <td>{formatDateTime(m.grantedAt)}</td>
              <td className="nc-admin-actions">
                {m.role !== 'owner' && (
                  <button
                    type="button"
                    className="nc-btn nc-btn-danger"
                    disabled={busy}
                    onClick={() => void run(() => vaultsApi.unshare(vault.id, m.userId), 'Could not remove the member.')}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form className="nc-admin-inline-form" onSubmit={add}>
        <select value={addUser} onChange={(e) => setAddUser(e.target.value)} disabled={busy || candidates.length === 0}>
          <option value="">{candidates.length === 0 ? 'Everyone is already a member' : 'Add user…'}</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.username}>
              {u.username}
            </option>
          ))}
        </select>
        <select value={addRole} onChange={(e) => setAddRole(e.target.value as 'editor' | 'viewer')} disabled={busy}>
          <option value="editor">editor</option>
          <option value="viewer">viewer</option>
        </select>
        <button type="submit" className="nc-btn nc-btn-primary" disabled={busy || !addUser}>
          Add
        </button>
      </form>
    </div>
  );
}
