import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from './api';

export interface User {
  id: number;
  username: string;
}

export interface AuthContextValue {
  user: User | null;
  /** True until the initial `/auth/me` bootstrap has settled. */
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Bootstrap: the session lives in an httpOnly cookie, so the only way to know
  // whether we are signed in is to ask the server.
  useEffect(() => {
    let cancelled = false;
    api<User>('/auth/me')
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setUser(
      await api<User>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    );
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    // Register auto-logs-in server side (it sets the same session cookie).
    setUser(
      await api<User>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    );
  }, []);

  const logout = useCallback(async () => {
    try {
      await api<void>('/auth/logout', { method: 'POST' });
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, register, logout }),
    [user, loading, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Gate for authenticated routes: sends signed-out visitors to `/login`. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user === null) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
