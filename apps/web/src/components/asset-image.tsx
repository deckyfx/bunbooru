import { useEffect, useState, type CSSProperties } from "react";

/**
 * An asset image that degrades gracefully. Two fallbacks:
 *
 * 1. If `fallbackSrc` is given and `src` fails to load, retry with `fallbackSrc`
 *    (used for thumbnails: try the thumbnailer's webp, fall back to the full
 *    image when no thumbnail exists yet or the plugin is disabled).
 * 2. If that also fails — a metadata row can outlive its stored bytes (the API
 *    answers `404` from `/assets/:id/file`) — render an "unavailable" placeholder
 *    in the same box instead of the browser's broken-image glyph.
 *
 * Shared by the gallery grid and the detail view so both gate on actual file
 * availability, not just the presence of a metadata row.
 */
export function AssetImage({
  src,
  fallbackSrc,
  alt,
  className,
  style,
  loading,
}: {
  src: string;
  /** Optional second source tried once if `src` errors (e.g. the full image). */
  fallbackSrc?: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  loading?: "lazy" | "eager";
}) {
  const [currentSrc, setCurrentSrc] = useState(src);
  const [failed, setFailed] = useState(false);

  // Reset on src change so a reused instance retries the new asset instead of
  // staying stuck on the placeholder / fallback from a previous asset.
  useEffect(() => {
    setCurrentSrc(src);
    setFailed(false);
  }, [src]);

  function handleError() {
    // First error on the primary src → try the fallback; a further error (or no
    // fallback) → the unavailable placeholder.
    if (fallbackSrc && currentSrc !== fallbackSrc) {
      setCurrentSrc(fallbackSrc);
    } else {
      setFailed(true);
    }
  }

  if (failed) {
    return (
      <div className={className} style={style} role="img" aria-label={`${alt} (image unavailable)`}>
        <span className="flex h-full w-full items-center justify-center text-[11px] text-muted">
          Image unavailable
        </span>
      </div>
    );
  }

  return (
    <img
      src={currentSrc}
      alt={alt}
      loading={loading}
      className={className}
      style={style}
      onError={handleError}
    />
  );
}
