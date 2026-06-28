import d0 from "../assets/counters/0.gif";
import d1 from "../assets/counters/1.gif";
import d2 from "../assets/counters/2.gif";
import d3 from "../assets/counters/3.gif";
import d4 from "../assets/counters/4.gif";
import d5 from "../assets/counters/5.gif";
import d6 from "../assets/counters/6.gif";
import d7 from "../assets/counters/7.gif";
import d8 from "../assets/counters/8.gif";
import d9 from "../assets/counters/9.gif";

/** Digit glyph GIFs indexed 0-9. */
const DIGITS = [d0, d1, d2, d3, d4, d5, d6, d7, d8, d9] as const;

/**
 * Odometer-style counter: renders each digit of `value` as its moe-counter GIF.
 * Non-digit characters are rendered as plain text. `digitClass` controls the
 * glyph height (default `h-12`).
 */
export function Counter({
  value,
  className,
  digitClass = "h-12",
}: {
  value: string;
  className?: string;
  digitClass?: string;
}) {
  return (
    <span
      role="img"
      aria-label={value}
      className={`inline-flex items-end gap-px ${className ?? ""}`}
    >
      {[...value].map((ch, i) => {
        const digit = DIGITS[ch.charCodeAt(0) - 48];
        return digit ? (
          <img key={i} src={digit} alt="" aria-hidden className={`${digitClass} w-auto`} />
        ) : (
          <span key={i} aria-hidden>
            {ch}
          </span>
        );
      })}
    </span>
  );
}
