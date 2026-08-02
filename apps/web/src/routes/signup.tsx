import { useState, type FormEvent } from "react";

import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2, UserPlus } from "lucide-react";

import { PasswordInput } from "../components/password-input";
import { authErrorMessage, useRegister } from "../lib/auth";
import { TEXT_INPUT } from "../lib/input-styles";

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

  const passwordTooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

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
    <div className="mx-auto mt-6 max-w-sm">
      <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-link/10 text-link">
            <UserPlus className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-bold leading-tight">Create your account</h1>
            <p className="text-[12px] text-muted">Join the board</p>
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
            <span className="mb-1 block text-[12px] font-semibold">
              Email <span className="font-normal text-muted">(optional)</span>
            </span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={TEXT_INPUT}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold">Password</span>
            <PasswordInput
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
            />
            <span
              className={`mt-1 block text-[11px] ${passwordTooShort ? "text-tag-artist" : "text-muted"}`}
            >
              At least {MIN_PASSWORD_LENGTH} characters.
            </span>
          </label>

          {register.isError ? (
            <p
              role="alert"
              className="rounded-md border border-tag-artist/30 bg-tag-artist/10 px-3 py-2 text-[12px] text-tag-artist"
            >
              {authErrorMessage(register.error, "Couldn’t sign up. Please try again.")}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={register.isPending}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-link px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-link-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {register.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Sign up
          </button>
        </form>
      </div>

      <p className="mt-4 text-center text-[12px] text-muted">
        Already have an account?{" "}
        <Link to="/login" className="font-medium text-link hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
