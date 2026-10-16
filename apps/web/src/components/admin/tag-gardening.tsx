import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { ArrowRight, Loader2, Trash2 } from "lucide-react";

import { authErrorMessage } from "../../lib/auth";
import {
  useCreateTagAlias,
  useCreateTagImplication,
  useDeleteTagAlias,
  useDeleteTagImplication,
  useTagAliases,
  useTagImplications,
} from "../../lib/tag-gardening";
import { tagTextClass, type TagDto } from "../../lib/tags";
import { CARD_CLASS, INPUT_CLASS } from "../card-styles";

/** "kitty" / "cat" inputs plus submit, shared by both cards. */
function TagPairForm({
  submitLabel,
  pending,
  onSubmit,
}: {
  submitLabel: string;
  pending: boolean;
  onSubmit: (pair: { antecedent: string; consequent: string }) => void;
}) {
  const [antecedent, setAntecedent] = useState("");
  const [consequent, setConsequent] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    const a = antecedent.trim();
    const c = consequent.trim();
    if (!a || !c) return;
    onSubmit({ antecedent: a, consequent: c });
  }

  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <label className="block flex-1">
        <span className="mb-1 block text-[11px] font-bold text-muted">From</span>
        <input
          type="text"
          value={antecedent}
          onChange={(e) => setAntecedent(e.target.value)}
          className={INPUT_CLASS}
        />
      </label>
      <ArrowRight className="mb-2 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
      <label className="block flex-1">
        <span className="mb-1 block text-[11px] font-bold text-muted">To</span>
        <input
          type="text"
          value={consequent}
          onChange={(e) => setConsequent(e.target.value)}
          className={INPUT_CLASS}
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="flex shrink-0 items-center gap-1 rounded bg-link px-3 py-1.5 text-[12px] text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
        {submitLabel}
      </button>
    </form>
  );
}

/** Previous / next page controls for a list of `pageCount` pages. */
function Pager({
  page,
  pageCount,
  label,
  onPage,
}: {
  page: number;
  pageCount: number;
  label: string;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav aria-label={`${label} pages`} className="mt-2 flex items-center gap-2 text-[12px]">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="rounded border border-line px-2 py-0.5 hover:border-link disabled:cursor-not-allowed disabled:opacity-50"
      >
        Previous
      </button>
      <span className="text-muted">
        Page {page} of {pageCount}
      </span>
      <button
        type="button"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
        className="rounded border border-line px-2 py-0.5 hover:border-link disabled:cursor-not-allowed disabled:opacity-50"
      >
        Next
      </button>
    </nav>
  );
}

/** A tag name coloured by its category. */
function TagName({ tag }: { tag: TagDto }) {
  return <span className={tagTextClass(tag.category)}>{tag.name}</span>;
}

/** A list row: `from → to`, who made it, and a delete button. */
function RelationRow({
  from,
  to,
  creator,
  deleteLabel,
  deleting,
  onDelete,
}: {
  from: ReactNode;
  to: ReactNode;
  creator: string | null;
  deleteLabel: string;
  deleting: boolean;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-2 py-1">
      <span className="font-mono">{from}</span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
      <span className="font-mono">{to}</span>
      <span className="ml-auto text-[11px] text-muted">{creator ?? "—"}</span>
      <button
        type="button"
        aria-label={deleteLabel}
        title={deleteLabel}
        disabled={deleting}
        onClick={onDelete}
        className="rounded p-1 text-muted hover:text-tag-artist disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </li>
  );
}

/**
 * Pull `page` back into range when the list shrinks under it: deleting the last
 * row of the last page would otherwise strand the view on an empty page.
 */
function useKeepPageInRange(page: number, pageCount: number | undefined, setPage: (p: number) => void) {
  useEffect(() => {
    if (pageCount !== undefined && pageCount > 0 && page > pageCount) setPage(pageCount);
  }, [page, pageCount, setPage]);
}

/** Pluralize "post" for a count. */
const posts = (n: number) => `${n} post${n === 1 ? "" : "s"}`;

/** Aliases: `kitty` means `cat`; creating one retags every `kitty` post. */
export function TagAliasesCard() {
  const [page, setPage] = useState(1);
  const list = useTagAliases(page);
  useKeepPageInRange(page, list.data?.pageCount, setPage);
  const create = useCreateTagAlias();
  const remove = useDeleteTagAlias();

  return (
    <section className={`${CARD_CLASS} max-w-xl`} aria-labelledby="tag-aliases-heading">
      <h2 id="tag-aliases-heading" className="mb-1 text-base font-bold">
        Tag aliases
      </h2>
      <p className="mb-3 text-[12px] text-muted">
        The first name becomes the second everywhere. Every post tagged with it is retagged,
        searches for it find the other tag, and it can no longer be used as a tag. Deleting the
        alias later doesn’t move posts back.
      </p>

      <TagPairForm
        submitLabel="Add alias"
        pending={create.isPending}
        onSubmit={(pair) => create.mutate(pair)}
      />
      {create.isError ? (
        <p role="alert" className="mt-2 text-[12px] text-tag-artist">
          {authErrorMessage(create.error, "Couldn’t create the alias.")}
        </p>
      ) : null}
      {create.isSuccess ? (
        <p role="status" className="mt-2 text-[12px] text-tag-character">
          Aliased “{create.data.alias.antecedent}” to “{create.data.alias.consequent.name}”,
          retagging {posts(create.data.migratedPosts)}.
        </p>
      ) : null}
      {remove.isError ? (
        <p role="alert" className="mt-2 text-[12px] text-tag-artist">
          {authErrorMessage(remove.error, "Couldn’t delete the alias.")}
        </p>
      ) : null}

      <div className="mt-4">
        {list.isLoading ? (
          <p className="text-[12px] text-muted">Loading…</p>
        ) : list.isError ? (
          <p className="text-[12px] text-tag-artist">Couldn’t load aliases.</p>
        ) : !list.data || list.data.total === 0 ? (
          <p className="text-[12px] text-muted">No aliases yet.</p>
        ) : (
          <>
            <ul className="divide-y divide-line text-[12px]">
              {list.data.items.map((alias) => (
                <RelationRow
                  key={alias.antecedent}
                  from={alias.antecedent}
                  to={<TagName tag={alias.consequent} />}
                  creator={alias.creator}
                  deleteLabel={`Delete alias ${alias.antecedent} to ${alias.consequent.name}`}
                  deleting={remove.isPending}
                  onDelete={() => remove.mutate(alias.antecedent)}
                />
              ))}
            </ul>
            <Pager page={page} pageCount={list.data.pageCount} label="Alias" onPage={setPage} />
          </>
        )}
      </div>
    </section>
  );
}

/** Implications: `cat` implies `animal`; every `cat` post also gets `animal`. */
export function TagImplicationsCard() {
  const [page, setPage] = useState(1);
  const list = useTagImplications(page);
  useKeepPageInRange(page, list.data?.pageCount, setPage);
  const create = useCreateTagImplication();
  const remove = useDeleteTagImplication();

  return (
    <section className={`${CARD_CLASS} max-w-xl`} aria-labelledby="tag-implications-heading">
      <h2 id="tag-implications-heading" className="mb-1 text-base font-bold">
        Tag implications
      </h2>
      <p className="mb-3 text-[12px] text-muted">
        Posts with the first tag also get the second, and whatever that one implies in turn. Adding
        one tags existing posts too. Deleting it later leaves those tags in place.
      </p>

      <TagPairForm
        submitLabel="Add implication"
        pending={create.isPending}
        onSubmit={(pair) => create.mutate(pair)}
      />
      {create.isError ? (
        <p role="alert" className="mt-2 text-[12px] text-tag-artist">
          {authErrorMessage(create.error, "Couldn’t create the implication.")}
        </p>
      ) : null}
      {create.isSuccess ? (
        <p role="status" className="mt-2 text-[12px] text-tag-character">
          “{create.data.implication.antecedent.name}” now implies “
          {create.data.implication.consequent.name}”; {posts(create.data.backfilledPosts)} gained
          tags.
        </p>
      ) : null}
      {remove.isError ? (
        <p role="alert" className="mt-2 text-[12px] text-tag-artist">
          {authErrorMessage(remove.error, "Couldn’t delete the implication.")}
        </p>
      ) : null}

      <div className="mt-4">
        {list.isLoading ? (
          <p className="text-[12px] text-muted">Loading…</p>
        ) : list.isError ? (
          <p className="text-[12px] text-tag-artist">Couldn’t load implications.</p>
        ) : !list.data || list.data.total === 0 ? (
          <p className="text-[12px] text-muted">No implications yet.</p>
        ) : (
          <>
            <ul className="divide-y divide-line text-[12px]">
              {list.data.items.map((implication) => (
                <RelationRow
                  key={`${implication.antecedent.name}>${implication.consequent.name}`}
                  from={<TagName tag={implication.antecedent} />}
                  to={<TagName tag={implication.consequent} />}
                  creator={implication.creator}
                  deleteLabel={`Delete implication ${implication.antecedent.name} to ${implication.consequent.name}`}
                  deleting={remove.isPending}
                  onDelete={() =>
                    remove.mutate({
                      antecedent: implication.antecedent.name,
                      consequent: implication.consequent.name,
                    })
                  }
                />
              ))}
            </ul>
            <Pager
              page={page}
              pageCount={list.data.pageCount}
              label="Implication"
              onPage={setPage}
            />
          </>
        )}
      </div>
    </section>
  );
}
