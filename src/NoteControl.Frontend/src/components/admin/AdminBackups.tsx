import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { adminApi, exportUrls, vaultsApi } from '../../api/client';
import type { BackupConfigDto, BackupListItemDto, BackupStatusDto, ServerConfigDto, VaultDto } from '../../api/types';
import { errorText, formatBytes, formatDateTime } from './adminUtil';

const DEFAULT_TARGET = '/var/backups/notecontrol';

/**
 * Admin → Backups tab.
 *
 *   1. Export: download the whole instance as one zip (importable with
 *      deploy/linux/import.sh) — the "take it with you" copy.
 *   2. Schedule: daily backup to a folder on the server, with
 *      retention. Plain folder copies of the DataRoot (docs/storage.md).
 *   3. Status + "Back up now".
 *   4. Existing backups: restore one vault from a backup, or delete.
 */
export function AdminBackups() {
  const [status, setStatus] = useState<BackupStatusDto | null>(null);
  const [backups, setBackups] = useState<BackupListItemDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [restoreFor, setRestoreFor] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([adminApi.backupStatus(), adminApi.listBackups()]);
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setStatus(s);
      setBackups(list);
    } catch (e) {
      setError(errorText(e, 'Could not load backups.'));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runNow = async () => {
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const r = await adminApi.runBackup();
      if (r.success) {
        setNotice(
          `Backup ${r.backupId} done: ${formatBytes(r.bytesCopied)} in ${(r.durationMs / 1000).toFixed(1)} s.` +
            (r.error ? ` Warning: ${r.error}` : ''),
        );
      } else {
        setError(r.error ?? 'The backup failed.');
      }
    } catch (e) {
      setError(errorText(e, 'The backup failed.'));
    } finally {
      setRunning(false);
      void reload();
    }
  };

  const remove = async (b: BackupListItemDto) => {
    if (!window.confirm(`Delete backup ${b.id} (${formatBytes(b.sizeBytes)})? This can't be undone.`)) return;
    setError(null);
    setNotice(null);
    try {
      await adminApi.deleteBackup(b.id);
      setNotice(`Deleted backup ${b.id}.`);
      void reload();
    } catch (e) {
      setError(errorText(e, 'Could not delete the backup.'));
    }
  };

  return (
    <>
      <section className="nc-admin-section">
        <div className="nc-admin-section-head">
          <h2>Export</h2>
          <a className="nc-btn nc-btn-primary nc-admin-linkbtn" href={exportUrls.full()} download>
            Download full export
          </a>
        </div>
        <p className="nc-admin-text">
          One zip with everything: users and passwords, vaults and permissions, notes, assets,
          templates, dashboards and release history. Keep it somewhere other than this server. It
          can be restored into a new container with{' '}
          <code>bash deploy/linux/import.sh &lt;zip&gt; --force</code>. Single vaults can be
          downloaded from the Vaults tab or the Account page.
        </p>
      </section>

      <BackupSettings onSaved={() => void reload()} />

      <section className="nc-admin-section">
        <div className="nc-admin-section-head">
          <h2>Backups on the server</h2>
          <button
            type="button"
            className="nc-btn nc-btn-primary"
            onClick={() => void runNow()}
            disabled={running || status?.running === true || !status?.currentTargetPath}
            title={!status?.currentTargetPath ? 'Set a target folder first' : undefined}
          >
            {running || status?.running ? 'Backing up…' : 'Back up now'}
          </button>
        </div>

        {error && <div className="nc-form-error">{error}</div>}
        {notice && <div className="nc-admin-notice">{notice}</div>}

        {status && (
          <dl className="nc-admin-facts nc-admin-facts-small">
            <dt>Target</dt>
            <dd>{status.currentTargetPath ? <code>{status.currentTargetPath}</code> : <em>not set</em>}</dd>
            <dt>Last run</dt>
            <dd>
              {status.lastRunAt ? (
                <>
                  {formatDateTime(status.lastRunAt)}{' '}
                  {status.lastRunSuccess ? (
                    <span className="nc-admin-status nc-admin-status-active">ok</span>
                  ) : (
                    <span className="nc-admin-status nc-admin-status-disabled">failed</span>
                  )}
                  {status.lastRunError && <div className="nc-admin-subtle">{status.lastRunError}</div>}
                </>
              ) : (
                <em>not since the server started</em>
              )}
            </dd>
            <dt>Stored</dt>
            <dd>
              {status.backupCount} backup{status.backupCount === 1 ? '' : 's'}, {formatBytes(status.totalBytes)}
            </dd>
          </dl>
        )}

        {backups !== null && backups.length > 0 && (
          <table className="nc-admin-table">
            <thead>
              <tr>
                <th>Backup</th>
                <th>Size</th>
                <th>Vaults</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => {
                const open = restoreFor === b.id;
                return (
                  <BackupRows
                    key={b.id}
                    backup={b}
                    open={open}
                    onToggleRestore={() => setRestoreFor(open ? null : b.id)}
                    onDelete={() => void remove(b)}
                    onRestored={(msg) => {
                      setRestoreFor(null);
                      setNotice(msg);
                    }}
                  />
                );
              })}
            </tbody>
          </table>
        )}
        {backups !== null && backups.length === 0 && status?.currentTargetPath && (
          <p className="nc-empty">No backups in the target folder yet.</p>
        )}
      </section>
    </>
  );
}

function BackupRows({
  backup,
  open,
  onToggleRestore,
  onDelete,
  onRestored,
}: {
  backup: BackupListItemDto;
  open: boolean;
  onToggleRestore: () => void;
  onDelete: () => void;
  onRestored: (message: string) => void;
}) {
  return (
    <>
      <tr className={open ? 'nc-admin-row-open' : undefined}>
        <td>
          <strong>{formatDateTime(backup.createdAt)}</strong>
          <div className="nc-admin-subtle">{backup.id}</div>
        </td>
        <td>{formatBytes(backup.sizeBytes)}</td>
        <td title={backup.vaultFolders.join('\n')}>{backup.vaultFolders.length}</td>
        <td className="nc-admin-actions">
          <button
            type="button"
            className={`nc-btn${open ? ' nc-admin-btn-on' : ''}`}
            onClick={onToggleRestore}
            disabled={backup.vaultFolders.length === 0}
          >
            Restore vault…
          </button>
          <button type="button" className="nc-btn nc-btn-danger" onClick={onDelete}>
            Delete
          </button>
        </td>
      </tr>
      {open && (
        <tr className="nc-admin-panel-row">
          <td colSpan={4}>
            <RestorePanel backup={backup} onRestored={onRestored} />
          </td>
        </tr>
      )}
    </>
  );
}

function RestorePanel({ backup, onRestored }: { backup: BackupListItemDto; onRestored: (m: string) => void }) {
  const [vaults, setVaults] = useState<VaultDto[] | null>(null);
  const [folder, setFolder] = useState(backup.vaultFolders[0] ?? '');
  const [vaultId, setVaultId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await vaultsApi.listAll();
        list.sort((a, b) => a.path.localeCompare(b.path));
        setVaults(list);
      } catch (e) {
        setError(errorText(e, 'Could not load vaults.'));
      }
    })();
  }, []);

  // Default the target to the live vault with the same folder.
  useEffect(() => {
    if (!vaults) return;
    const match = vaults.find((v) => v.path.toLowerCase() === folder.toLowerCase());
    setVaultId(match?.id ?? '');
  }, [folder, vaults]);

  const target = vaults?.find((v) => v.id === vaultId) ?? null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    if (
      !window.confirm(
        `Replace the current contents of vault "${target.name}" with "${folder}" from ${formatDateTime(backup.createdAt)}?\n\n` +
          `The current folder is kept on the server as "${target.name}.pre-restore-<time>".`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const r = await adminApi.restoreVault(backup.id, target.id, folder);
      if (r.success) {
        onRestored(
          `Restored ${target.name} from ${backup.id}. The previous contents are in ${r.preRestoreFolderPath ?? 'a .pre-restore folder'}; the search index is being rebuilt.`,
        );
      } else {
        setError(r.error ?? 'The restore failed.');
        setBusy(false);
      }
    } catch (err) {
      setError(errorText(err, 'The restore failed.'));
      setBusy(false);
    }
  };

  return (
    <form className="nc-admin-form" onSubmit={(e) => void submit(e)}>
      <div className="nc-admin-form-grid">
        <label className="nc-field">
          <span className="nc-field-label">Vault in the backup</span>
          <select value={folder} onChange={(e) => setFolder(e.target.value)}>
            {backup.vaultFolders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="nc-field">
          <span className="nc-field-label">Restore into</span>
          <select value={vaultId} onChange={(e) => setVaultId(e.target.value)} disabled={!vaults}>
            <option value="">{vaults ? 'Choose a vault…' : 'Loading…'}</option>
            {(vaults ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.path})
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="nc-fg-muted">
        Restores into an existing vault. To bring back a deleted vault, create an empty vault with
        the same name first, then restore into it.
      </p>
      {error && <div className="nc-form-error">{error}</div>}
      <div className="nc-admin-form-actions">
        <button type="submit" className="nc-btn nc-btn-primary" disabled={busy || !target || !folder}>
          {busy ? 'Restoring…' : 'Restore'}
        </button>
      </div>
    </form>
  );
}

function BackupSettings({ onSaved }: { onSaved: () => void }) {
  const [config, setConfig] = useState<ServerConfigDto | null>(null);
  const [form, setForm] = useState<BackupConfigDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const c = await adminApi.getConfig();
        setConfig(c);
        setForm(c.backup);
      } catch (e) {
        setError(errorText(e, 'Could not load the backup settings.'));
      }
    })();
  }, []);

  if (!form || !config) {
    return (
      <section className="nc-admin-section">
        <div className="nc-admin-section-head">
          <h2>Schedule</h2>
        </div>
        {error ? <div className="nc-form-error">{error}</div> : <p className="nc-empty">Loading…</p>}
      </section>
    );
  }

  const set = <K extends keyof BackupConfigDto>(k: K, v: BackupConfigDto[K]) => {
    setSaved(false);
    setForm((f) => (f ? { ...f, [k]: v } : f));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await adminApi.updateConfig({
        ...config,
        backup: { ...form, targetPath: form.targetPath.trim() },
      });
      setConfig(updated);
      setForm(updated.backup);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errorText(err, 'Could not save.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="nc-admin-section">
      <div className="nc-admin-section-head">
        <h2>Schedule</h2>
      </div>
      <form className="nc-admin-form" onSubmit={(e) => void submit(e)}>
        <label className="nc-admin-check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Back up every day
        </label>
        <div className="nc-admin-form-grid">
          <label className="nc-field nc-admin-span-2">
            <span className="nc-field-label">Target folder (on the server)</span>
            <input
              value={form.targetPath}
              onChange={(e) => set('targetPath', e.target.value)}
              placeholder={DEFAULT_TARGET}
              spellCheck={false}
            />
          </label>
          <label className="nc-field">
            <span className="nc-field-label">Time of day</span>
            <input type="time" value={form.dailyTime} onChange={(e) => set('dailyTime', e.target.value)} required />
          </label>
          <label className="nc-field">
            <span className="nc-field-label">Keep daily</span>
            <input
              type="number"
              min={1}
              max={365}
              value={form.retainDailyCount}
              onChange={(e) => set('retainDailyCount', Number(e.target.value))}
            />
          </label>
          <label className="nc-field">
            <span className="nc-field-label">Keep weekly</span>
            <input
              type="number"
              min={0}
              max={52}
              value={form.retainWeeklyCount}
              onChange={(e) => set('retainWeeklyCount', Number(e.target.value))}
            />
          </label>
        </div>
        <p className="nc-fg-muted">
          {form.targetPath.trim() === '' ? (
            <>
              <button type="button" className="nc-button-link" onClick={() => set('targetPath', DEFAULT_TARGET)}>
                Use {DEFAULT_TARGET}
              </button>{' '}
              (created by install.sh). Better still: a folder
            </>
          ) : (
            <>Tip: a folder</>
          )}{' '}
          on another disk or NAS, bind-mounted into the container and owned by the{' '}
          <code>notecontrol</code> user, survives losing the container. Old backups are pruned only
          after a successful run.
        </p>
        {error && <div className="nc-form-error">{error}</div>}
        {saved && <div className="nc-admin-notice">Saved.</div>}
        <div className="nc-admin-form-actions">
          <button type="submit" className="nc-btn nc-btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  );
}
