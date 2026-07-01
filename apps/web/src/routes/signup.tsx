import { useState, type FormEvent } from "react";

import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import { authErrorMessage, useRegister } from "../lib/auth";

/** Client-side minimum, mirroring the API's `password` schema (>= 8 chars). */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Registration form. Open self-serve signup: the first account created becomes
 * the site admin, the rest are members. Registration auto-logs-in (the server
 * sets the session cookie), so on success we prime the cache and navigate home.
 * Email is optional.
 */
export function SignupPage() {
  const navigate = useNavigate();
  const register = useRegister();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (register.isPending) return;
    const trimmedEmail = email.trim();
    register.mutate(
      {
        username: username.trim(),
        password,
        // Omit email entirely when blank so the server stores NULL, not "".
        ...(trimmedEmail ? { email: trimmedEmail } : {}),
      },
      { onSuccess: () => void navigate({ to: "/" }) },
    );
  }

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-3 border-b border-line pb-1 text-base font-bold">Sign up</h1>

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
          <span className="mb-1 block font-bold">
            Email <span className="font-normal text-muted">(optional)</span>
          </span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="block w-full rounded border border-line p-1.5 text-[12px] outline-none focus:border-link"
          />
        </label>

        <label className="block">
          <span className="mb-1 block font-bold">Password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="block w-full rounded border border-line p-1.5 text-[12px] outline-none focus:border-link"
          />
          <span className="mt-1 block text-[11px] text-muted">
            At least {MIN_PASSWORD_LENGTH} characters.
          </span>
        </label>

        {register.isError ? (
          <p role="alert" className="text-[12px] text-tag-artist">
            {authErrorMessage(register.error, "Couldn’t sign up. Please try again.")}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={register.isPending}
          className="flex items-center justify-center gap-1 rounded bg-link px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {register.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          Sign up
        </button>
      </form>

      <p className="mt-4 text-[12px] text-muted">
        Already have an account?{" "}
        <Link to="/login" className="text-link hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
