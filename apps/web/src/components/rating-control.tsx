import type { AssetDto } from "../lib/assets";

/** The four content-maturity ratings (mirrors the API `rating` enum). */
export type Rating = AssetDto["rating"];

export const RATING_OPTIONS: ReadonlyArray<{ value: Rating; label: string }> = [
  { value: "unrated", label: "Unrated" },
  { value: "safe", label: "Safe" },
  { value: "questionable", label: "Questionable" },
  { value: "explicit", label: "Explicit" },
];

/** Segmented rating picker, shared by the uploader and the post-detail editor. */
export function RatingControl({
  value,
  onChange,
  disabled,
}: {
  value: Rating;
  onChange: (rating: Rating) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex flex-wrap overflow-hidden rounded border border-line" role="group" aria-label="Rating">
      {RATING_OPTIONS.map((option, i) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`px-2 py-1 text-[12px] disabled:cursor-not-allowed disabled:opacity-60 ${
              i > 0 ? "border-l border-line" : ""
            } ${active ? "bg-link text-white" : "hover:text-link"}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
