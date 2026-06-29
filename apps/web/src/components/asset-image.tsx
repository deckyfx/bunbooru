import { useState, type CSSProperties } from "react";

/**
 * An asset image that degrades gracefully. A metadata row can outlive its stored
 * bytes (the API answers `404` from `/assets/:id/file`), so on a load error we
 * render an "unavailable" placeholder in the same box instead of the browser's
 * broken-image glyph. Shared by the gallery grid and the detail view so both
 * gate on actual file availability, not just the presence of a metadata row.
 */
export function AssetImage({
  src,
  alt,
  className,
  style,
  loading,
}: {
  src: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  loading?: "lazy" | "eager";
}) {
  const [failed, setFailed] = useState(false);

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
      src={src}
      alt={alt}
      loading={loading}
      className={className}
      style={style}
      onError={() => setFailed(true)}
    />
  );
}
