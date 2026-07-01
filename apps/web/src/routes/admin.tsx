import { useEffect, useRef, useState, type FormEvent } from "react";

import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import { authErrorMessage, useCurrentUser } from "../lib/auth";
import { useUpdateUploadLimits, useUploadLimits } from "../lib/settings";
import {
  CATEGORY_ORDER,
  TAG_CATEGORY_LABEL,
  useSetTagCategory,
  type TagCategory,
} from "../lib/tags";

/** Human-readable byte size for the caps hint. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const INPUT_CLASS =
  "block w-full rounded border border-line p-1.5 text-[12px] outline-none focus:border-link";

/**
 * Superadmin console: edit the runtime upload caps and set tag categories.
 * Admin-only — redirects non-admins home once auth resolves (the server also
 * enforces this on every route).
 */
export function AdminPage() {
  const { data: user, isPending } = useCurrentUser();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isPending && user?.role !== "admin") void navigate({ to: "/" });
  }, [isPending, user, navigate]);

  if (isPending || user?.role !== "admin") return null;

  return (
    <div className="mx-auto max-w-lg space-y-8">
      <h1 className="border-b border-line pb-1 text-base font-bold">Admin</h1>
      <UploadLimitsSection />
      <TagCategorySection />
    </div>
  );
}

/** Edit the one-shot + resumable upload caps (bytes). */
function UploadLimitsSection() {
  const limits = useUploadLimits();
  const update = useUpdateUploadLimits();
  const [maxUpload, setMaxUpload] = useState("");
  const [maxResumable, setMaxResumable] = useState("");
  const seeded = useRef(false);

  // Seed the inputs from the server values ONCE — a later background refetch
  // (e.g. on window refocus) must not overwrite in-progress edits.
  useEffect(() => {
    if (limits.data && !seeded.current) {
      setMaxUpload(String(limits.data.maxUploadBytes));
      setMaxResumable(String(limits.data.maxResumableUploadBytes));
      seeded.current = true;
    }
  }, [limits.data]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (update.isPending) return;
    const patch: { maxUploadBytes?: number; maxResumableUploadBytes?: number } = {};
    const mu = Number(maxUpload);
    const mr = Number(maxResumable);
    if (Number.isSafeInteger(mu) && mu >= 1) patch.maxUploadBytes = mu;
    if (Number.isSafeInteger(mr) && mr >= 1) patch.maxResumableUploadBytes = mr;
    update.mutate(patch);
  }

  return (
    <section>
      <h2 className="mb-2 font-bold">Upload limits</h2>
      {limits.isLoading ? (
        <p className="text-[12px] text-muted">Loading…</p>
      ) : limits.isError ? (
        <p role="alert" className="text-[12px] text-tag-artist">
          Couldn’t load settings. Please try again.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block font-bold">One-shot upload cap (bytes)</span>
            <input
              type="number"
              min={1}
              value={maxUpload}
              onChange={(e) => setMaxUpload(e.target.value)}
              className={INPUT_CLASS}
            />
            <span className="mt-1 block text-[11px] text-muted">
              {maxUpload ? formatBytes(Number(maxUpload)) : "—"} · `POST /assets`
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block font-bold">Resumable upload cap (bytes)</span>
            <input
              type="number"
              min={1}
              value={maxResumable}
              onChange={(e) => setMaxResumable(e.target.value)}
              className={INPUT_CLASS}
            />
            <span className="mt-1 block text-[11px] text-muted">
              {maxResumable ? formatBytes(Number(maxResumable)) : "—"} · chunked uploads
            </span>
          </label>

          {update.isError ? (
            <p role="alert" className="text-[12px] text-tag-artist">
              {authErrorMessage(update.error, "Couldn’t save. Please check the values.")}
            </p>
          ) : null}
          {update.isSuccess ? <p className="text-[12px] text-tag-character">Saved.</p> : null}

          <button
            type="submit"
            disabled={update.isPending}
            className="flex items-center justify-center gap-1 rounded bg-link px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Save limits
          </button>
        </form>
      )}
    </section>
  );
}

/** Set a tag's category (taxonomy management). */
function TagCategorySection() {
  const setTagCategory = useSetTagCategory();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<TagCategory>("general");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (setTagCategory.isPending) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setTagCategory.mutate({ name: trimmed, category });
  }

  return (
    <section>
      <h2 className="mb-2 font-bold">Tag category</h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block font-bold">Tag name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. hatsune_miku"
            className={INPUT_CLASS}
          />
        </label>

        <label className="block">
          <span className="mb-1 block font-bold">Category</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as TagCategory)}
            className={INPUT_CLASS}
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {TAG_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>

        {setTagCategory.isError ? (
          <p role="alert" className="text-[12px] text-tag-artist">
            {authErrorMessage(setTagCategory.error, "Couldn’t update the tag (does it exist?).")}
          </p>
        ) : null}
        {setTagCategory.isSuccess ? (
          <p className="text-[12px] text-tag-character">Updated.</p>
        ) : null}

        <button
          type="submit"
          disabled={setTagCategory.isPending}
          className="flex items-center justify-center gap-1 rounded bg-link px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {setTagCategory.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          Set category
        </button>
      </form>
    </section>
  );
}
