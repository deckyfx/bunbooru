const RATINGS = [
  { value: "g", label: "General" },
  { value: "s", label: "Sensitive" },
  { value: "q", label: "Questionable" },
  { value: "e", label: "Explicit" },
] as const;

export function UploadPage() {
  return (
    <div>
      <h1 className="mb-3 border-b border-line pb-1 text-base font-bold">Upload</h1>

      <form
        onSubmit={(e) => e.preventDefault()}
        className="flex flex-col gap-4 md:flex-row"
      >
        {/* Preview / source column */}
        <div className="md:w-72 md:shrink-0">
          <div className="flex aspect-square items-center justify-center rounded border-2 border-dashed border-line bg-bg text-center text-muted">
            Drop a file or paste a URL
          </div>
          <label className="mt-2 block">
            <span className="text-[12px] font-bold">File</span>
            <input type="file" className="mt-1 block w-full text-[12px]" />
          </label>
          <label className="mt-2 block">
            <span className="text-[12px] font-bold">Source URL</span>
            <input
              type="url"
              placeholder="https://..."
              className="mt-1 block w-full rounded border border-line p-1.5 text-[12px] outline-none focus:border-link"
            />
          </label>
        </div>

        {/* Metadata column */}
        <div className="flex-1 space-y-3">
          <label className="block">
            <span className="text-[12px] font-bold">Tags</span>
            <textarea
              rows={4}
              placeholder="1girl long_hair original ..."
              className="mt-1 block w-full rounded border border-line p-2 font-mono text-[12px] outline-none focus:border-link"
            />
            <span className="text-[11px] text-muted">
              Space-separated. Autocomplete coming soon.
            </span>
          </label>

          <fieldset>
            <legend className="text-[12px] font-bold">Rating</legend>
            <div className="mt-1 flex flex-wrap gap-4">
              {RATINGS.map((r, i) => (
                <label key={r.value} className="flex items-center gap-1 text-[12px]">
                  <input type="radio" name="rating" value={r.value} defaultChecked={i === 0} />
                  {r.label}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="block">
            <span className="text-[12px] font-bold">Parent post ID</span>
            <input
              type="text"
              placeholder="optional"
              className="mt-1 block w-40 rounded border border-line p-1.5 text-[12px] outline-none focus:border-link"
            />
          </label>

          <button
            type="submit"
            disabled
            className="rounded bg-link px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            Upload (coming soon)
          </button>
        </div>
      </form>
    </div>
  );
}
