import { Loader2, RotateCcw } from "lucide-react";

import { authErrorMessage } from "../../lib/auth";
import { useJobsOverview, useRetryJob, type JobFailureDto, type JobsOverviewDto } from "../../lib/jobs";

const STATUSES = ["queued", "running", "done", "failed"] as const;
type Status = (typeof STATUSES)[number];

/** Pivot the `{ kind, status, count }` rows into one row per kind. */
function byKind(counts: JobsOverviewDto["counts"]): { kind: string; counts: Record<Status, number> }[] {
  const rows = new Map<string, Record<Status, number>>();
  for (const { kind, status, count } of counts) {
    const row = rows.get(kind) ?? { queued: 0, running: 0, done: 0, failed: 0 };
    row[status] += count;
    rows.set(kind, row);
  }
  return [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([kind, row]) => ({ kind, counts: row }));
}

/**
 * Admin console section for the background job queue: jobs per kind and
 * status, and the latest failures with a Retry for each. Refreshes on its own
 * while open.
 */
export function JobsSection() {
  const overview = useJobsOverview();

  return (
    <section aria-labelledby="jobs-heading">
      <h2 id="jobs-heading" className="text-base font-bold">
        Background jobs
      </h2>
      <p className="mb-4 mt-1 max-w-2xl text-[13px] text-muted">
        Work queued for the background, such as thumbnails.
        {overview.data
          ? ` Finished jobs are kept for ${overview.data.retentionDays.done} days, failed ones for ${overview.data.retentionDays.failed}.`
          : ""}
        {overview.data?.runner === "off"
          ? " This server doesn’t run jobs itself (JOBS_RUNNER=off): queued jobs only run while a separate worker process (bunbooru worker) is up."
          : ""}
      </p>

      {overview.isPending ? (
        <p className="flex items-center gap-1.5 text-[13px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Loading…
        </p>
      ) : overview.isError ? (
        <p role="alert" className="text-[13px] text-tag-artist">
          Couldn’t load the job queue.
        </p>
      ) : (
        <div className="space-y-5">
          <JobCounts counts={overview.data.counts} />
          <JobFailures failures={overview.data.failures} />
        </div>
      )}
    </section>
  );
}

function JobCounts({ counts }: { counts: JobsOverviewDto["counts"] }) {
  const rows = byKind(counts);
  if (rows.length === 0) return <p className="text-[13px] text-muted">No jobs yet.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th scope="col" className="px-3 py-2 font-medium">
              Kind
            </th>
            {STATUSES.map((status) => (
              <th key={status} scope="col" className="px-3 py-2 text-right font-medium capitalize">
                {status}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr key={row.kind}>
              <th scope="row" className="px-3 py-2 text-left font-mono font-medium">
                {row.kind}
              </th>
              {STATUSES.map((status) => (
                <td
                  key={status}
                  className={`px-3 py-2 text-right tabular-nums ${
                    status === "failed" && row.counts.failed > 0 ? "text-tag-artist" : ""
                  }`}
                >
                  {row.counts[status]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JobFailures({ failures }: { failures: JobFailureDto[] }) {
  const retry = useRetryJob();
  return (
    <div>
      <h3 className="mb-1.5 text-[13px] font-bold">Recent failures</h3>
      {failures.length === 0 ? (
        <p className="text-[13px] text-muted">None.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {failures.map((job) => (
            <li key={job.id} className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                  <span className="font-mono font-medium">{job.kind}</span>
                  <span className="text-muted">
                    #{job.id} · {job.attempts} {job.attempts === 1 ? "attempt" : "attempts"}
                    {job.finishedAt ? ` · ${new Date(job.finishedAt).toLocaleString()}` : ""}
                  </span>
                </div>
                {job.lastError ? (
                  <p className="mt-0.5 break-words font-mono text-[11px] text-tag-artist">{job.lastError}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!retry.isPending) retry.mutate(job.id);
                }}
                disabled={retry.isPending}
                aria-label={`Retry job ${job.id} (${job.kind})`}
                className="flex shrink-0 items-center gap-1 rounded border border-line px-2 py-1 text-[12px] hover:bg-bg disabled:cursor-not-allowed disabled:opacity-60"
              >
                {retry.isPending && retry.variables === job.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Retry
              </button>
            </li>
          ))}
        </ul>
      )}
      {retry.isError ? (
        <p role="alert" className="mt-2 text-[12px] text-tag-artist">
          {authErrorMessage(retry.error, "Couldn’t retry that job. Please try again.")}
        </p>
      ) : null}
    </div>
  );
}
