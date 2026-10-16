/**
 * The background job queue's admin view via Eden Treaty + TanStack Query: jobs
 * per kind and status, recent failures, and retrying one.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { JobFailureDto, JobsOverviewDto } from "@bunbooru/api";

import { api, unwrap } from "./api";

export type { JobFailureDto, JobsOverviewDto };

const JOBS_KEY = ["admin-jobs"] as const;

/** How often the overview refreshes while it's on screen (the queue moves on its own). */
const JOBS_POLL_MS = 10_000;

/** The queue overview (admin-only). */
export function useJobsOverview() {
  return useQuery({
    queryKey: JOBS_KEY,
    refetchInterval: JOBS_POLL_MS,
    queryFn: async (): Promise<JobsOverviewDto> => unwrap(await api.api.v1.admin.jobs.get()),
  });
}

/** Re-queue a failed job (204, empty body — so we check `error`, not `unwrap`). */
export function useRetryJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await api.api.v1.admin.jobs({ id: String(id) }).retry.post();
      if (res.error) throw res.error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
  });
}
