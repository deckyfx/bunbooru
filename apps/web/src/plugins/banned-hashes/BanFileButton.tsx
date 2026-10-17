import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Loader2 } from "lucide-react";

import { unwrap } from "../../lib/api";
import { authErrorMessage } from "../../lib/auth";
import { INPUT_CLASS } from "../../components/card-styles";
import type { SlotPropsMap } from "../slots";
import { BANS_KEY, bansApi } from "./client";

/**
 * The post page's moderator widget (`post-detail-aside`, moderators only):
 * whether this post's file is banned, and a control to ban or unban it. A ban
 * stops the file being uploaded again; the post itself stays.
 */
export function BanFileButton({ asset }: SlotPropsMap["post-detail-aside"]) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const statusKey = [...BANS_KEY, "asset", asset.id] as const;

  const status = useQuery({
    queryKey: statusKey,
    queryFn: async () => unwrap(await bansApi.assets({ id: String(asset.id) }).get()),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: BANS_KEY });
  const ban = useMutation({
    mutationFn: async () =>
      unwrap(await bansApi.bans.post({ assetId: asset.id, reason: reason.trim() || undefined })),
    onSuccess: () => {
      setReason("");
      refresh();
    },
  });
  const lift = useMutation({
    mutationFn: async (id: number) => {
      const res = await bansApi.bans({ id: String(id) }).delete();
      if (res.error) throw res.error;
    },
    onSuccess: refresh,
  });

  const current = status.data?.ban ?? null;
  const pending = ban.isPending || lift.isPending;
  const error = ban.error ?? lift.error;

  return (
    <div>
      <h3 className="mb-1 font-bold">File ban</h3>
      {status.isLoading ? (
        <p className="text-[12px] text-muted">…</p>
      ) : current ? (
        <div className="space-y-1 text-[12px]">
          <p className="text-tag-artist">Banned{current.reason ? `: ${current.reason}` : ""}</p>
          <button
            type="button"
            disabled={pending}
            onClick={() => lift.mutate(current.id)}
            className="flex items-center gap-1 rounded border border-line px-2 py-1 hover:border-link disabled:cursor-not-allowed disabled:opacity-60"
          >
            {lift.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            Lift ban
          </button>
        </div>
      ) : (
        <div className="space-y-1 text-[12px]">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="Reason (optional)"
            aria-label="Ban reason"
            className={INPUT_CLASS}
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => ban.mutate()}
            className="flex items-center gap-1 rounded border border-line px-2 py-1 hover:border-tag-artist hover:text-tag-artist disabled:cursor-not-allowed disabled:opacity-60"
          >
            {ban.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Ban className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Ban this file
          </button>
          <p className="text-[11px] text-muted">Blocks re-uploads of these exact bytes. The post stays.</p>
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-1 text-[12px] text-tag-artist">
          {authErrorMessage(error, "Couldn’t update the ban.")}
        </p>
      ) : null}
    </div>
  );
}
