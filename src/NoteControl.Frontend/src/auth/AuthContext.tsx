import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiError, authApi, setCsrfToken, setUnauthorizedHandler } from '../api/client';
import { showToast } from '../utils/toast';
import type { UserDto } from '../api/types';

type AuthState =
  | { status: 'loading'; retrying?: boolean }
  | { status: 'anonymous' }
  | { status: 'authenticated'; user: UserDto };

interface AuthContextValue {
  state: AuthState;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let cancelled = false;
    // Only a 401 means "not signed in". A 5xx / network failure (the
    // server restarting during an upgrade, Caddy's 502 meanwhile, a
    // Wi-Fi blip) used to drop straight to the login form even with a
    // valid session — and signing in again there started a brand-new
    // session. Now we keep showing "loading" and retry with backoff
    // until the server answers.
    (async () => {
      for (let attempt = 0; !cancelled; attempt++) {
        try {
          const me = await authApi.me();
          if (cancelled) return;
          setCsrfToken(me.csrfToken);
          setState({ status: 'authenticated', user: me.user });
          return;
        } catch (e) {
          if (cancelled) return;
          if (e instanceof ApiError && e.status === 401) {
            setState({ status: 'anonymous' });
            return;
          }
          // eslint-disable-next-line no-console
          console.warn('Auth bootstrap failed, retrying', e);
          setState({ status: 'loading', retrying: true });
          const delay = Math.min(10_000, 1_000 * 2 ** attempt);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Session expired / revoked mid-use. Remember where the user
      // was so signing in brings them straight back (the note editor
      // keeps any unsaved text as a local draft and offers it back on
      // that reopen — see editor/noteDrafts.ts). Not `replace`, so
      // browser Back still leads to the page they were on.
      const wasSignedIn = stateRef.current.status === 'authenticated';
      setState({ status: 'anonymous' });
      if (window.location.pathname === '/login') return;
      if (wasSignedIn) {
        showToast('Your session has ended. Sign in again to continue.', 6000);
      }
      navigate('/login', {
        state: {
          from: { pathname: window.location.pathname, search: window.location.search },
        },
      });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  const login = useCallback(async (username: string, password: string) => {
    const me = await authApi.login(username, password);
    setCsrfToken(me.csrfToken);
    setState({ status: 'authenticated', user: me.user });
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // Even if the server call fails, locally clear state.
    }
    setCsrfToken(null);
    setState({ status: 'anonymous' });
    navigate('/login', { replace: true });
  }, [navigate]);

  const value = useMemo<AuthContextValue>(
    () => ({ state, login, logout }),
    [state, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
