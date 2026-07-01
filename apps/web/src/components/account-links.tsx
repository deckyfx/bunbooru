import { Link } from "@tanstack/react-router";

import { useCurrentUser, useLogout } from "../lib/auth";

/**
 * Account controls, reflecting live auth state from `GET /auth/me`:
 * - logged out → Login / Sign up links
 * - logged in  → username (→ Account page), Logout, plus an Admin link for admins
 *
 * Shared by the header (non-home pages) and the home-page corner strip so both
 * stay in sync. Renders nothing until the first `/auth/me` resolves, to avoid
 * flashing "Login" at an already-authenticated user. Text size/colour is left to
 * the caller via `className`.
 */
export function AccountLinks({ className }: { className?: string }) {
  const { data: user, isPending } = useCurrentUser();
  const logout = useLogout();

  if (isPending) return null;

  return (
    <div className={`flex items-center gap-3 ${className ?? ""}`}>
      {user ? (
        <>
          {user.role === "admin" ? (
            <Link to="/admin" className="hover:underline">
              Admin
            </Link>
          ) : null}
          <Link to="/account" className="hover:underline">
            {user.username}
          </Link>
          <button
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="hover:underline disabled:cursor-not-allowed disabled:opacity-60"
          >
            Logout
          </button>
        </>
      ) : (
        <>
          <Link to="/login" className="hover:underline">
            Login
          </Link>
          <Link to="/signup" className="hover:underline">
            Sign up
          </Link>
        </>
      )}
    </div>
  );
}
