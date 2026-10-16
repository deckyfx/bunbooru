import { useState, type FormEvent, type ReactNode } from "react";

import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Trash2, X } from "lucide-react";

import { CARD_CLASS, INPUT_CLASS } from "../../components/card-styles";
import { unwrap } from "../../lib/api";
import { authErrorMessage } from "../../lib/auth";
import { displayName, pools } from "./client";
import { PoolThumb } from "./PoolThumb";

/** `/pools/:poolId`: a pool's posts in order, and (for its creator or an admin) editing. */
export function PoolPage() {
  const { poolId } = useParams({ from: "/pools/$poolId" });
  const id = Number(poolId);
  const valid = Number.isSafeInteger(id) && id > 0;
  const queryClient = useQueryClient();
  const key = ["pools", "detail", id] as const;

  const pool = useQuery({
    queryKey: key,
    enabled: valid,
    queryFn: async () => {
      const res = await pools.pools({ id: String(id) }).get();
      if (res.status === 404) return null;
      return unwrap(res);
    },
  });

  // Every edit returns the new order; refresh the pool (and anything listing it).
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({ queryKey: ["pools", "list"] }),
      queryClient.invalidateQueries({ queryKey: ["pools", "asset"] }),
    ]);
  const reorder = useMutation({
    mutationFn: async (assetIds: number[]) =>
      unwrap(await pools.pools({ id: String(id) }).posts.put({ assetIds })),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (assetId: number) =>
      unwrap(await pools.pools({ id: String(id) }).posts({ assetId: String(assetId) }).delete()),
    onSuccess: refresh,
  });

  if (!valid || pool.data === null) {
    return <p className="py-16 text-center text-[12px] text-muted">That pool doesn’t exist.</p>;
  }
  if (pool.isLoading) return <p className="text-[12px] text-muted">Loading…</p>;
  if (pool.isError || !pool.data) return <p className="text-[12px] text-tag-artist">Couldn’t load the pool.</p>;

  const { posts, canEdit } = pool.data;
  const ids = posts.map((p) => p.id);
  const move = (index: number, by: -1 | 1) => {
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(index + by, 0, moved);
    reorder.mutate(next);
  };
  const busy = reorder.isPending || remove.isPending;
  const editError = reorder.error ?? remove.error;

  return (
    <div className="space-y-4">
      <div className="border-b border-line pb-2">
        <div className="text-[11px] text-muted">
          <Link to="/pools" className="text-link hover:underline">
            Pools
          </Link>{" "}
          ›
        </div>
        <h1 className="text-base font-bold">{displayName(pool.data.name)}</h1>
        <p className="text-[12px] text-muted">
          {posts.length} post{posts.length === 1 ? "" : "s"}
          {pool.data.creatorName ? ` · by ${pool.data.creatorName}` : ""} ·{" "}
          <Link to="/posts" search={{ q: `pool:${id}` }} className="text-link hover:underline">
            search these
          </Link>
        </p>
        {pool.data.description ? (
          <p className="mt-1 whitespace-pre-line text-[13px]">{pool.data.description}</p>
        ) : null}
      </div>

      {canEdit ? <EditPool id={id} name={pool.data.name} description={pool.data.description} /> : null}
      {editError ? (
        <p role="alert" className="text-[12px] text-tag-artist">
          {authErrorMessage(editError, "Couldn’t change the pool.")}
        </p>
      ) : null}

      {posts.length === 0 ? (
        <p className="py-8 text-center text-[12px] text-muted">
          No posts yet.{canEdit ? " Add posts from a post’s page (“Add to pool”)." : ""}
        </p>
      ) : (
        <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {posts.map((post, index) => (
            <li key={post.id} className="space-y-1">
              <Link
                to="/posts/$id"
                params={{ id: String(post.id) }}
                className="relative block aspect-square overflow-hidden rounded border-2 border-line hover:border-link"
              >
                <PoolThumb assetId={post.id} alt={`Post ${post.id}`} className="h-full w-full object-cover" />
                <span className="absolute left-1 top-1 rounded bg-bg/80 px-1 text-[11px] font-bold">{index + 1}</span>
              </Link>
              {canEdit ? (
                <div className="flex justify-center gap-1">
                  <IconButton label={`Move post ${post.id} earlier`} disabled={busy || index === 0} onClick={() => move(index, -1)}>
                    <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={`Move post ${post.id} later`}
                    disabled={busy || index === posts.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </IconButton>
                  <IconButton label={`Remove post ${post.id} from the pool`} disabled={busy} onClick={() => remove.mutate(post.id)}>
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </IconButton>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded border border-line p-1 hover:border-link disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** Rename, describe or delete a pool (creator or admin; the server checks). */
function EditPool({ id, name, description }: { id: number; name: string; description: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draftName, setDraftName] = useState(displayName(name));
  const [draftDescription, setDraftDescription] = useState(description);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useMutation({
    mutationFn: async () =>
      unwrap(await pools.pools({ id: String(id) }).patch({ name: draftName, description: draftDescription })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["pools"] }),
  });
  const destroy = useMutation({
    mutationFn: async () => {
      const res = await pools.pools({ id: String(id) }).delete();
      if (res.error) throw res.error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["pools"] });
      void navigate({ to: "/pools" });
    },
  });

  function onSave(e: FormEvent) {
    e.preventDefault();
    if (!save.isPending) save.mutate();
  }

  return (
    <form onSubmit={onSave} className={`${CARD_CLASS} max-w-xl space-y-2 p-3`}>
      <label className="block">
        <span className="mb-1 block text-[11px] font-bold text-muted">Name</span>
        <input type="text" value={draftName} onChange={(e) => setDraftName(e.target.value)} maxLength={100} className={INPUT_CLASS} />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-bold text-muted">Description</span>
        <textarea
          value={draftDescription}
          onChange={(e) => setDraftDescription(e.target.value)}
          rows={3}
          maxLength={2000}
          className={INPUT_CLASS}
        />
      </label>
      {save.isError ? (
        <p role="alert" className="text-[12px] text-tag-artist">
          {authErrorMessage(save.error, "Couldn’t save the pool.")}
        </p>
      ) : null}
      {destroy.isError ? (
        <p role="alert" className="text-[12px] text-tag-artist">
          {authErrorMessage(destroy.error, "Couldn’t delete the pool.")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={save.isPending}
          className="flex items-center gap-1 rounded bg-link px-3 py-1.5 text-[12px] text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          Save
        </button>
        {save.isSuccess ? <span className="text-[12px] text-tag-character">Saved.</span> : null}
        <div className="ml-auto">
          {confirmDelete ? (
            <span className="flex items-center gap-2 text-[12px]">
              Delete this pool? Its posts stay.
              <button
                type="button"
                disabled={destroy.isPending}
                onClick={() => destroy.mutate()}
                className="rounded border border-tag-artist px-2 py-1 text-tag-artist disabled:opacity-60"
              >
                Delete
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="rounded border border-line px-2 py-1">
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-1 rounded border border-line px-2 py-1 text-[12px] text-tag-artist hover:border-tag-artist"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Delete pool
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
