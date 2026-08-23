import { useState, type FormEvent } from "react";

import { Link } from "@tanstack/react-router";
import { BadgeCheck, Loader2, MailCheck, ShieldAlert, Trash2 } from "lucide-react";

import { PasswordInput } from "../components/password-input";
import {
  authErrorMessage,
  useAuthConfig,
  useChangeEmail,
  useChangePassword,
  useCurrentUser,
  useRequestEmailVerification,
  type UserDto,
} from "../lib/auth";
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from "../lib/api-keys";

/** Client-side minimum, mirroring the API's `password` schema (>= 8 chars). */
const MIN_PASSWORD_LENGTH = 8;

/** ISO timestamp → `YYYY-MM-DD`, tolerant of a null/invalid value. */
function formatDate(value: string | null): string {
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

/**
 * Account page: manage long-lived API keys (create, list, revoke). The raw key
 * is shown ONCE right after creation. Login-gated (the API also enforces it).
 */
export function AccountPage() {
  const { data: user, isPending } = useCurrentUser();

  if (isPending) return null;

  if (!user) {
    return (
      <p className="mx-auto max-w-md text-center text-[12px] text-muted">
        Please{" "}
        <Link to="/login" className="text-link hover:underline">
          log in
        </Link>{" "}
        to manage your account.
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="border-b border-line pb-1 text-base font-bold">Account · {user.username}</h1>
      <EmailSection user={user} />
      <ChangeEmailSection />
      <ChangePasswordSection />
      <ApiKeysSection />
    </div>
  );
}

/** Show the account's email + verification state, with a "verify email" action. */
function EmailSection({ user }: { user: UserDto }) {
  const authConfig = useAuthConfig();
  const requestVerify = useRequestEmailVerification();
  const verified = user.emailVerifiedAt !== null;
  const mailConfigured = authConfig.data?.mailConfigured ?? false;

  return (
    <section className="space-y-2">
      <h2 className="font-bold">Email</h2>
      {!user.email ? (
        <p className="text-[12px] text-muted">
          No email address is set on this account, so self-serve password reset isn’t available.
          Adding one keeps you able to recover access.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="font-mono">{user.email}</span>
            {verified ? (
              <span className="inline-flex items-center gap-1 rounded bg-tag-character/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-tag-character">
                <BadgeCheck className="h-3 w-3" aria-hidden="true" /> Verified
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded bg-tag-artist/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-tag-artist">
                <ShieldAlert className="h-3 w-3" aria-hidden="true" /> Unverified
              </span>
            )}
          </div>

          {!verified && mailConfigured ? (
            requestVerify.isSuccess ? (
              <p className="flex items-center gap-1.5 text-[12px] text-tag-character">
                <MailCheck className="h-4 w-4" aria-hidden="true" /> Verification email sent — check
                your inbox.
              </p>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => requestVerify.mutate()}
                  disabled={requestVerify.isPending}
                  className="flex items-center gap-1 rounded bg-link px-3 py-1.5 text-[12px] text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {requestVerify.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : null}
                  Verify email
                </button>
                {requestVerify.isError ? (
                  <p role="alert" className="text-[12px] text-tag-artist">
                    {authErrorMessage(requestVerify.error, "Couldn’t send the email. Try again.")}
                  </p>
                ) : null}
              </>
            )
          ) : null}
        </div>
      )}
    </section>
  );
}

/** Change the account password (requires the current one). */
/** Change the account's email (requires the current password; re-verifies). */
function ChangeEmailSection() {
  const change = useChangeEmail();
  const [email, setEmail] = useState("");
  const [current, setCurrent] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (change.isPending || !email.trim() || !current) return;
    change.mutate(
      { current, email: email.trim() },
      {
        onSuccess: () => {
          setEmail("");
          setCurrent("");
        },
      },
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="font-bold">Change email</h2>
      <p className="text-[12px] text-muted">
        Your email receives password-reset and verification links. A new address must be
        re-verified before it can be used for reset.
      </p>
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold">New email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            required
            className="block w-full rounded border border-line p-1.5 text-[12px] outline-none focus:border-link"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold">Current password</span>
          <PasswordInput value={current} onChange={setCurrent} autoComplete="current-password" required />
        </label>

        {change.isError ? (
          <p role="alert" className="text-[12px] text-tag-artist">
            {authErrorMessage(change.error, "Couldn’t change your email (is it already in use?).")}
          </p>
        ) : null}
        {change.isSuccess ? (
          <p className="text-[12px] text-tag-character">Email updated — re-verify it above.</p>
        ) : null}

        <button
          type="submit"
          disabled={change.isPending || !email.trim() || !current}
          className="flex items-center gap-1 rounded bg-link px-4 py-2 text-[12px] text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {change.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          Update email
        </button>
      </form>
    </section>
  );
}

function ChangePasswordSection() {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== next;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (change.isPending) return;
    if (next.length < MIN_PASSWORD_LENGTH || next !== confirm || !current) return;
    change.mutate(
      { current, next },
      {
        onSuccess: () => {
          setCurrent("");
          setNext("");
          setConfirm("");
        },
      },
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="font-bold">Change password</h2>
      <p className="text-[12px] text-muted">
        Changing your password signs out every other session. This browser stays logged in.
      </p>
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold">Current password</span>
          <PasswordInput
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold">New password</span>
          <PasswordInput
            value={next}
            onChange={setNext}
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
          <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" required />
          {mismatch ? (
            <span className="mt-1 block text-[11px] text-tag-artist">Passwords don’t match.</span>
          ) : null}
        </label>

        {change.isError ? (
          <p role="alert" className="text-[12px] text-tag-artist">
            {authErrorMessage(change.error, "Couldn’t change your password. Check the current one.")}
          </p>
        ) : null}
        {change.isSuccess ? <p className="text-[12px] text-tag-character">Password changed.</p> : null}

        <button
          type="submit"
          disabled={change.isPending || tooShort || mismatch || !current || !next || !confirm}
          className="flex items-center gap-1 rounded bg-link px-4 py-2 text-[12px] text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {change.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          Change password
        </button>
      </form>
    </section>
  );
}

function ApiKeysSection() {
  const keys = useApiKeys();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();
  const [name, setName] = useState("");
  // The one-time secret from the most recent creation (shown until dismissed).
  const [freshKey, setFreshKey] = useState<string | null>(null);

  function onCreate(e: FormEvent) {
    e.preventDefault();
    if (create.isPending) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate(trimmed, {
      onSuccess: (created) => {
        setFreshKey(created.key);
        setName("");
      },
    });
  }

  return (
    <section className="space-y-3">
      <h2 className="font-bold">API keys</h2>
      <p className="text-[12px] text-muted">
        Use an API key with{" "}
        <code className="rounded bg-line/40 px-1">Authorization: Bearer &lt;key&gt;</code> for
        non-browser access. A key has full account access and no expiry until revoked.
      </p>

      {freshKey ? (
        <div className="rounded border border-link bg-link/10 p-2 text-[12px]">
          <p className="mb-1 font-bold">Copy your new key now — it won’t be shown again:</p>
          <code className="block break-all rounded bg-bg p-1 font-mono">{freshKey}</code>
          <button
            type="button"
            onClick={() => setFreshKey(null)}
            className="mt-1 text-[11px] text-link hover:underline"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <form onSubmit={onCreate} className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name (e.g. laptop cli)"
          maxLength={100}
          className="block w-full rounded border border-line p-1.5 text-[12px] outline-none focus:border-link"
        />
        <button
          type="submit"
          disabled={create.isPending}
          className="flex items-center gap-1 rounded bg-link px-3 text-[12px] text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          Create
        </button>
      </form>
      {create.isError ? (
        <p role="alert" className="text-[12px] text-tag-artist">
          {authErrorMessage(create.error, "Couldn’t create the key. Please try again.")}
        </p>
      ) : null}

      {keys.isLoading ? (
        <p className="text-[12px] text-muted">Loading…</p>
      ) : keys.isError ? (
        <p role="alert" className="text-[12px] text-tag-artist">
          Couldn’t load your keys. Please try again.
        </p>
      ) : !keys.data || keys.data.length === 0 ? (
        <p className="text-[12px] text-muted">No API keys yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded border border-line">
          {keys.data.map((key) => (
            <li key={key.id} className="flex items-center gap-2 p-2 text-[12px]">
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold">{key.name}</div>
                <div className="text-[11px] text-muted">
                  created {formatDate(key.createdAt)} · last used {formatDate(key.lastUsedAt)}
                </div>
              </div>
              <button
                type="button"
                aria-label={`Revoke ${key.name}`}
                onClick={() => revoke.mutate(key.id)}
                disabled={revoke.isPending}
                className="flex items-center gap-1 rounded border border-line px-2 py-1 text-tag-artist hover:border-tag-artist disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
