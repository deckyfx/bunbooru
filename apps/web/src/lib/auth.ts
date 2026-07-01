/**
 * Auth state for the UI (Eden Treaty + TanStack Query). The session lives in an
 * httpOnly cookie the browser sends automatically, so JS can't read it — instead
 * `GET /auth/me` is the single source of truth for "am I logged in?". Login and
 * register mutations prime that cache so the header flips instantly; logout
 * clears it. The `token` those endpoints also return is for API/script clients
 * (Bearer) and is intentionally ignored here — the cookie carries web auth.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { UserDto } from "@bunbooru/api";

import { api, unwrap } from "./api";

export type { UserDto };

/** Query key for the current-user lookup, shared by the hooks below. */
const CURRENT_USER_KEY = ["current-user"] as const;

/** Credentials for {@link useLogin}. */
export interface LoginInput {
  username: string;
  password: string;
}

/** Registration fields for {@link useRegister} (email optional). */
export interface RegisterInput {
  username: string;
  password: string;
  email?: string;
}

/**
 * The authenticated user, or null when logged out. Cached briefly so navigating
 * doesn't refetch on every mount; the login/logout mutations update it directly.
 */
export function useCurrentUser() {
  return useQuery({
    queryKey: CURRENT_USER_KEY,
    staleTime: 60_000,
    // `/auth/me` returns `{ user: UserDto | null }` — always a JSON object, so
    // `unwrap` narrows cleanly and we read `.user`.
    queryFn: async (): Promise<UserDto | null> => unwrap(await api.api.v1.auth.me.get()).user,
  });
}

/** Whether a user is currently signed in (false while loading / logged out). */
export function useIsLoggedIn(): boolean {
  return useCurrentUser().data != null;
}

/** Log in, then prime the current-user cache so the UI reflects it immediately. */
export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LoginInput) => unwrap(await api.api.v1.auth.login.post(input)),
    onSuccess: (result) => queryClient.setQueryData(CURRENT_USER_KEY, result.user),
  });
}

/** Register (auto-logs-in) and prime the current-user cache. */
export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RegisterInput) => unwrap(await api.api.v1.auth.register.post(input)),
    onSuccess: (result) => queryClient.setQueryData(CURRENT_USER_KEY, result.user),
  });
}

/**
 * Pull a human-readable message out of a thrown Eden error (the API's
 * `{ error: { message } }` envelope lands on `err.value`), falling back to a
 * generic message for network/unknown failures.
 */
export function authErrorMessage(err: unknown, fallback: string): string {
  const value = err && typeof err === "object" ? (err as { value?: unknown }).value : undefined;
  const inner =
    value && typeof value === "object" ? (value as { error?: unknown }).error : undefined;
  const message =
    inner && typeof inner === "object" ? (inner as { message?: unknown }).message : undefined;
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

/** Log out, clear the cookie server-side, and reset the cached user to null. */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.api.v1.auth.logout.post();
      if (res.error) throw res.error;
    },
    onSuccess: () => queryClient.setQueryData(CURRENT_USER_KEY, null),
  });
}
