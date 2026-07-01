import { useState, type FormEvent } from "react";

import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import { authErrorMessage, useLogin } from "../lib/auth";

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
    <div className="mx-auto max-w-sm">
      <h1 className="mb-3 border-b border-line pb-1 text-base font-bold">Log in</h1>

      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block font-bold">Username</span>
          <input
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="block w-full rounded border border-line p-1.5 text-[12px] outline-none focus:border-link"
          />
        </label>

        <label className="block">
          <span className="mb-1 block font-bold">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="block w-full rounded border border-line p-1.5 text-[12px] outline-none focus:border-link"
          />
        </label>

        {login.isError ? (
          <p role="alert" className="text-[12px] text-tag-artist">
            {authErrorMessage(login.error, "Couldn’t log in. Please try again.")}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={login.isPending}
          className="flex items-center justify-center gap-1 rounded bg-link px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {login.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Log in
        </button>
      </form>

      <p className="mt-4 text-[12px] text-muted">
        No account?{" "}
        <Link to="/signup" className="text-link hover:underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
