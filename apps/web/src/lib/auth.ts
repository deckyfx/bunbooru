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
    // Short freshness window + refetch on focus so an auth change made elsewhere
    // (logout in another tab, session expiry) is picked up promptly — the login
    // gates are then re-evaluated rather than lingering on stale "logged in".
    staleTime: 15_000,
    refetchOnWindowFocus: true,
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

/**
 * Public auth capabilities the UI gates on — currently `mailConfigured`, which
 * decides whether the "forgot password?" link and email-verification affordances
 * are shown (self-serve reset only works with a mail provider installed).
 */
export function useAuthConfig() {
  return useQuery({
    queryKey: ["auth-config"] as const,
    // Server config rarely changes at runtime — cache generously.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ mailConfigured: boolean }> =>
      unwrap(await api.api.v1.auth.config.get()),
  });
}

/** Request a password-reset email. Always resolves the same way (no enumeration). */
export function useForgotPassword() {
  return useMutation({
    mutationFn: async (email: string) =>
      unwrap(await api.api.v1.auth["forgot-password"].post({ email })),
  });
}

/** Redeem a reset token with a new password (204 — check `error`, not `unwrap`). */
export function useResetPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { token: string; password: string }) => {
      const res = await api.api.v1.auth["reset-password"].post(input);
      if (res.error) throw res.error;
    },
    // A reset revokes every session server-side; drop the cached current-user so a
    // logged-in tab that redeemed a link stops rendering a stale signed-in state.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CURRENT_USER_KEY }),
  });
}

/**
 * Change the logged-in user's password. The server re-issues the session cookie,
 * so the browser stays logged in; we refresh the cached user for good measure.
 */
export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { current: string; next: string }) => {
      const res = await api.api.v1.auth["change-password"].post(input);
      if (res.error) throw res.error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CURRENT_USER_KEY }),
  });
}

/**
 * Change the logged-in user's email (requires the current password). The new
 * address lands unverified; refresh the cached user so the account page reflects
 * the new address + its (re)verification state.
 */
export function useChangeEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { current: string; email: string }) => {
      const res = await api.api.v1.auth["change-email"].post(input);
      if (res.error) throw res.error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CURRENT_USER_KEY }),
  });
}

/** Ask the server to email a verification link for the account's address. */
export function useRequestEmailVerification() {
  return useMutation({
    mutationFn: async () => {
      const res = await api.api.v1.auth["verify-email"].request.post();
      if (res.error) throw res.error;
    },
  });
}

/** Confirm an email-verification token, then refresh the cached user (verified state). */
export function useConfirmEmailVerification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (token: string) => {
      const res = await api.api.v1.auth["verify-email"].confirm.post({ token });
      if (res.error) throw res.error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CURRENT_USER_KEY }),
  });
}
