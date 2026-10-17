import { useMemo, useState, type FormEvent } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { tokenize } from "@bunbooru/plugin-wiki/markup";

import { INPUT_CLASS } from "../../components/card-styles";
import { unwrap } from "../../lib/api";
import { authErrorMessage } from "../../lib/auth";
import { fetchPage, isStaleEdit, MAX_BODY, pageKey, WIKI_KEY, wikiPage, type WikiPageDto } from "./client";
import { WikiBody } from "./WikiBody";

/**
 * The Edit tab: a page's text (empty for a new page) with a preview. Saves
 * against the version it was opened at, so if someone else saved in between
 * the server answers 409 and this offers to load their version instead of
 * silently overwriting it.
 */
export function WikiEditor({ title, page, onDone }: { title: string; page: WikiPageDto | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(page?.body ?? "");
  // The version this draft is based on; 0 = the page didn't exist.
  const [baseVersion, setBaseVersion] = useState(page?.version ?? 0);
  const [previewing, setPreviewing] = useState(false);
  const [reloading, setReloading] = useState(false);
  const preview = useMemo(() => (previewing ? tokenize(draft.trim()) : []), [previewing, draft]);

  const save = useMutation({
    mutationFn: async (body: string) => unwrap(await wikiPage(title).put({ body, baseVersion })),
    onSuccess: (saved) => {
      queryClient.setQueryData(pageKey(title), saved);
      void queryClient.invalidateQueries({ queryKey: WIKI_KEY });
      onDone();
    },
  });

  /** Replace the draft with the page as it is now (after a 409). */
  async function reload() {
    setReloading(true);
    try {
      const latest = await queryClient.fetchQuery({ queryKey: pageKey(title), queryFn: () => fetchPage(title), staleTime: 0 });
      setDraft(latest?.body ?? "");
      setBaseVersion(latest?.version ?? 0);
      save.reset();
    } finally {
      setReloading(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (body && !save.isPending) save.mutate(body);
  }

  const stale = save.isError && isStaleEdit(save.error);

  return (
    <form onSubmit={onSubmit} className="max-w-3xl space-y-2 text-[12px]">
      <p className="text-muted">
        Plain text. <code>[[Title]]</code> links another wiki page; <code>{"{{tag}}"}</code> links a search for a tag.
      </p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={MAX_BODY}
        rows={14}
        required
        aria-label={`Text of the wiki page ${title}`}
        className={`${INPUT_CLASS} font-mono`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={save.isPending || !draft.trim()}
          className="flex items-center gap-1 rounded bg-link px-3 py-1 text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          {page ? "Save" : "Create page"}
        </button>
        <button
          type="button"
          onClick={() => setPreviewing((p) => !p)}
          aria-pressed={previewing}
          className="rounded border border-line px-3 py-1 hover:border-link"
        >
          Preview
        </button>
        <button type="button" onClick={onDone} disabled={save.isPending} className="rounded border border-line px-3 py-1 hover:border-link">
          Cancel
        </button>
        <span className="ml-auto text-muted">
          {draft.length.toLocaleString()} / {MAX_BODY.toLocaleString()}
        </span>
      </div>

      {stale ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-tag-artist p-2 text-tag-artist">
          <span>Someone changed this page since you opened it. Copy your text if you want to keep it, then load their version.</span>
          <button
            type="button"
            onClick={() => void reload()}
            disabled={reloading}
            className="rounded border border-tag-artist px-2 py-0.5 font-bold disabled:opacity-60"
          >
            {reloading ? "Loading…" : "Load the latest version"}
          </button>
        </div>
      ) : save.isError ? (
        <p role="alert" className="text-tag-artist">
          {authErrorMessage(save.error, "Couldn’t save the page.")}
        </p>
      ) : null}

      {previewing ? (
        <section aria-label="Preview" className="rounded border border-dashed border-line p-3">
          {preview.length > 0 ? <WikiBody tokens={preview} /> : <p className="text-muted">Nothing to preview.</p>}
        </section>
      ) : null}
    </form>
  );
}
