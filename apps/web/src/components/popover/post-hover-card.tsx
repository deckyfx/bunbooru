import type { AssetDto } from "../../lib/assets";

/**
 * Gallery-tile hover card. Shows the post's identity and the metadata we have
 * today; the tag list lands here once tagging is implemented (mirrors the
 * "No tags yet." placeholder used on the detail page and sidebar).
 */
export function PostHoverCard({ asset }: { asset: AssetDto }) {
  return (
    <div className="w-56 rounded-md border border-line bg-surface p-3 text-[12px] shadow-lg">
      <div className="mb-2 border-b border-line pb-1 font-bold">post #{asset.id}</div>
      <dl className="space-y-0.5">
        <Row label="Size" value={`${asset.width} × ${asset.height}`} />
        <Row label="Rating" value={asset.rating} />
        <Row label="Type" value={asset.mimeType} />
      </dl>
      <p className="mt-2 text-muted">No tags yet.</p>
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
