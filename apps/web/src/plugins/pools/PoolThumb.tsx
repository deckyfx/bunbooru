import { AssetImage } from "../../components/asset-image";
import { assetFileUrl, assetThumbUrl } from "../../lib/api";
import { usePlugins } from "../../lib/plugins";

/**
 * A post's thumbnail for pool views: the thumbnailer's image when that plugin
 * is active, otherwise the full image (falling back to it on a missing thumb).
 */
export function PoolThumb({ assetId, alt, className }: { assetId: number; alt: string; className?: string }) {
  const { data: plugins, isLoading } = usePlugins();
  if (isLoading) return <div className={`animate-pulse bg-line/40 ${className ?? ""}`} aria-hidden="true" />;
  const hasThumbs = plugins?.some((p) => p.id === "thumbnailer") ?? false;
  return (
    <AssetImage
      src={hasThumbs ? assetThumbUrl(assetId) : assetFileUrl(assetId)}
      fallbackSrc={hasThumbs ? assetFileUrl(assetId) : undefined}
      alt={alt}
      loading="lazy"
      className={className}
    />
  );
}
