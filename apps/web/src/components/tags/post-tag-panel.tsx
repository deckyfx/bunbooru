import { useEffect, useMemo, useState } from "react";

import { useIsLoggedIn } from "../../lib/auth";
import {
  CATEGORY_ORDER,
  TAG_CATEGORY_LABEL,
  formatCount,
  tagTextClass,
  useAssetTags,
  useSetAssetTags,
  useTagAutocomplete,
  type TagDto,
} from "../../lib/tags";
import { TagLink } from "./tag-link";

/** Split a raw tag-edit string into whitespace-delimited tokens. */
function tokens(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * The post-detail "Tags" panel: shows an asset's real tags grouped by category
 * (read), with an inline editor that submits the whole space-separated list
 * (Danbooru-style) through `PATCH /assets/:id/tags`, plus prefix autocomplete on
 * the token being typed.
 */
export function PostTagPanel({ assetId }: { assetId: number }) {
  const { data: tags, isLoading, isError } = useAssetTags(assetId);
  const setTags = useSetAssetTags(assetId);
  // Tag editing hits a gated write route; only offer it to signed-in users.
  const isLoggedIn = useIsLoggedIn();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  // Seed the editor from the server's tags whenever the asset changes or its
  // tags (re)load — but never while editing, so an in-progress edit isn't
  // clobbered by a background refetch.
  useEffect(() => {
    if (!editing && tags) setText(tags.map((t) => t.name).join(" "));
  }, [tags, editing]);
  useEffect(() => {
    setEditing(false);
  }, [assetId]);
  // If auth drops mid-edit (logout in another tab, session expiry), close the
  // editor and discard the draft instead of leaving a form that only 401s on save.
  useEffect(() => {
    if (!isLoggedIn) {
      setTags.reset();
      setText((tags ?? []).map((t) => t.name).join(" "));
      setEditing(false);
    }
  }, [isLoggedIn, tags, setTags]);

  const grouped = useMemo(() => {
    const map = new Map<TagDto["category"], TagDto[]>();
    for (const tag of tags ?? []) {
      const list = map.get(tag.category) ?? [];
      list.push(tag);
      map.set(tag.category, list);
    }
    return map;
  }, [tags]);

  // Autocomplete the last token being typed.
  const lastToken = editing ? (tokens(text).at(-1) ?? "") : "";
  // Only suggest once the editor text doesn't end in a separator (i.e. a token
  // is actively being typed), so finished tags don't keep showing a dropdown.
  const typing = editing && text.length > 0 && !/\s$/.test(text);
  const { data: suggestions } = useTagAutocomplete(typing ? lastToken : "");

  function applySuggestion(name: string): void {
    const parts = tokens(text);
    parts[parts.length - 1] = name;
    setText(`${parts.join(" ")} `);
  }

  async function save(): Promise<void> {
    try {
      await setTags.mutateAsync(tokens(text));
      setEditing(false);
    } catch {
      // setTags.isError drives the inline message; stay in edit mode.
    }
  }

  function cancel(): void {
    setTags.reset();
    setText((tags ?? []).map((t) => t.name).join(" "));
    setEditing(false);
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-bold">Tags</h3>
        {editing || !isLoggedIn ? null : (
          <button
            type="button"
            onClick={() => {
              setTags.reset();
              setEditing(true);
            }}
            className="text-[11px] text-link hover:underline"
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2 text-[12px]">
          <div className="relative">
            <textarea
              aria-label="Tags (space-separated)"
              rows={5}
              disabled={setTags.isPending}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="space_separated tags…"
              className="block w-full rounded border border-line p-1 font-mono outline-none focus:border-link disabled:cursor-not-allowed disabled:opacity-60"
            />
            {typing && suggestions && suggestions.length > 0 ? (
              <ul className="absolute z-10 mt-0.5 max-h-48 w-full overflow-auto rounded border border-line bg-bg shadow">
                {suggestions.map((tag) => (
                  <li key={tag.name}>
                    <button
                      type="button"
                      onClick={() => applySuggestion(tag.name)}
                      className="flex w-full items-baseline gap-1 px-2 py-0.5 text-left hover:bg-line/40"
                    >
                      <span className={tagTextClass(tag.category)}>{tag.name}</span>
                      <span className="ml-auto text-[11px] text-muted">
                        {formatCount(tag.postCount)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {setTags.isError ? (
            <p className="text-tag-artist">Couldn’t save tags. Please try again.</p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={setTags.isPending}
              className="rounded bg-link px-3 py-1 text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              Save
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={setTags.isPending}
              className="rounded border border-line px-3 py-1 hover:border-link"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : isLoading ? (
        <p className="text-[12px] text-muted">Loading…</p>
      ) : isError ? (
        <p className="text-[12px] text-tag-artist">Couldn’t load tags right now. Please try again.</p>
      ) : !tags || tags.length === 0 ? (
        <p className="text-[12px] text-muted">No tags yet.</p>
      ) : (
        <div className="space-y-2">
          {CATEGORY_ORDER.filter((category) => grouped.has(category)).map((category) => (
            <div key={category}>
              <div className="text-[11px] font-bold text-muted">{TAG_CATEGORY_LABEL[category]}</div>
              <ul className="space-y-0.5">
                {grouped.get(category)?.map((tag) => (
                  <li key={tag.name} className="flex items-baseline gap-1 leading-tight">
                    <TagLink tag={tag} />
                    <span className="ml-auto text-[11px] text-muted">
                      {formatCount(tag.postCount)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
