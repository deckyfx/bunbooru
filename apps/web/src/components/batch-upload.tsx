import { useEffect, useState } from "react";

import { Link } from "@tanstack/react-router";
import { Check, Copy, Loader2, X } from "lucide-react";

import { uploadAsset } from "../lib/upload";

type Row =
  | { state: "queued" }
  | { state: "uploading"; progress: number }
  | { state: "done"; assetId: number; deduped: boolean }
  | { state: "failed"; error: string };

/**
 * Several files at once (a multi-file drop, a share of many images): uploads
 * them one after another, each row showing its outcome and linking to the
 * post. Tagging happens afterwards, from the untagged queue.
 */
export function BatchUpload({ files, onDone }: { files: File[]; onDone: () => void }) {
  const [rows, setRows] = useState<Row[]>(() => files.map(() => ({ state: "queued" })));

  useEffect(() => {
    const controller = new AbortController();
    const update = (index: number, row: Row) =>
      setRows((prev) => prev.map((existing, i) => (i === index ? row : existing)));
    // Started on a timer the cleanup cancels: under StrictMode's mount →
    // unmount → mount, only the second mount's run actually starts uploading.
    const timer = setTimeout(async () => {
      for (const [index, file] of files.entries()) {
        if (controller.signal.aborted) return;
        update(index, { state: "uploading", progress: 0 });
        try {
          const result = await uploadAsset(file, {
            signal: controller.signal,
            onProgress: (progress) => update(index, { state: "uploading", progress }),
          });
          update(index, { state: "done", assetId: result.asset.id, deduped: result.deduped });
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          update(index, { state: "failed", error: error instanceof Error ? error.message : "Upload failed" });
        }
      }
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [files]);

  const finished = rows.every((row) => row.state === "done" || row.state === "failed");

  return (
    <div className="mx-auto max-w-xl space-y-3">
      <ul className="divide-y divide-line rounded border border-line bg-surface">
        {files.map((file, index) => {
          const row = rows[index] ?? { state: "queued" };
          return (
            <li key={`${file.name}-${index}`} className="flex items-center gap-2 px-3 py-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate">{file.name || `image ${index + 1}`}</span>
              {row.state === "queued" ? <span className="text-muted">waiting</span> : null}
              {row.state === "uploading" ? (
                <span className="flex items-center gap-1 text-muted">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  {Math.round(row.progress * 100)}%
                </span>
              ) : null}
              {row.state === "done" ? (
                <Link
                  to="/posts/$id"
                  params={{ id: String(row.assetId) }}
                  className="flex items-center gap-1 text-link hover:underline"
                >
                  {row.deduped ? (
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {row.deduped ? "already in the library" : `post #${row.assetId}`}
                </Link>
              ) : null}
              {row.state === "failed" ? (
                <span className="flex items-center gap-1 text-tag-artist" title={row.error}>
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  {row.error}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {finished ? (
        <div className="flex justify-center gap-3 text-[12px]">
          <button type="button" onClick={onDone} className="text-link hover:underline">
            Upload more
          </button>
        </div>
      ) : null}
    </div>
  );
}
