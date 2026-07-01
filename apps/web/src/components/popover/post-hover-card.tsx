import type { AssetDto } from "../../lib/assets";
import { CATEGORY_ORDER, groupTagsByCategory, useAssetTags } from "../../lib/tags";
import { TagLink } from "../tags/tag-link";

/**
 * Gallery-tile hover card: the post's identity + metadata and its real tags
 * (fetched lazily — this only mounts while the tile popover is open), grouped by
 * category. Tags are clickable (→ filtered gallery) but skip their own nested
 * popover to avoid stacking hover cards.
 */
export function PostHoverCard({ asset }: { asset: AssetDto }) {
  const { data: tags, isLoading, isError } = useAssetTags(asset.id);
  const grouped = groupTagsByCategory(tags ?? []);

  return (
    <div className="w-56 rounded-md border border-line bg-surface p-3 text-[12px] shadow-lg">
      <div className="mb-2 border-b border-line pb-1 font-bold">post #{asset.id}</div>
      <dl className="space-y-0.5">
        <Row label="Size" value={`${asset.width} × ${asset.height}`} />
        <Row label="Rating" value={asset.rating} />
        <Row label="Type" value={asset.mimeType} />
      </dl>

      <div className="mt-2">
        {isLoading ? (
          <p className="text-muted">Loading tags…</p>
        ) : isError ? (
          <p className="text-muted">Couldn’t load tags.</p>
        ) : !tags || tags.length === 0 ? (
          <p className="text-muted">No tags yet.</p>
        ) : (
          <div className="space-y-1">
            {CATEGORY_ORDER.filter((category) => grouped.has(category)).map((category) => (
              <ul key={category} className="flex flex-wrap gap-x-2 gap-y-0.5">
                {grouped.get(category)?.map((tag) => (
                  <li key={tag.name}>
                    <TagLink tag={tag} popover={false} />
                  </li>
                ))}
              </ul>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-right">{value}</dd>
    </div>
  );
}
