import { useState } from "react";

import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, X } from "lucide-react";

import { unwrap } from "../../lib/api";
import { authErrorMessage } from "../../lib/auth";
import { INPUT_CLASS } from "../../components/card-styles";
import { REPORTS_KEY, reportsApi } from "./client";

/** One report, as the queue returns it. */
export interface QueueReport {
  id: number;
  assetId: number;
  reporterName: string | null;
  reason: string;
  status: "open" | "resolved" | "dismissed";
  resolution: string | null;
  resolvedByName: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

const BUTTON_CLASS =
  "flex shrink-0 items-center gap-1 rounded border border-line px-2 py-1 text-[12px] hover:bg-bg disabled:cursor-not-allowed disabled:opacity-60";

/**
 * A queue row: the reported post, why, by whom and when. An open report can be
 * dismissed, or its post deleted (behind a confirm step, since that's
 * permanent). Handled reports show their outcome instead.
 */
export function ReportQueueRow({ report }: { report: QueueReport }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const refresh = () => void queryClient.invalidateQueries({ queryKey: REPORTS_KEY });

  const dismiss = useMutation({
    mutationFn: async () => unwrap(await reportsApi.reports({ id: String(report.id) }).dismiss.post({})),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async () => {
      const reason = deleteReason.trim();
      const res = await reportsApi
        .assets({ id: String(report.assetId) })
        .delete.post(reason ? { reason } : {});
      if (res.error) throw res.error;
    },
    onSuccess: () => {
      setConfirming(false);
      refresh();
      // The post is gone from every gallery too.
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
  });

  const pending = dismiss.isPending || remove.isPending;
  const error = dismiss.error ?? remove.error;

  return (
    <li className="px-3 py-2 text-[12px]">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Link to="/posts/$id" params={{ id: String(report.assetId) }} className="font-medium text-link hover:underline">
            Post #{report.assetId}
          </Link>
          <p className="mt-0.5 whitespace-pre-wrap break-words">{report.reason}</p>
          <div className="mt-0.5 text-muted">
            {report.reporterName ?? "unknown"} · {new Date(report.createdAt).toLocaleString()}
          </div>
          {report.status !== "open" ? (
            <div className="mt-0.5 text-muted">
              {report.status === "dismissed" ? "Dismissed" : "Resolved"}
              {report.resolution ? `: ${report.resolution}` : ""}
              {report.resolvedByName ? ` · ${report.resolvedByName}` : ""}
              {report.resolvedAt ? ` · ${new Date(report.resolvedAt).toLocaleString()}` : ""}
            </div>
          ) : null}
        </div>
        {report.status === "open" && !confirming ? (
          <div className="flex shrink-0 gap-1.5">
            <button type="button" disabled={pending} onClick={() => dismiss.mutate()} className={BUTTON_CLASS}>
              {dismiss.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Dismiss
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming(true)}
              className={`${BUTTON_CLASS} hover:border-tag-artist hover:text-tag-artist`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Delete post
            </button>
          </div>
        ) : null}
      </div>
      {report.status === "open" && confirming ? (
        <div className="mt-2 space-y-1 rounded border border-tag-artist p-2">
          <p className="font-medium text-tag-artist">
            Delete post #{report.assetId}? This is permanent: the post and its file are gone for good.
          </p>
          <input
            value={deleteReason}
            onChange={(e) => setDeleteReason(e.target.value)}
            maxLength={500}
            placeholder="Reason (optional)"
            aria-label={`Reason for deleting post ${report.assetId}`}
            className={INPUT_CLASS}
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
              className="flex items-center gap-1 rounded bg-tag-artist px-3 py-1 text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {remove.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              Delete permanently
            </button>
            <button type="button" disabled={remove.isPending} onClick={() => setConfirming(false)} className={BUTTON_CLASS}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-tag-artist">
          {authErrorMessage(error, dismiss.error ? "Couldn’t dismiss the report." : "Couldn’t delete the post.")}
        </p>
      ) : null}
    </li>
  );
}
