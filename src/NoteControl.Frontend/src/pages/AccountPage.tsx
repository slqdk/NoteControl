import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { authApi, exportUrls, vaultsApi } from '../api/client';
import type { VaultDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { TopBar } from '../components/TopBar';
import { PasswordField } from '../components/admin/AdminUsers';
import { SessionList } from '../components/admin/SessionList';
import { errorText } from '../components/admin/adminUtil';
import '../components/admin/admin.css';

/**
 * /account — the signed-in user's own account: change password,
 * download the vaults they own, see / revoke their own sessions.
 * Available to every user.
 */
export function AccountPage() {
  const { state } = useAuth();
  // Bump to remount the session list after a password change (the
  // server revoked the other sessions).
  const [sessionsKey, setSessionsKey] = useState(0);

  if (state.status !== 'authenticated') return null;
  const user = state.user;

  return (
    <>
      <TopBar currentUserId={null} canEdit={true} />
      <main className="nc-page nc-admin-page">
        <div className="nc-admin-header">
          <h1 className="nc-page-title">Account</h1>
          <Link to="/vaults" className="nc-admin-back">
            ← Back to notes
          </Link>
        </div>

        <section className="nc-admin-section">
          <dl className="nc-admin-facts">
            <dt>Username</dt>
            <dd>{user.username}</dd>
            <dt>Email</dt>
            <dd>{user.email}</dd>
            <dt>Role</dt>
            <dd>
              {user.role}
              {user.role === 'admin' && (
                <>
                  {' · '}
                  <Link to="/admin">Administration</Link>
                </>
              )}
            </dd>
          </dl>
        </section>

        <section className="nc-admin-section">
          <div className="nc-admin-section-head">
            <h2>Change password</h2>
          </div>
          <ChangePasswordForm onChanged={() => setSessionsKey((k) => k + 1)} />
        </section>

        <OwnedVaultDownloads />

        <section className="nc-admin-section">
          <div className="nc-admin-section-head">
            <h2>Your sessions</h2>
          </div>
          <SessionList key={sessionsKey} userId={user.id} />
        </section>
      </main>
    </>
  );
}

function ChangePasswordForm({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await authApi.changeOwnPassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setShowNext(false);
      setDone(true);
      onChanged();
    } catch (err) {
      setError(errorText(err, 'Could not change the password.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="nc-admin-form nc-admin-form-narrow" onSubmit={(e) => void submit(e)}>
      <PasswordField
        label="Current password"
        value={current}
        onChange={setCurrent}
        show={showCurrent}
        onShowChange={setShowCurrent}
        autoComplete="current-password"
        allowGenerate={false}
      />
      <PasswordField label="New password" value={next} onChange={setNext} show={showNext} onShowChange={setShowNext} />
      <label className="nc-field">
        <span className="nc-field-label">Repeat new password</span>
        <input
          type={showNext ? 'text' : 'password'}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          autoComplete="new-password"
          spellCheck={false}
        />
      </label>
      {mismatch && <div className="nc-form-error">The new passwords do not match.</div>}
      {error && <div className="nc-form-error">{error}</div>}
      {done && <div className="nc-admin-notice">Password changed. Your other sessions were signed out.</div>}
      <div className="nc-admin-form-actions">
        <button type="submit" className="nc-btn nc-btn-primary" disabled={busy || mismatch}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </div>
    </form>
  );
}

/** Zip download per vault the user owns (owner-only on the server). */
function OwnedVaultDownloads() {
  const [vaults, setVaults] = useState<VaultDto[] | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await vaultsApi.list();
        setVaults(list.filter((v) => v.myRole === 'owner').sort((a, b) => a.name.localeCompare(b.name)));
      } catch {
        setVaults([]);
      }
    })();
  }, []);

  if (vaults === null || vaults.length === 0) return null;

  return (
    <section className="nc-admin-section">
      <div className="nc-admin-section-head">
        <h2>Download your vaults</h2>
      </div>
      <p className="nc-admin-text">
        A zip of the vault folder: notes, assets, templates, dashboards and release history.
      </p>
      <ul className="nc-admin-download-list">
        {vaults.map((v) => (
          <li key={v.id}>
            <span>{v.name}</span>
            <a className="nc-btn nc-admin-linkbtn" href={exportUrls.vault(v.id)} download>
              Download
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
