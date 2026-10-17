import { useState } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { unwrap } from "../../lib/api";
import { REPORT_STATUSES, REPORTS_KEY, reportsApi, type ReportStatus } from "./client";
import { ReportQueueRow } from "./ReportQueueRow";

/** Empty-state text per status. */
const EMPTY: Record<ReportStatus, string> = {
  open: "No open reports.",
  resolved: "No resolved reports.",
  dismissed: "No dismissed reports.",
};

/**
 * Admin console section for the reports plugin: the moderator queue, newest
 * first, filtered by status (open by default). Open reports can be dismissed,
 * or their post deleted, which resolves every open report on it.
 */
export function ReportsSection() {
  const [status, setStatus] = useState<ReportStatus>("open");

  const queue = useInfiniteQuery({
    queryKey: [...REPORTS_KEY, "queue", status],
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await reportsApi.queue.get({
          query: pageParam === undefined ? { status } : { status, before: pageParam },
        }),
      ),
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });

  const items = queue.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="reports-heading">
      <h2 id="reports-heading" className="text-base font-bold">
        Reports
      </h2>
      <p className="mb-4 mt-1 max-w-2xl text-[13px] text-muted">
        Posts users have reported. Dismiss a report you don’t act on, or delete the post: deleting resolves every
        open report on it.
      </p>

      <div role="group" aria-label="Report status" className="mb-3 flex gap-1.5">
        {REPORT_STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={status === value}
            onClick={() => setStatus(value)}
            className={`rounded border px-2.5 py-1 text-[12px] capitalize ${
              status === value ? "border-link text-link" : "border-line hover:bg-bg"
            }`}
          >
            {value}
          </button>
        ))}
      </div>

      {queue.isPending ? (
        <p className="flex items-center gap-1.5 text-[13px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Loading…
        </p>
      ) : queue.isError ? (
        <p role="alert" className="text-[13px] text-tag-artist">
          Couldn’t load the reports.
        </p>
      ) : items.length === 0 ? (
        <p className="text-[13px] text-muted">{EMPTY[status]}</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {items.map((report) => (
            <ReportQueueRow key={report.id} report={report} />
          ))}
        </ul>
      )}
      {queue.hasNextPage ? (
        <button
          type="button"
          onClick={() => {
            if (!queue.isFetchingNextPage) void queue.fetchNextPage();
          }}
          disabled={queue.isFetchingNextPage}
          className="mt-3 rounded border border-line px-3 py-1 text-[12px] hover:bg-bg disabled:opacity-60"
        >
          {queue.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </section>
  );
}
