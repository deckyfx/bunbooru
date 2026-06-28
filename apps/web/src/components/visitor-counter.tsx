import { useEffect, useState } from "react";

const STORAGE_KEY = "bunbooru:visits";

/** Once-per-app-boot guard so StrictMode's double-invoked effect counts once. */
let counted = false;
/** Demo starting point so the odometer looks established. */
const SEED = 13370;
/** Zero-pad width for the classic odometer look. */
const WIDTH = 7;

/**
 * Retro visitor counter. Increments once per app load (per browser, via
 * localStorage) and renders the total as a zero-padded text odometer.
 * Purely client-side until a real analytics endpoint exists.
 */
export function VisitorCounter() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    const valid = Number.isFinite(stored) && stored > 0;

    // Already counted this boot (e.g. StrictMode's second effect run): just show.
    if (counted) {
      setCount(valid ? stored : SEED + 1);
      return;
    }
    counted = true;

    const next = (valid ? stored : SEED) + 1;
    localStorage.setItem(STORAGE_KEY, String(next));
    setCount(next);
  }, []);

  if (count === null) return null;

  return (
    <span className="inline-flex items-center gap-1.5">
      <span>Visitors:</span>
      <span className="font-mono font-semibold tracking-wider tabular-nums text-ink">
        {String(count).padStart(WIDTH, "0")}
      </span>
    </span>
  );
}
