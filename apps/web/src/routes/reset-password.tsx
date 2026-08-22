import { useState, type FormEvent } from "react";

import { Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";

import { PasswordInput } from "../components/password-input";
import { authErrorMessage, useResetPassword } from "../lib/auth";
import { useSensitiveToken } from "../lib/sensitive-token";

/** Client-side minimum, mirroring the API's `password` schema (>= 8 chars). */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Choose a new password from an emailed reset link. The token arrives as a
 * `?token=` query parameter; {@link useSensitiveToken} captures it, strips it from
 * the URL, and installs a no-referrer policy so it can't leak. On success all the
 * user's sessions are revoked server-side, so we send them to the login page.
 */
export function ResetPasswordPage() {
  const navigate = useNavigate();
  const token = useSensitiveToken();
  const reset = useResetPassword();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (reset.isPending || !token) return;
    if (password.length < MIN_PASSWORD_LENGTH || password !== confirm) return;
    reset.mutate({ token, password });
  }

  if (!token) {
    return (
      <div className="mx-auto mt-6 max-w-sm">
        <div className="rounded-xl border border-line bg-surface p-6 shadow-sm text-[12px] text-muted">
          <h1 className="mb-1 text-lg font-bold text-ink">Invalid reset link</h1>
          <p>
            This link is missing its token. Request a new one on the{" "}
            <Link to="/forgot-password" className="text-link hover:underline">
              reset page
            </Link>
            .
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-6 max-w-sm">
      <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-link/10 text-link">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-bold leading-tight">Choose a new password</h1>
            <p className="text-[12px] text-muted">This signs you out everywhere else</p>
          </div>
        </div>

        {reset.isSuccess ? (
          <div className="space-y-3">
            <p className="flex items-center gap-1.5 rounded-md border border-tag-character/30 bg-tag-character/10 px-3 py-2 text-[12px] text-ink">
              <CheckCircle2 className="h-4 w-4 text-tag-character" aria-hidden="true" />
              Your password has been changed.
            </p>
            <button
              type="button"
              onClick={() => void navigate({ to: "/login" })}
              className="flex w-full items-center justify-center rounded-md bg-link px-4 py-2.5 text-sm font-medium text-white hover:bg-link-hover"
            >
              Go to log in
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold">New password</span>
              <PasswordInput
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
              />
              <span className={`mt-1 block text-[11px] ${tooShort ? "text-tag-artist" : "text-muted"}`}>
                At least {MIN_PASSWORD_LENGTH} characters.
              </span>
            </label>

            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold">Confirm new password</span>
              <PasswordInput
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
                required
              />
              {mismatch ? (
                <span className="mt-1 block text-[11px] text-tag-artist">Passwords don’t match.</span>
              ) : null}
            </label>

            {reset.isError ? (
              <p
                role="alert"
                className="rounded-md border border-tag-artist/30 bg-tag-artist/10 px-3 py-2 text-[12px] text-tag-artist"
              >
                {authErrorMessage(reset.error, "This reset link is invalid or has expired.")}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={reset.isPending || tooShort || mismatch || !password || !confirm}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-link px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-link-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {reset.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Set new password
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
