import { useEffect, useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { ImagePlus } from "lucide-react";

import { useCurrentUser } from "../lib/auth";
import { imageFiles, usePendingUploads } from "../stores/pending-uploads";

/** Whether a drag carries files (not text or a link being dragged around the page). */
function draggingFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

/**
 * Quick capture for a signed-in user: paste an image (Ctrl+V, a screenshot)
 * or drop image files anywhere on the site, and they go straight to the
 * upload page. Pasting into a text field still pastes text there; only image
 * files are taken. Mounted once, in the app shell.
 */
export function GlobalCapture() {
  const { data: user } = useCurrentUser();
  const navigate = useNavigate();
  const hand = usePendingUploads((s) => s.hand);
  const [dragging, setDragging] = useState(false);
  const signedIn = Boolean(user);

  useEffect(() => {
    if (!signedIn) return;
    const capture = (files: File[]): boolean => {
      if (files.length === 0) return false;
      hand(files);
      void navigate({ to: "/uploads/new" });
      return true;
    };

    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return; // a page handled it (the upload dropzone)
      if (capture(imageFiles(event.clipboardData?.files ?? []))) event.preventDefault();
    };
    // dragenter/leave fire for every child crossed, so count them.
    let depth = 0;
    const onDragEnter = (event: DragEvent) => {
      if (!draggingFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!draggingFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDragOver = (event: DragEvent) => {
      // Needed for the browser to allow a drop at all.
      if (draggingFiles(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (!draggingFiles(event) || event.defaultPrevented) return;
      // Even with no images, don't let the browser navigate to the file.
      event.preventDefault();
      capture(imageFiles(event.dataTransfer?.files ?? []));
    };

    window.addEventListener("paste", onPaste);
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [signedIn, hand, navigate]);

  if (!dragging) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm"
    >
      <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-link bg-surface px-10 py-8 text-link">
        <ImagePlus className="h-10 w-10" strokeWidth={1.25} />
        <span className="text-[13px] font-bold">Drop to upload</span>
      </div>
    </div>
  );
}
