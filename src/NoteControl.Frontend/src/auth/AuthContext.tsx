import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiError, authApi, setCsrfToken, setUnauthorizedHandler } from '../api/client';
import type { UserDto } from '../api/types';

type AuthState =
  | { status: 'loading' }
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await authApi.me();
        if (cancelled) return;
        setCsrfToken(me.csrfToken);
        setState({ status: 'authenticated', user: me.user });
      } catch (e) {
        if (cancelled) return;
        if (!(e instanceof ApiError) || e.status !== 401) {
          // eslint-disable-next-line no-console
          console.warn('Auth bootstrap failed', e);
        }
        setState({ status: 'anonymous' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setState({ status: 'anonymous' });
      navigate('/login', { replace: true });
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
