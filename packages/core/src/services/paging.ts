/** Default and ceiling page sizes for admin lists (aliases, implications). */
export const DEFAULT_LIST_PER_PAGE = 50;
export const MAX_LIST_PER_PAGE = 200;

/** A requested page, clamped to sane values. */
export interface PageRequest {
  page: number;
  perPage: number;
  offset: number;
}

/** One page of a list plus what a client needs to render pagination. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
}

/** A positive integer from `value`, or `fallback` for missing/non-finite/< 1. */
function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored < 1 ? fallback : floored;
}

/**
 * Clamp `page`/`perPage` and derive the offset. The page is capped so
 * `(page - 1) * perPage` stays a safe integer for any caller, HTTP or not.
 */
export function pageRequest(options: { page?: number; perPage?: number } = {}): PageRequest {
  const perPage = Math.min(positiveInt(options.perPage, DEFAULT_LIST_PER_PAGE), MAX_LIST_PER_PAGE);
  const maxPage = Math.floor(Number.MAX_SAFE_INTEGER / perPage) + 1;
  const page = Math.min(positiveInt(options.page, 1), maxPage);
  return { page, perPage, offset: (page - 1) * perPage };
}

/** Assemble a {@link Page} from a fetched slice and the total count. */
export function toPage<T>(items: T[], total: number, { page, perPage }: PageRequest): Page<T> {
  return { items, total, page, perPage, pageCount: Math.ceil(total / perPage) };
}
