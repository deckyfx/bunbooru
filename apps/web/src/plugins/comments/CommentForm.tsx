import { useState, type FormEvent } from "react";

import { Loader2 } from "lucide-react";

import { INPUT_CLASS } from "../../components/card-styles";
import { authErrorMessage } from "../../lib/auth";
import { MAX_BODY } from "./client";

/**
 * A comment text box with a submit button (and optionally Cancel), shared by
 * "post a comment" and "edit". The parent owns the mutation; this owns the
 * draft, and clears it after a successful post when `clearOnSuccess` is set.
 */
export function CommentForm({
  initial = "",
  label,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
  clearOnSuccess = false,
}: {
  initial?: string;
  label: string;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
  clearOnSuccess?: boolean;
}) {
  const [draft, setDraft] = useState(initial);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || pending) return;
    try {
      await onSubmit(body);
      if (clearOnSuccess) setDraft("");
    } catch {
      // `error` (the parent's mutation state) drives the message; keep the draft.
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-1 text-[12px]">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={MAX_BODY}
        rows={3}
        required
        aria-label={label}
        className={INPUT_CLASS}
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || !draft.trim()}
          className="flex items-center gap-1 rounded bg-link px-3 py-1 text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          {submitLabel}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded border border-line px-3 py-1 hover:border-link disabled:opacity-60"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-tag-artist">
          {authErrorMessage(error, "Couldn’t save the comment.")}
        </p>
      ) : null}
    </form>
  );
}
