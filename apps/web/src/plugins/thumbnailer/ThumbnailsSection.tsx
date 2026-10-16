import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { unwrap } from "../../lib/api";
import { authErrorMessage } from "../../lib/auth";
import { thumbnailerApi } from "./client";

/** How often the counts refresh while a queued backfill is being worked through. */
const PROGRESS_POLL_MS = 5000;

/**
 * Admin console section for the thumbnailer plugin: shows how many assets have
 * thumbnails and queues a backfill for the rest, which the job runner works
 * through in the background (the counts refresh while it does).
 */
export function ThumbnailsSection() {
  const queryClient = useQueryClient();
  const backfill = useMutation({
    mutationFn: async () =>
      unwrap(await thumbnailerApi.api.v1.plugins.thumbnailer.backfill.post()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["thumbnailer", "status"] });
    },
  });
  const status = useQuery({
    queryKey: ["thumbnailer", "status"],
    queryFn: async () =>
      unwrap(await thumbnailerApi.api.v1.plugins.thumbnailer.status.get()),
    // Follow a backfill's progress until nothing is missing.
    refetchInterval: (query) =>
      backfill.isSuccess && (query.state.data?.missing ?? 0) > 0 ? PROGRESS_POLL_MS : false,
  });

  return (
    <section>
      <h2 className="mb-2 font-bold">Thumbnails</h2>

      {status.isLoading ? (
        <p className="text-[12px] text-muted">Loading…</p>
      ) : status.isError ? (
        <p role="alert" className="text-[12px] text-tag-artist">
          Couldn’t load thumbnail status.
        </p>
      ) : status.data ? (
        <p className="mb-2 text-[12px] text-muted">
          {status.data.withThumbnails} / {status.data.totalAssets} assets have thumbnails
          {status.data.missing > 0 ? ` · ${status.data.missing} missing` : " · all done"}
          {status.data.failed > 0 ? ` · ${status.data.failed} failed` : ""}
        </p>
      ) : null}

      {backfill.data ? (
        <p className="mb-2 text-[12px] text-tag-character">
          {backfill.data.queued
            ? "Backfill queued: thumbnails are generated in the background."
            : "A backfill is already starting."}
        </p>
      ) : null}
      {backfill.isError ? (
        <p role="alert" className="text-[12px] text-tag-artist">
          {authErrorMessage(backfill.error, "Backfill failed. Please try again.")}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => {
          if (!backfill.isPending) backfill.mutate();
        }}
        disabled={backfill.isPending || status.data?.missing === 0}
        className="flex items-center justify-center gap-1 rounded bg-link px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {backfill.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
        {status.data && status.data.missing > 0
          ? `Generate missing (${status.data.missing})`
          : "Generate missing"}
      </button>
    </section>
  );
}
