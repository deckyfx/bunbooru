/**
 * Deterministic placeholder metadata for posts (static demo). Shared by the
 * gallery and the detail page so a tile's shape, hue, and score match its post.
 * Replaced by the Core post API in Phase 1.
 */

const RATINGS = ["General", "Sensitive", "Questionable", "Explicit"] as const;
export type Rating = (typeof RATINGS)[number];

export interface PostMeta {
  width: number;
  height: number;
  score: number;
  favorites: number;
  rating: Rating;
  /** Placeholder gradient hue. */
  hue: number;
}

/** Deterministic metadata for a post id, with mixed orientation. */
export function postMeta(id: number): PostMeta {
  const orientation = id % 3;
  const long = 1000 + ((id * 53) % 1200);
  const short = 680 + ((id * 31) % 480);
  const square = 820 + ((id * 37) % 560);

  const [width, height]: [number, number] =
    orientation === 0 ? [short, long] : orientation === 1 ? [long, short] : [square, square];

  return {
    width,
    height,
    score: (id * 37) % 500,
    favorites: (id * 13) % 200,
    rating: RATINGS[id % RATINGS.length] ?? "General",
    hue: (id * 47) % 360,
  };
}

/** CSS aspect-ratio string for a post's thumbnail. */
export function postRatio(id: number): string {
  const { width, height } = postMeta(id);
  return `${width} / ${height}`;
}

/** Placeholder gradient for a post's thumbnail. */
export function postGradient(hue: number): string {
  return `linear-gradient(135deg, hsl(${hue} 65% 78%), hsl(${(hue + 40) % 360} 60% 60%))`;
}
