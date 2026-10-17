import { useId, useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";

import type { AssetDto } from "@bunbooru/api";

import { useDeleteAsset } from "../lib/assets";
import { authErrorMessage, useCurrentUser } from "../lib/auth";

/** Longest reason the API accepts (it 422s past this). */
const MAX_REASON_LENGTH = 500;

/**
 * The post page's "Delete post" control. Shown only to the uploader or an
 * admin (the rule the server enforces). Opens an inline confirm step with an
 * optional reason, says plainly that deletion is permanent, and on success
 * leaves for the gallery.
 */
export function DeletePostControl({ asset }: { asset: AssetDto }) {
  const { data: user } = useCurrentUser();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const warningId = useId();
  const remove = useDeleteAsset(asset.id, () => navigate({ to: "/posts" }));

  const canDelete = user != null && (user.role === "admin" || user.id === asset.uploaderId);
  if (!canDelete) return null;

  function open() {
    remove.reset(); // a previous failure shouldn't greet a fresh attempt
    setReason("");
    setConfirming(true);
  }

  function confirm() {
    // Guard double submits (a fast double click): one request per confirm.
    if (remove.isPending) return;
    remove.mutate(reason);
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={open}
        className="flex items-center gap-1 rounded border border-line px-2 py-1 text-tag-artist hover:border-tag-artist"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete post
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label="Confirm post deletion"
      className="w-full space-y-2 rounded border border-tag-artist p-2"
    >
      <p id={warningId} className="font-bold text-tag-artist">
        Delete post #{asset.id} permanently? Its file, tags and history are removed and this
        can’t be undone.
      </p>
      <div>
        <label htmlFor={reasonId} className="mb-1 block text-muted">
          Reason (optional)
        </label>
        <input
          id={reasonId}
          type="text"
          value={reason}
          maxLength={MAX_REASON_LENGTH}
          disabled={remove.isPending}
          onChange={(e) => setReason(e.target.value)}
          aria-describedby={warningId}
          placeholder="e.g. duplicate, wrong file"
          className="block w-full rounded border border-line p-1 outline-none focus:border-link disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>
      {remove.isError ? (
        <p role="alert" className="text-tag-artist">
          {authErrorMessage(remove.error, "Couldn’t delete this post. Please try again.")}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={confirm}
          disabled={remove.isPending}
          className="rounded border border-tag-artist px-3 py-1 font-bold text-tag-artist disabled:cursor-not-allowed disabled:opacity-60"
        >
          {remove.isPending ? "Deleting…" : "Delete permanently"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={remove.isPending}
          className="rounded border border-line px-3 py-1 hover:border-link"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
