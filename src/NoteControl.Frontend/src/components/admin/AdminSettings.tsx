import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { adminApi } from '../../api/client';
import type { ServerConfigDto, ServerInfoDto } from '../../api/types';
import { errorText, formatDateTime } from './adminUtil';

const LOG_LEVELS = ['Verbose', 'Debug', 'Information', 'Warning', 'Error', 'Fatal'] as const;

type Form = Pick<ServerConfigDto, 'auth' | 'logging'> & {
  network: Pick<ServerConfigDto['network'], 'exposeOnLan' | 'port' | 'publicUrl'>;
};

/**
 * Admin → Settings tab: network, authentication and logging (backup
 * settings live on the Backups tab), plus server facts and Restart.
 *
 * Save merges into a freshly fetched config, so a backup change made
 * in another tab in the meantime isn't overwritten.
 *
 * What applies when:
 *   - Authentication + log level: immediately.
 *   - Port, LAN exposure, log retention: at the next server start —
 *     the page offers Restart after such a change.
 */
export function AdminSettings() {
  const [config, setConfig] = useState<ServerConfigDto | null>(null);
  const [info, setInfo] = useState<ServerInfoDto | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, i] = await Promise.all([adminApi.getConfig(), adminApi.serverInfo()]);
      setConfig(c);
      setInfo(i);
      setForm({
        network: { exposeOnLan: c.network.exposeOnLan, port: c.network.port, publicUrl: c.network.publicUrl },
        auth: { ...c.auth },
        logging: { ...c.logging },
      });
    } catch (e) {
      setError(errorText(e, 'Could not load the settings.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!form || !config) {
    return error ? <div className="nc-form-error">{error}</div> : <p className="nc-empty">Loading…</p>;
  }

  const setNet = <K extends keyof Form['network']>(k: K, v: Form['network'][K]) =>
    setForm((f) => (f ? { ...f, network: { ...f.network, [k]: v } } : f));
  const setAuth = <K extends keyof Form['auth']>(k: K, v: Form['auth'][K]) =>
    setForm((f) => (f ? { ...f, auth: { ...f.auth, [k]: v } } : f));
  const setLog = <K extends keyof Form['logging']>(k: K, v: Form['logging'][K]) =>
    setForm((f) => (f ? { ...f, logging: { ...f.logging, [k]: v } } : f));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const fresh = await adminApi.getConfig();
      const needsRestart =
        form.network.port !== fresh.network.port ||
        form.network.exposeOnLan !== fresh.network.exposeOnLan ||
        form.logging.retainDays !== fresh.logging.retainDays;
      const saved = await adminApi.updateConfig({
        ...fresh,
        network: { ...fresh.network, ...form.network, publicUrl: form.network.publicUrl.trim() },
        auth: form.auth,
        logging: form.logging,
      });
      setConfig(saved);
      if (needsRestart) setRestartNeeded(true);
      setNotice(needsRestart ? 'Saved. Some changes apply after a restart.' : 'Saved.');
    } catch (err) {
      setError(errorText(err, 'Could not save.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ServerCard info={info} restartNeeded={restartNeeded} />

      <form onSubmit={(e) => void submit(e)}>
        <section className="nc-admin-section">
          <div className="nc-admin-section-head">
            <h2>Network</h2>
          </div>
          <label className="nc-admin-check">
            <input
              type="checkbox"
              checked={form.network.exposeOnLan}
              onChange={(e) => setNet('exposeOnLan', e.target.checked)}
            />
            Listen on all interfaces (needed when Nginx Proxy Manager runs on another host)
          </label>
          <div className="nc-admin-form-grid">
            <Field label="Port" hint="restart">
              <input
                type="number"
                min={1024}
                max={65535}
                value={form.network.port}
                onChange={(e) => setNet('port', Number(e.target.value))}
              />
            </Field>
            <Field label="Public URL" hint="used in email links" wide>
              <input
                value={form.network.publicUrl}
                onChange={(e) => setNet('publicUrl', e.target.value)}
                placeholder="https://notes.example.dk"
                spellCheck={false}
              />
            </Field>
          </div>
          <dl className="nc-admin-facts nc-admin-facts-small">
            <dt>Listening on</dt>
            <dd>
              <code>{config.network.bindUrl}</code>
            </dd>
            {config.network.lanUrls.length > 0 && (
              <>
                <dt>LAN addresses</dt>
                <dd>
                  {config.network.lanUrls.map((u) => (
                    <code key={u} className="nc-admin-code-item">
                      {u}
                    </code>
                  ))}
                </dd>
              </>
            )}
            <dt>Trusted proxies</dt>
            <dd>
              {info && info.trustedProxies.length > 0 ? (
                info.trustedProxies.map((p) => (
                  <code key={p} className="nc-admin-code-item">
                    {p}
                  </code>
                ))
              ) : (
                <span className="nc-admin-warning-inline">none (only loopback)</span>
              )}
              <div className="nc-admin-subtle">
                Set <code>Network__TrustedProxies__0=&lt;NPM IP&gt;</code> in{' '}
                <code>/etc/notecontrol/notecontrol.env</code> and restart. Without it every visitor
                shares the proxy&apos;s IP for login throttling and the audit log.
              </div>
            </dd>
          </dl>
        </section>

        <section className="nc-admin-section">
          <div className="nc-admin-section-head">
            <h2>Authentication</h2>
          </div>
          <div className="nc-admin-form-grid">
            <Field label="Idle timeout (minutes)">
              <NumberInput value={form.auth.idleTimeoutMinutes} onChange={(v) => setAuth('idleTimeoutMinutes', v)} min={1} />
            </Field>
            <Field label="Absolute session length (minutes)">
              <NumberInput
                value={form.auth.absoluteTimeoutMinutes}
                onChange={(v) => setAuth('absoluteTimeoutMinutes', v)}
                min={1}
              />
            </Field>
            <Field label="Minimum password length">
              <NumberInput
                value={form.auth.minimumPasswordLength}
                onChange={(v) => setAuth('minimumPasswordLength', v)}
                min={8}
              />
            </Field>
            <Field label="Login attempts per IP / minute">
              <NumberInput
                value={form.auth.loginAttemptsPerIpPerMinute}
                onChange={(v) => setAuth('loginAttemptsPerIpPerMinute', v)}
                min={1}
              />
            </Field>
            <Field label="Login attempts per account / hour">
              <NumberInput
                value={form.auth.loginAttemptsPerAccountPerHour}
                onChange={(v) => setAuth('loginAttemptsPerAccountPerHour', v)}
                min={1}
              />
            </Field>
            <Field label="Account lockout (minutes)">
              <NumberInput
                value={form.auth.accountLockoutMinutes}
                onChange={(v) => setAuth('accountLockoutMinutes', v)}
                min={1}
              />
            </Field>
          </div>
          <label className="nc-admin-check">
            <input
              type="checkbox"
              checked={form.auth.checkPasswordAgainstHibp}
              onChange={(e) => setAuth('checkPasswordAgainstHibp', e.target.checked)}
            />
            Reject passwords found in known data breaches (Have I Been Pwned, k-anonymity lookup)
          </label>
        </section>

        <section className="nc-admin-section">
          <div className="nc-admin-section-head">
            <h2>Logging</h2>
          </div>
          <div className="nc-admin-form-grid">
            <Field label="Minimum level" hint="applies now">
              <select value={form.logging.minimumLevel} onChange={(e) => setLog('minimumLevel', e.target.value)}>
                {LOG_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Keep log files (days)" hint="restart">
              <NumberInput value={form.logging.retainDays} onChange={(v) => setLog('retainDays', v)} min={1} max={365} />
            </Field>
          </div>
          <dl className="nc-admin-facts nc-admin-facts-small">
            <dt>Data folder</dt>
            <dd>
              <code>{config.storage.dataRoot}</code>
            </dd>
            <dt>Settings file</dt>
            <dd>
              <code>{config.storage.configFilePath}</code>
            </dd>
          </dl>
        </section>

        {error && <div className="nc-form-error">{error}</div>}
        {notice && <div className="nc-admin-notice">{notice}</div>}
        <div className="nc-admin-form-actions nc-admin-savebar">
          <button type="submit" className="nc-btn nc-btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
          <span className="nc-fg-muted">Backup settings are on the Backups &amp; export tab.</span>
        </div>
      </form>
    </>
  );
}

function ServerCard({ info, restartNeeded }: { info: ServerInfoDto | null; restartNeeded: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'restarting' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  const restart = async () => {
    if (!info) return;
    if (!window.confirm('Restart the server now? It is unreachable for a few seconds — let open editors finish saving first.'))
      return;
    setError(null);
    setPhase('restarting');
    try {
      await adminApi.restartServer();
    } catch (e) {
      setPhase('failed');
      setError(errorText(e, 'Could not restart.'));
      return;
    }
    // Wait for the process to go away and come back with a new start time.
    const deadline = Date.now() + 90_000;
    await new Promise((r) => setTimeout(r, 2500));
    while (Date.now() < deadline) {
      try {
        const next = await adminApi.serverInfo();
        if (next.startedAt !== info.startedAt) {
          window.location.reload();
          return;
        }
      } catch {
        // Down or 502 from the proxy while restarting — keep polling.
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    setPhase('failed');
    setError('The server did not come back within 90 seconds. Check: journalctl -u notecontrol -n 50');
  };

  return (
    <section className="nc-admin-section">
      <div className="nc-admin-section-head">
        <h2>Server</h2>
        {info?.canRestart && (
          <button
            type="button"
            className={`nc-btn${restartNeeded ? ' nc-btn-primary' : ''}`}
            onClick={() => void restart()}
            disabled={phase === 'restarting'}
          >
            {phase === 'restarting' ? 'Restarting…' : 'Restart server'}
          </button>
        )}
      </div>
      {restartNeeded && phase === 'idle' && (
        <div className="nc-admin-notice">Restart the server to apply the port / network / log retention change.</div>
      )}
      {error && <div className="nc-form-error">{error}</div>}
      {info ? (
        <dl className="nc-admin-facts nc-admin-facts-small">
          <dt>Version</dt>
          <dd>{info.build ?? info.version}</dd>
          <dt>Running since</dt>
          <dd>{formatDateTime(info.startedAt)}</dd>
          <dt>System</dt>
          <dd>
            {info.os} · {info.runtime} · host <code>{info.machineName}</code> · user <code>{info.processUser}</code>
          </dd>
          {!info.canRestart && (
            <>
              <dt>Restart</dt>
              <dd className="nc-admin-subtle">Only available when the server runs as the systemd service.</dd>
            </>
          )}
        </dl>
      ) : (
        <p className="nc-empty">Loading…</p>
      )}
    </section>
  );
}

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`nc-field${wide ? ' nc-admin-span-2' : ''}`}>
      <span className="nc-field-label">
        {label}
        {hint && <span className="nc-admin-hint"> · {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return <input type="number" value={value} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} />;
}
