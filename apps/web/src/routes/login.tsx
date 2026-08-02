import { useState, type FormEvent } from "react";

import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2, LogIn } from "lucide-react";

import { PasswordInput } from "../components/password-input";
import { authErrorMessage, useLogin } from "../lib/auth";

/** Shared field styling for the auth forms. */
const TEXT_INPUT =
  "block w-full rounded-md border border-line bg-bg py-2 px-2.5 text-sm outline-none transition-colors focus:border-link focus:ring-1 focus:ring-link/30";

/**
 * Sign-in form. On success the login mutation primes the current-user cache
 * (so the header flips immediately) and we navigate home. Auth is carried by the
 * httpOnly session cookie the server sets — nothing is stored in JS here.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const login = useLogin();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (login.isPending) return;
    login.mutate(
      { username: username.trim(), password },
      { onSuccess: () => void navigate({ to: "/" }) },
    );
  }

  return (
    <div className="mx-auto mt-6 max-w-sm">
      <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-link/10 text-link">
            <LogIn className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-bold leading-tight">Welcome back</h1>
            <p className="text-[12px] text-muted">Log in to your account</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold">Username</span>
            <input
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={TEXT_INPUT}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold">Password</span>
            <PasswordInput
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              required
            />
          </label>

          {login.isError ? (
            <p
              role="alert"
              className="rounded-md border border-tag-artist/30 bg-tag-artist/10 px-3 py-2 text-[12px] text-tag-artist"
            >
              {authErrorMessage(login.error, "Couldn’t log in. Please try again.")}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={login.isPending}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-link px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-link-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {login.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Log in
          </button>
        </form>
      </div>

      <p className="mt-4 text-center text-[12px] text-muted">
        No account?{" "}
        <Link to="/signup" className="font-medium text-link hover:underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
