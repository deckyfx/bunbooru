import { useEffect, useRef } from "react";

import { Link } from "@tanstack/react-router";
import { CheckCircle2, Loader2, MailWarning } from "lucide-react";

import { authErrorMessage, useConfirmEmailVerification } from "../lib/auth";
import { useSensitiveToken } from "../lib/sensitive-token";

/**
 * Land from an email-verification link and confirm the token automatically. The
 * token arrives as `?token=`; {@link useSensitiveToken} captures it, strips it from
 * the URL, and installs a no-referrer policy. Confirmation runs once on mount.
 */
export function VerifyEmailPage() {
  const token = useSensitiveToken();
  const confirm = useConfirmEmailVerification();
  // Guard against React StrictMode's double-invoke firing the mutation twice.
  const fired = useRef(false);

  useEffect(() => {
    if (!token || fired.current) return;
    fired.current = true;
    confirm.mutate(token);
  }, [token, confirm]);

  return (
    <div className="mx-auto mt-6 max-w-sm">
      <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
        <h1 className="mb-3 text-lg font-bold leading-tight">Email verification</h1>

        {!token ? (
          <p className="flex items-center gap-1.5 text-[12px] text-tag-artist">
            <MailWarning className="h-4 w-4" aria-hidden="true" />
            This verification link is missing its token.
          </p>
        ) : confirm.isPending || confirm.isIdle ? (
          // isIdle covers the first render before the verify effect fires — show
          // the spinner rather than briefly flashing nothing.
          <p className="flex items-center gap-1.5 text-[12px] text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Verifying…
          </p>
        ) : confirm.isSuccess ? (
          <p className="flex items-center gap-1.5 text-[12px] text-ink">
            <CheckCircle2 className="h-4 w-4 text-tag-character" aria-hidden="true" />
            Your email address is verified.
          </p>
        ) : confirm.isError ? (
          <p role="alert" className="flex items-center gap-1.5 text-[12px] text-tag-artist">
            <MailWarning className="h-4 w-4" aria-hidden="true" />
            {authErrorMessage(confirm.error, "This verification link is invalid or has expired.")}
          </p>
        ) : null}

        <p className="mt-4 text-[12px] text-muted">
          <Link to="/account" className="text-link hover:underline">
            Back to your account
          </Link>
        </p>
      </div>
    </div>
  );
}
