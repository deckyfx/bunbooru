import { useState, type FormEvent } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Flag, Loader2 } from "lucide-react";

import { unwrap } from "../../lib/api";
import { authErrorMessage } from "../../lib/auth";
import { INPUT_CLASS } from "../../components/card-styles";
import type { SlotPropsMap } from "../slots";
import { isStatus, REPORTS_KEY, reportsApi } from "./client";

/** Longest reason the server accepts (after trimming). */
const MAX_REASON = 500;

/**
 * The post page's report control (`post-detail-aside`, signed-in members): a
 * "Report" toggle that opens a reason box. A user has at most one open report
 * per post, so a second attempt says so instead of failing vaguely.
 */
export function ReportPostButton({ asset }: SlotPropsMap["post-detail-aside"]) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const submit = useMutation({
    mutationFn: async (text: string) =>
      unwrap(await reportsApi.assets({ id: String(asset.id) }).post({ reason: text })),
    onSuccess: () => {
      setReason("");
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: REPORTS_KEY });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = reason.trim();
    if (!text || submit.isPending) return;
    submit.mutate(text);
  }

  const alreadyReported = isStatus(submit.error, 409);

  return (
    <div>
      <h3 className="mb-1 font-bold">Report</h3>
      {submit.isSuccess ? (
        <p role="status" className="text-[12px] text-muted">
          Reported, thanks.
        </p>
      ) : alreadyReported ? (
        <p role="status" className="text-[12px] text-muted">
          You’ve already reported this post.
        </p>
      ) : (
        <div className="space-y-1 text-[12px]">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`report-form-${asset.id}`}
            onClick={() => setOpen((value) => !value)}
            className="flex items-center gap-1 rounded border border-line px-2 py-1 hover:border-tag-artist hover:text-tag-artist"
          >
            <Flag className="h-3.5 w-3.5" aria-hidden="true" />
            {open ? "Cancel report" : "Report this post"}
          </button>
          {open ? (
            <form id={`report-form-${asset.id}`} onSubmit={onSubmit} className="space-y-1">
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={MAX_REASON}
                rows={3}
                required
                placeholder="What’s wrong with this post?"
                aria-label="Report reason"
                className={INPUT_CLASS}
              />
              <button
                type="submit"
                disabled={submit.isPending || !reason.trim()}
                className="flex items-center gap-1 rounded bg-link px-3 py-1 text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submit.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                Send report
              </button>
            </form>
          ) : null}
          {submit.isError ? (
            <p role="alert" className="text-tag-artist">
              {authErrorMessage(submit.error, "Couldn’t send the report.")}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
