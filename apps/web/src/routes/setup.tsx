import { useState, type FormEvent } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MinusCircle,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import { PasswordInput } from "../components/password-input";
import { authErrorMessage, useRegister } from "../lib/auth";
import { TEXT_INPUT } from "../lib/input-styles";
import { SETUP_STATUS_KEY, useSetupChecks, type SetupCheck } from "../lib/setup";

/** Client-side minimum, mirroring the API's `password` schema (>= 8 chars). */
const MIN_PASSWORD_LENGTH = 8;

/** Per-status icon + colour for a diagnostic row. */
const CHECK_STYLE: Record<
  SetupCheck["status"],
  { Icon: typeof CheckCircle2; className: string; label: string }
> = {
  pass: { Icon: CheckCircle2, className: "text-tag-copyright", label: "OK" },
  warn: { Icon: AlertTriangle, className: "text-tag-character", label: "Warning" },
  fail: { Icon: XCircle, className: "text-tag-artist", label: "Failed" },
  skipped: { Icon: MinusCircle, className: "text-muted", label: "Skipped" },
};

/** One diagnostic row: status icon, what was checked, and how to fix it. */
function CheckRow({ check }: { check: SetupCheck }) {
  const { Icon, className, label } = CHECK_STYLE[check.status];
  return (
    <li className="flex gap-2.5 py-2">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${className}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-[13px] font-medium">
          {check.label} <span className="sr-only">— {label}</span>
        </p>
        <p className="text-[12px] text-muted">{check.detail}</p>
        {check.remedy ? (
          <p className="mt-1 text-[12px] text-ink/80">
            <span className="font-semibold">Fix: </span>
            {check.remedy}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * First-run setup. Reached only while the instance has zero accounts — the root
 * layout redirects everything here until then, and away from here afterwards.
 *
 * Two steps, and the split is deliberate. The checks are READ-ONLY: everything
 * genuinely hard to change later (storage root, public base URL, SMTP
 * credentials) lives in the server's environment and must be right before boot,
 * so this page reports it and says what to edit rather than pretending it can
 * write it. The one thing that cannot be done any other way — creating the first
 * account — is the only thing this page writes. Everything else (upload caps,
 * plugin activation, mail) is admin-console territory afterwards.
 */
export function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const checks = useSetupChecks();
  const register = useRegister();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const passwordTooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  // Fail closed: block while the checks are still loading, when they errored, and
  // when they came back blocking. Defaulting to "not blocked" would let an admin
  // be created on an instance whose storage is unusable — or whose state we never
  // managed to read.
  const blocked = checks.isError || !checks.data?.canProceed;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (register.isPending || mismatch || blocked) return;
    const trimmedEmail = email.trim();
    register.mutate(
      {
        username: username.trim(),
        password,
        // Omit entirely when blank so the server stores NULL, not "".
        ...(trimmedEmail ? { email: trimmedEmail } : {}),
      },
      {
        onSuccess: async () => {
          // The gate reads this key; without invalidating, the app would bounce
          // straight back to /setup on the cached "needsSetup: true".
          await queryClient.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
          void navigate({ to: "/" });
        },
      },
    );
  }

  return (
    <div className="mx-auto mt-6 w-full max-w-5xl px-4 pb-10">
      <div className="mb-5 flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-link/10 text-link">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-lg font-bold leading-tight">Welcome to Bunbooru</h1>
          <p className="text-[12px] text-muted">
            This instance has no accounts yet. Let’s check the server and create your
            administrator.
          </p>
        </div>
      </div>

      {/* Two columns once there's room: diagnostics are for reading, the form is
          for filling in, and side-by-side keeps the fix-it text visible while you
          type. `items-start` stops the shorter column stretching to match. */}
      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <section
          aria-labelledby="setup-checks-heading"
          className="rounded-xl border border-line bg-surface p-5 shadow-sm"
        >
          <h2 id="setup-checks-heading" className="text-sm font-bold">
            1. System check
          </h2>
          <p className="mb-2 text-[12px] text-muted">
            These come from the server’s environment. Warnings are safe to fix later; a
            failure has to be resolved before you can continue.
          </p>

          {checks.isPending ? (
            <p className="flex items-center gap-1.5 py-3 text-[12px] text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Checking the server…
            </p>
          ) : checks.isError ? (
            <p
              role="alert"
              className="rounded-md border border-tag-artist/30 bg-tag-artist/10 px-3 py-2 text-[12px] text-tag-artist"
            >
              Couldn’t run the system check. The server may be unreachable.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {checks.data.checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ul>
          )}
        </section>

        <section
          aria-labelledby="setup-admin-heading"
          className="rounded-xl border border-line bg-surface p-5 shadow-sm"
        >
          <h2 id="setup-admin-heading" className="text-sm font-bold">
            2. Administrator account
          </h2>
          <p className="mb-3 text-[12px] text-muted">
            The first account created becomes the site administrator. You’ll be signed in
            automatically.
          </p>

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
              <span className="mt-1 block text-[11px] text-muted">
                Without one, password reset can’t reach you — recovery then needs the
                <code className="mx-1">reset-password</code> CLI on the server.
              </span>
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

            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold">Confirm password</span>
              <PasswordInput
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
              />
              {mismatch ? (
                <span className="mt-1 block text-[11px] text-tag-artist">
                  Passwords don’t match.
                </span>
              ) : null}
            </label>

            {checks.isError ? (
              <p
                role="alert"
                className="rounded-md border border-tag-artist/30 bg-tag-artist/10 px-3 py-2 text-[12px] text-tag-artist"
              >
                The system check couldn’t be reached, so setup can’t continue. Confirm the
                server is running, then reload this page.
              </p>
            ) : blocked && checks.data ? (
              <p
                role="alert"
                className="rounded-md border border-tag-artist/30 bg-tag-artist/10 px-3 py-2 text-[12px] text-tag-artist"
              >
                Resolve the failed system check above, restart the server, then reload this
                page.
              </p>
            ) : null}

            {register.isError ? (
              <p
                role="alert"
                className="rounded-md border border-tag-artist/30 bg-tag-artist/10 px-3 py-2 text-[12px] text-tag-artist"
              >
                {authErrorMessage(register.error, "Couldn’t create the account. Please try again.")}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={register.isPending || mismatch || blocked}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-link px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-link-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {register.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              Create administrator
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
