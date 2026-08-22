import { useState, type FormEvent } from "react";

import { Link } from "@tanstack/react-router";
import { KeyRound, Loader2, MailCheck } from "lucide-react";

import { authErrorMessage, useForgotPassword } from "../lib/auth";
import { TEXT_INPUT } from "../lib/input-styles";

/**
 * Request a password-reset email. The response is deliberately generic — it never
 * reveals whether the address maps to an account (no enumeration) — so the
 * success state is shown for any submission the server accepts.
 */
export function ForgotPasswordPage() {
  const forgot = useForgotPassword();
  const [email, setEmail] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (forgot.isPending) return;
    const trimmed = email.trim();
    if (!trimmed) return;
    forgot.mutate(trimmed);
  }

  return (
    <div className="mx-auto mt-6 max-w-sm">
      <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-link/10 text-link">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-bold leading-tight">Reset your password</h1>
            <p className="text-[12px] text-muted">We’ll email you a reset link</p>
          </div>
        </div>

        {forgot.isSuccess ? (
          <div className="rounded-md border border-tag-character/30 bg-tag-character/10 px-3 py-4 text-[12px] text-ink">
            <p className="flex items-center gap-1.5 font-semibold">
              <MailCheck className="h-4 w-4 text-tag-character" aria-hidden="true" />
              Check your inbox
            </p>
            <p className="mt-1 text-muted">
              If an account exists for that address, a reset link is on its way. The link expires
              shortly, so use it soon.
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold">Email</span>
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={TEXT_INPUT}
              />
            </label>

            {forgot.isError ? (
              <p
                role="alert"
                className="rounded-md border border-tag-artist/30 bg-tag-artist/10 px-3 py-2 text-[12px] text-tag-artist"
              >
                {authErrorMessage(forgot.error, "Couldn’t send the reset email. Please try again.")}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={forgot.isPending}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-link px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-link-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {forgot.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              Send reset link
            </button>
          </form>
        )}
      </div>

      <p className="mt-4 text-center text-[12px] text-muted">
        Remembered it?{" "}
        <Link to="/login" className="font-medium text-link hover:underline">
          Back to log in
        </Link>
      </p>
    </div>
  );
}
