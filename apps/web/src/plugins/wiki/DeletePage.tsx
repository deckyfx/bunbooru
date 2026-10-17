import { useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { authErrorMessage } from "../../lib/auth";
import { pageKey, WIKI_KEY, wikiPage } from "./client";

/** An admin's Delete for a page and its whole history, behind an inline confirm step. */
export function DeletePage({ title }: { title: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const remove = useMutation({
    mutationFn: async () => {
      const res = await wikiPage(title).delete();
      if (res.error) throw res.error;
    },
    onSuccess: () => {
      queryClient.setQueryData(pageKey(title), null);
      void queryClient.invalidateQueries({ queryKey: WIKI_KEY });
      void navigate({ to: "/wiki" });
    },
  });

  return (
    <div className="text-[12px]">
      {confirming ? (
        <div role="group" aria-label="Confirm page deletion" className="flex flex-wrap items-center gap-2">
          <span className="text-tag-artist">Delete this page and its whole history?</span>
          <button
            type="button"
            onClick={() => {
              if (!remove.isPending) remove.mutate();
            }}
            disabled={remove.isPending}
            className="rounded border border-tag-artist px-2 py-0.5 font-bold text-tag-artist disabled:cursor-not-allowed disabled:opacity-60"
          >
            {remove.isPending ? "Deleting…" : "Delete"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={remove.isPending}
            className="rounded border border-line px-2 py-0.5 hover:border-link"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            remove.reset();
            setConfirming(true);
          }}
          className="rounded border border-line px-2 py-0.5 text-tag-artist hover:border-tag-artist"
        >
          Delete page
        </button>
      )}
      {remove.isError ? (
        <p role="alert" className="mt-1 text-tag-artist">
          {authErrorMessage(remove.error, "Couldn’t delete the page.")}
        </p>
      ) : null}
    </div>
  );
}
