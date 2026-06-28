import { Link, useParams } from "@tanstack/react-router";
import { Download, Heart } from "lucide-react";

import { SearchBox } from "../components/popover/search-box";
import { TagGroups } from "../components/tags/tag-groups";
import { postGradient, postMeta } from "../lib/post-fixtures";
import { postTags } from "../lib/tags";

export function PostDetailPage() {
  const { id } = useParams({ from: "/posts/$id" });
  const postId = Number(id) || 1;
  const tags = postTags(postId);
  const meta = postMeta(postId);

  return (
    <div className="flex gap-4">
      {/* Sidebar: search · tags (grouped) · information */}
      <aside className="w-64 shrink-0 space-y-4">
        <SearchBox placeholder="Search" className="w-full" />

        <div>
          <h3 className="mb-1 font-bold">Tags</h3>
          <TagGroups names={tags} />
        </div>

        <div>
          <h3 className="mb-1 font-bold">Information</h3>
          <dl className="space-y-0.5 text-[12px]">
            <Info label="ID" value={`#${postId}`} />
            <Info label="Size" value={`${meta.width} × ${meta.height}`} />
            <Info label="Rating" value={meta.rating} />
            <Info label="Score" value={`${meta.score}`} />
            <Info label="Favorites" value={`${meta.favorites}`} />
            <Info label="Posted" value="2026-06-28" />
            <Info label="Source" value="—" />
          </dl>
        </div>
      </aside>

      {/* Main: breadcrumb · image · comments */}
      <section className="min-w-0 flex-1">
        <div className="mb-2 text-[12px]">
          <Link to="/posts" className="hover:underline">
            « Back to posts
          </Link>
        </div>

        <div className="flex justify-center rounded border border-line bg-bg p-3">
          <div
            className="w-full max-w-2xl rounded"
            style={{
              aspectRatio: `${meta.width} / ${meta.height}`,
              background: postGradient(meta.hue),
            }}
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px]">
          <button
            className="flex items-center gap-1 rounded border border-line px-2 py-1 hover:border-link"
            disabled
          >
            <Heart className="h-3.5 w-3.5" /> Favorite
          </button>
          <button
            className="flex items-center gap-1 rounded border border-line px-2 py-1 hover:border-link"
            disabled
          >
            <Download className="h-3.5 w-3.5" /> Download
          </button>
          <span className="ml-auto text-muted">Image rendering is a placeholder.</span>
        </div>

        <div className="mt-6">
          <h3 className="mb-2 border-b border-line pb-1 font-bold">Comments</h3>
          <p className="mb-3 text-muted">No comments yet.</p>
          <form onSubmit={(e) => e.preventDefault()} className="max-w-2xl">
            <textarea
              rows={3}
              placeholder="Add a comment…"
              className="block w-full rounded border border-line p-2 text-[13px] outline-none focus:border-link"
            />
            <button
              type="submit"
              disabled
              className="mt-2 rounded bg-link px-4 py-1.5 text-white disabled:opacity-60"
            >
              Post comment (coming soon)
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
