import { useState, type FormEvent } from "react";

import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Layers, Loader2 } from "lucide-react";

import { CARD_CLASS, INPUT_CLASS } from "../../components/card-styles";
import { unwrap } from "../../lib/api";
import { authErrorMessage, useCurrentUser } from "../../lib/auth";
import { displayName, pools } from "./client";
import { PoolThumb } from "./PoolThumb";

/** `/pools`: every pool, most recently updated first, with search and (for members) a create form. */
export function PoolsPage() {
  const { data: user } = useCurrentUser();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  // Keyset pages walked so far: the cursor that fetched each one.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);

  const list = useQuery({
    queryKey: ["pools", "list", search, cursor ?? null],
    queryFn: async () =>
      unwrap(await pools.pools.get({ query: { ...(search ? { q: search } : {}), ...(cursor ? { cursor } : {}) } })),
  });

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setSearch(query.trim());
    setCursors([undefined]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border-b border-line pb-2">
        <h1 className="text-base font-bold">Pools</h1>
        <form onSubmit={onSearch} className="ml-auto flex gap-2" role="search">
          <input
            type="search"
            aria-label="Search pools by name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pools"
            className={`${INPUT_CLASS} w-48`}
          />
          <button type="submit" className="rounded border border-line px-3 text-[12px] hover:border-link">
            Search
          </button>
        </form>
      </div>

      {user ? <CreatePool /> : null}

      {list.isLoading ? (
        <p className="text-[12px] text-muted">Loading…</p>
      ) : list.isError ? (
        <p className="text-[12px] text-tag-artist">Couldn’t load pools.</p>
      ) : !list.data || list.data.pools.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center text-[12px] text-muted">
          <Layers className="h-12 w-12 text-line" strokeWidth={1.25} aria-hidden="true" />
          {search ? `No pools match “${search}”.` : "No pools yet."}
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {list.data.pools.map((pool) => (
            <li key={pool.id}>
              <Link
                to="/pools/$poolId"
                params={{ poolId: String(pool.id) }}
                className={`${CARD_CLASS} block p-3 hover:border-link hover:no-underline`}
              >
                <div className="mb-2 aspect-[4/3] overflow-hidden rounded bg-line/30">
                  {pool.coverAssetId ? (
                    <PoolThumb assetId={pool.coverAssetId} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="truncate font-bold text-ink">{displayName(pool.name)}</div>
                <div className="text-[11px] text-muted">
                  {pool.postCount} post{pool.postCount === 1 ? "" : "s"}
                  {pool.creatorName ? ` · by ${pool.creatorName}` : ""}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {cursors.length > 1 || list.data?.nextCursor ? (
        <nav aria-label="Pool pages" className="flex justify-center gap-2 text-[12px]">
          <button
            type="button"
            disabled={cursors.length <= 1}
            onClick={() => setCursors((c) => c.slice(0, -1))}
            className="rounded border border-line px-3 py-1 hover:border-link disabled:cursor-not-allowed disabled:text-muted"
          >
            ‹ Newer
          </button>
          <button
            type="button"
            disabled={!list.data?.nextCursor}
            onClick={() => {
              const next = list.data?.nextCursor;
              if (next) setCursors((c) => [...c, next]);
            }}
            className="rounded border border-line px-3 py-1 hover:border-link disabled:cursor-not-allowed disabled:text-muted"
          >
            Older ›
          </button>
        </nav>
      ) : null}
    </div>
  );
}

/** Create a pool, then open it. */
function CreatePool() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: async (poolName: string) => unwrap(await pools.pools.post({ name: poolName })),
    onSuccess: (pool) => void navigate({ to: "/pools/$poolId", params: { poolId: String(pool.id) } }),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim() && !create.isPending) create.mutate(name.trim());
  }

  return (
    <form onSubmit={onSubmit} className={`${CARD_CLASS} flex max-w-xl flex-wrap items-end gap-2 p-3`}>
      <label className="block min-w-0 flex-1">
        <span className="mb-1 block text-[11px] font-bold text-muted">New pool</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. My Comic"
          maxLength={100}
          className={INPUT_CLASS}
        />
      </label>
      <button
        type="submit"
        disabled={create.isPending}
        className="flex items-center gap-1 rounded bg-link px-3 py-1.5 text-[12px] text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
        Create
      </button>
      {create.isError ? (
        <p role="alert" className="w-full text-[12px] text-tag-artist">
          {authErrorMessage(create.error, "Couldn’t create the pool.")}
        </p>
      ) : null}
    </form>
  );
}
