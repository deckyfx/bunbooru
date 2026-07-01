import { useState, type FormEvent } from "react";

import { Link } from "@tanstack/react-router";
import { Loader2, Trash2 } from "lucide-react";

import { authErrorMessage, useCurrentUser } from "../lib/auth";
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from "../lib/api-keys";

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
      <ApiKeysSection />
    </div>
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
