import { useId, useState } from "react";

import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";

import type { AssetDto } from "@bunbooru/api";

import { authErrorMessage, useCurrentUser } from "../../lib/auth";
import { useRevertTags, useTagHistory, type TagVersionDto } from "../../lib/tags";

/** "2026-10-15 14:03" in the viewer's local time. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The tags one version added and removed, marked by more than colour alone. */
function VersionDiff({ version }: { version: TagVersionDto }) {
  if (version.added.length === 0 && version.removed.length === 0) {
    return <span className="text-muted">no change</span>;
  }
  return (
    <span className="font-mono break-words">
      {version.added.map((name) => (
        <span key={`+${name}`} className="mr-1 text-tag-character">
          <span className="sr-only">added </span>+{name}
        </span>
      ))}
      {version.removed.map((name) => (
        <span key={`-${name}`} className="mr-1 text-tag-artist line-through">
          <span className="sr-only">removed </span>−{name}
        </span>
      ))}
    </span>
  );
}

/**
 * The post-detail "Tag history" disclosure: every recorded edit to this post's
 * tags, newest first, with who made it. The uploader or an admin (the same rule
 * the server enforces) can restore an earlier version, which applies as a new
 * edit. Collapsed by default, so the history is only fetched on demand.
 */
export function TagHistoryPanel({ asset }: { asset: AssetDto }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { data: user } = useCurrentUser();
  const history = useTagHistory(asset.id, open);
  const revert = useRevertTags(asset.id);
  const canRevert = user != null && (user.role === "admin" || user.id === asset.uploaderId);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 font-bold"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        Tag history
      </button>

      {open ? (
        <div id={listId} className="mt-1 text-[12px]">
          {revert.isError ? (
            <p role="alert" className="mb-1 text-tag-artist">
              {authErrorMessage(revert.error, "Couldn’t restore that version.")}
            </p>
          ) : null}
          {history.isLoading ? (
            <p className="text-muted">Loading…</p>
          ) : history.isError ? (
            <p className="text-tag-artist">Couldn’t load the history.</p>
          ) : !history.data || history.data.length === 0 ? (
            <p className="text-muted">No recorded edits.</p>
          ) : (
            <ol className="space-y-1.5">
              {history.data.map((version, index) => (
                <li key={version.id} className="border-b border-line pb-1 last:border-0">
                  <div className="flex items-baseline gap-1 text-[11px] text-muted">
                    <time dateTime={version.createdAt}>{formatWhen(version.createdAt)}</time>
                    <span>· {version.editor ?? "system"}</span>
                    {/* The newest version IS the current set; restoring it is a no-op. */}
                    {canRevert && index > 0 ? (
                      <button
                        type="button"
                        disabled={revert.isPending}
                        onClick={() => revert.mutate(version.id)}
                        aria-label={`Restore the tags from ${formatWhen(version.createdAt)}`}
                        title="Restore these tags"
                        className="ml-auto flex items-center gap-0.5 text-link hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" aria-hidden="true" />
                        Restore
                      </button>
                    ) : null}
                  </div>
                  <VersionDiff version={version} />
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  );
}
