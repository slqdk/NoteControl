import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

import { useAuth } from './AuthContext';

/**
 * Wrap protected routes in <RequireAuth>. Behaviour:
 *   - "loading": render a tiny placeholder (the bootstrap usually
 *     completes in tens of milliseconds, so this rarely flashes).
 *   - "anonymous": redirect to /login, remembering where they came
 *     from in location state so the login page can send them back.
 *   - "authenticated": render the protected children.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();

  if (state.status === 'loading') {
    return <div style={{ padding: 24, color: '#64748b' }}>Loading…</div>;
  }

  if (state.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
