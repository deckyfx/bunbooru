import { useState, type ReactNode } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";

import { unwrap } from "../../lib/api";
import { authErrorMessage } from "../../lib/auth";
import { CommentForm } from "./CommentForm";
import { COMMENTS_KEY, commentsApi, type CommentDto } from "./client";

const ICON_BUTTON_CLASS =
  "rounded p-1 text-muted hover:bg-bg hover:text-link disabled:cursor-not-allowed disabled:opacity-60";

/**
 * One comment: author, when, and the body as plain text (newlines kept; never
 * parsed as HTML). Its author or an admin gets Edit and Delete. `context`
 * renders above the body (the recent feed's link to the post).
 */
export function CommentItem({ comment, context }: { comment: CommentDto; context?: ReactNode }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: COMMENTS_KEY });

  const save = useMutation({
    mutationFn: async (body: string) => unwrap(await commentsApi.comments({ id: String(comment.id) }).patch({ body })),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: async () => {
      // A 204 has no body to unwrap.
      const res = await commentsApi.comments({ id: String(comment.id) }).delete();
      if (res.error) throw res.error;
    },
    onSuccess: refresh,
  });

  const author = comment.authorName ?? "unknown";

  return (
    <li className="py-2 text-[12px]">
      {context}
      <div className="flex items-center gap-2">
        <span className="font-bold">{author}</span>
        <time dateTime={comment.createdAt} className="text-muted">
          {new Date(comment.createdAt).toLocaleString()}
        </time>
        {comment.edited ? (
          <span className="text-muted" title={`Edited ${new Date(comment.updatedAt).toLocaleString()}`}>
            (edited)
          </span>
        ) : null}
        {comment.canEdit && !editing && !confirmingDelete ? (
          <span className="ml-auto flex items-center gap-0.5">
            <button
              type="button"
              aria-label={`Edit comment by ${author}`}
              title="Edit"
              onClick={() => {
                save.reset();
                setEditing(true);
              }}
              disabled={remove.isPending}
              className={ICON_BUTTON_CLASS}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={`Delete comment by ${author}`}
              title="Delete"
              onClick={() => {
                remove.reset();
                setConfirmingDelete(true);
              }}
              disabled={remove.isPending}
              className={`${ICON_BUTTON_CLASS} hover:text-tag-artist`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </span>
        ) : null}
      </div>
      {editing ? (
        <div className="mt-1">
          <CommentForm
            initial={comment.body}
            label="Edit comment"
            submitLabel="Save"
            pending={save.isPending}
            error={save.error}
            onSubmit={(body) => save.mutateAsync(body)}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <p className="mt-0.5 whitespace-pre-wrap break-words">{comment.body}</p>
      )}
      {confirmingDelete ? (
        <div role="group" aria-label="Confirm comment deletion" className="mt-1 flex items-center gap-2">
          <span className="text-tag-artist">Delete this comment?</span>
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
            onClick={() => setConfirmingDelete(false)}
            disabled={remove.isPending}
            className="rounded border border-line px-2 py-0.5 hover:border-link"
          >
            Cancel
          </button>
        </div>
      ) : null}
      {remove.isError ? (
        <p role="alert" className="mt-0.5 text-tag-artist">
          {authErrorMessage(remove.error, "Couldn’t delete the comment.")}
        </p>
      ) : null}
    </li>
  );
}
