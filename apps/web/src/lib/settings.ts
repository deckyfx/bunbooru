/**
 * Admin runtime settings (upload caps) via Eden Treaty + TanStack Query. These
 * routes are admin-gated on the server; the admin page also hides them for
 * non-admins.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { UploadLimitsDto } from "@bunbooru/api";

import { api, unwrap } from "./api";

export type { UploadLimitsDto };

const UPLOAD_LIMITS_KEY = ["upload-limits"] as const;

/** Current upload caps (admin). */
export function useUploadLimits() {
  return useQuery({
    queryKey: UPLOAD_LIMITS_KEY,
    queryFn: async (): Promise<UploadLimitsDto> => unwrap(await api.api.v1.settings.get()),
  });
}

/** Update one or both upload caps, priming the cache with the server's result. */
export function useUpdateUploadLimits() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<UploadLimitsDto>): Promise<UploadLimitsDto> =>
      unwrap(await api.api.v1.settings.patch(patch)),
    onSuccess: (limits) => queryClient.setQueryData(UPLOAD_LIMITS_KEY, limits),
  });
}
