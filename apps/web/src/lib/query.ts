import { QueryClient } from "@tanstack/react-query";

/**
 * Shared TanStack Query client. Eden Treaty is the transport inside every
 * `queryFn`; TanStack handles caching, dedupe, and loading/error state.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // assets don't change often; avoid refetch churn
      retry: 1,
    },
  },
});
