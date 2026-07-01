import { useSiteStats } from "../lib/stats";

/** Zero-pad width for the classic odometer look. */
const WIDTH = 7;

/**
 * Retro visitor counter — renders today's unique-visitor total (from `GET
 * /stats`) as a zero-padded text odometer. Visits are recorded server-side once
 * per app load (see `useRecordVisit` in the root layout) and deduped per day, so
 * this just reflects the real count.
 */
export function VisitorCounter() {
  const { data } = useSiteStats();
  if (!data) return null;

  return (
    <span className="inline-flex items-center gap-1.5">
      <span>Visitors today:</span>
      <span className="font-mono font-semibold tracking-wider tabular-nums text-ink">
        {String(data.visitorsToday).padStart(WIDTH, "0")}
      </span>
    </span>
  );
}
