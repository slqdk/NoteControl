import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';

import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

interface LocationState {
  from?: { pathname: string; search: string };
}

/**
 * Sign-in form.
 *
 * Behaviour:
 *   - if already authenticated, immediately redirect to /vaults
 *   - on submit, call AuthContext.login(); on success it updates state
 *     and we navigate to the previous location (or /vaults)
 *   - rate-limit / lockout / invalid-credentials all surface as inline
 *     errors via ApiError.problem.detail
 */
export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { state, login } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (state.status === 'authenticated') {
    return <Navigate to="/vaults" replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      const from = (location.state as LocationState | null)?.from;
      const target = from ? `${from.pathname}${from.search}` : '/vaults';
      navigate(target, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.problem?.detail || err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Sign-in failed.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="nc-login-shell">
      <form className="nc-login-card" onSubmit={onSubmit}>
        <h1 className="nc-login-title">NoteControl</h1>
        <p className="nc-login-subtitle">Sign in to continue</p>

        <label className="nc-field">
          <span className="nc-field-label">Username</span>
          <input
            type="text"
            autoComplete="username"
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label className="nc-field">
          <span className="nc-field-label">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
        </label>

        {error && <div className="nc-form-error">{error}</div>}

        <button type="submit" className="nc-button-primary" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
