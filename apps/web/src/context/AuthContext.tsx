'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthResponse, LoginInput, PublicUser, SignupInput } from '@safelock/shared';
import { api, registerUnauthorizedHandler } from '@/lib/api';
import { ApiError } from '@/lib/apiError';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  user: PublicUser | null;
  status: AuthStatus;
  login: (input: LoginInput) => Promise<PublicUser>;
  signup: (input: SignupInput) => Promise<PublicUser>;
  logout: () => Promise<void>;
  /**
   * Re-reads `GET /auth/me`. Needed after anything that changes server-side
   * state the UI branches on — notably `hasPaid` once a payment is verified.
   */
  refreshUser: () => Promise<PublicUser | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Holds the signed-in user for the whole app.
 *
 * The session itself lives in httpOnly cookies set by the API — this provider
 * never reads, writes or stores a token, and never keeps a password. On mount
 * it asks `GET /auth/me` who the current user is.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  /**
   * The API client calls this when a request 401s and the session could not be
   * refreshed. Dropping the cached user is what makes the route guards send
   * the visitor to /login — the client cannot inspect the httpOnly cookie, so
   * this is how it learns the session ended.
   */
  useEffect(() => {
    registerUnauthorizedHandler(() => {
      setUser(null);
      setStatus('unauthenticated');
    });
    return () => registerUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const { user: me } = await api.get<AuthResponse>('/auth/me', {
          signal: controller.signal,
        });
        setUser(me);
        setStatus('authenticated');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        // A 401 here is the normal "not signed in" case.
        setUser(null);
        setStatus('unauthenticated');
      }
    })();

    return () => controller.abort();
  }, []);

  const login = useCallback(async (input: LoginInput) => {
    const { user: me } = await api.post<AuthResponse>('/auth/login', {
      identifier: input.identifier,
      password: input.password,
    });
    setUser(me);
    setStatus('authenticated');
    return me;
  }, []);

  const signup = useCallback(async (input: SignupInput) => {
    // confirmPassword and acceptedTerms stay client-side; the API gets only
    // what it needs to create the account.
    const { user: me } = await api.post<AuthResponse>('/auth/signup', {
      name: input.name,
      email: input.email,
      phone: input.phone,
      password: input.password,
    });
    setUser(me);
    setStatus('authenticated');
    return me;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post<null>('/auth/logout');
    } catch (error) {
      // Clearing the client state matters more than the response; a failed
      // logout call still drops the user locally.
      if (!(error instanceof ApiError)) throw error;
    } finally {
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const { user: me } = await api.get<AuthResponse>('/auth/me');
      setUser(me);
      setStatus('authenticated');
      return me;
    } catch (error) {
      // A 401 means the session ended; anything else leaves the cached user
      // alone rather than signing someone out over a flaky network.
      if (error instanceof ApiError && error.status === 401) {
        setUser(null);
        setStatus('unauthenticated');
      }
      return null;
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, login, signup, logout, refreshUser }),
    [user, status, login, signup, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return context;
}
