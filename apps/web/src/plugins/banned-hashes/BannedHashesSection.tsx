import { useState, type FormEvent } from "react";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";

import { unwrap } from "../../lib/api";
import { authErrorMessage } from "../../lib/auth";
import { INPUT_CLASS } from "../../components/card-styles";
import { BANS_KEY, bansApi } from "./client";

/** A pasted hash, by length: 64 hex is a sha256, 32 an md5. */
function parseHash(input: string): { sha256: string } | { md5: string } | null {
  const hash = input.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hash)) return { sha256: hash };
  if (/^[0-9a-f]{32}$/.test(hash)) return { md5: hash };
  return null;
}

/**
 * Admin console section for the banned-hashes plugin: ban a file by pasting
 * its sha256 or md5, and see or lift the bans. Banning from a post page is the
 * other way in.
 */
export function BannedHashesSection() {
  const queryClient = useQueryClient();
  const [hash, setHash] = useState("");
  const [reason, setReason] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  const bans = useInfiniteQuery({
    queryKey: [...BANS_KEY, "list"],
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(await bansApi.bans.get({ query: pageParam === undefined ? {} : { before: pageParam } })),
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });

  const add = useMutation({
    mutationFn: async (body: { sha256: string } | { md5: string }) =>
      unwrap(await bansApi.bans.post({ ...body, reason: reason.trim() || undefined })),
    onSuccess: () => {
      setHash("");
      setReason("");
      void queryClient.invalidateQueries({ queryKey: BANS_KEY });
    },
  });
  const lift = useMutation({
    mutationFn: async (id: number) => {
      const res = await bansApi.bans({ id: String(id) }).delete();
      if (res.error) throw res.error;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: BANS_KEY }),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (add.isPending) return;
    const parsed = parseHash(hash);
    if (!parsed) {
      setInputError("Paste a sha256 (64 hex characters) or an md5 (32).");
      return;
    }
    setInputError(null);
    add.mutate(parsed);
  }

  const items = bans.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="bans-heading">
      <h2 id="bans-heading" className="text-base font-bold">
        Banned hashes
      </h2>
      <p className="mb-4 mt-1 max-w-2xl text-[13px] text-muted">
        Uploads of a banned file are refused from every source. Bans match exact bytes: a
        re-encoded copy has different hashes.
      </p>

      <form onSubmit={submit} className="mb-5 flex max-w-2xl flex-col gap-2 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1 text-[12px]">
          <span className="mb-0.5 block font-medium">sha256 or md5</span>
          <input
            value={hash}
            onChange={(e) => setHash(e.target.value)}
            className={`${INPUT_CLASS} font-mono`}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="text-[12px] sm:w-56">
          <span className="mb-0.5 block font-medium">Reason (shown to the uploader)</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={INPUT_CLASS} />
        </label>
        <button
          type="submit"
          disabled={add.isPending}
          className="flex items-center justify-center gap-1 rounded bg-link px-4 py-1.5 text-[12px] text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {add.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          Ban
        </button>
      </form>
      {inputError || add.isError ? (
        <p role="alert" className="-mt-3 mb-4 text-[12px] text-tag-artist">
          {inputError ?? authErrorMessage(add.error, "Couldn’t ban that hash.")}
        </p>
      ) : null}

      {bans.isPending ? (
        <p className="flex items-center gap-1.5 text-[13px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Loading…
        </p>
      ) : bans.isError ? (
        <p role="alert" className="text-[13px] text-tag-artist">
          Couldn’t load the bans.
        </p>
      ) : items.length === 0 ? (
        <p className="text-[13px] text-muted">No bans yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {items.map((ban) => (
            <li key={ban.id} className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1 text-[12px]">
                {ban.sha256 ? <div className="break-all font-mono">sha256 {ban.sha256}</div> : null}
                {ban.md5 ? <div className="break-all font-mono text-muted">md5 {ban.md5}</div> : null}
                <div className="mt-0.5 text-muted">
                  {ban.reason ? `${ban.reason} · ` : ""}
                  {ban.bannedByName ?? "unknown"} · {new Date(ban.createdAt).toLocaleString()}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!lift.isPending) lift.mutate(ban.id);
                }}
                disabled={lift.isPending}
                aria-label={`Lift ban ${ban.id}`}
                className="flex shrink-0 items-center gap-1 rounded border border-line px-2 py-1 text-[12px] hover:bg-bg disabled:cursor-not-allowed disabled:opacity-60"
              >
                {lift.isPending && lift.variables === ban.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Lift
              </button>
            </li>
          ))}
        </ul>
      )}
      {lift.isError ? (
        <p role="alert" className="mt-2 text-[12px] text-tag-artist">
          {authErrorMessage(lift.error, "Couldn’t lift that ban.")}
        </p>
      ) : null}
      {bans.hasNextPage ? (
        <button
          type="button"
          onClick={() => {
            if (!bans.isFetchingNextPage) void bans.fetchNextPage();
          }}
          disabled={bans.isFetchingNextPage}
          className="mt-3 rounded border border-line px-3 py-1 text-[12px] hover:bg-bg disabled:opacity-60"
        >
          {bans.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </section>
  );
}
