import { type ReactNode, useState } from "react";

import {
  FloatingPortal,
  type Placement,
  autoUpdate,
  flip,
  offset,
  safePolygon,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
} from "@floating-ui/react";

interface HoverPopoverProps {
  /** Trigger content (wrapped in an element that carries the floating ref). */
  children: ReactNode;
  /** Renders the floating content; only called while open. */
  render: () => ReactNode;
  /**
   * Interactive popovers (clickable content) keep open while the cursor travels
   * toward them (safePolygon) and use a dialog role. Default true.
   */
  interactive?: boolean;
  placement?: Placement;
  /** Class for the trigger wrapper (e.g. to make it a grid cell). */
  className?: string;
}

/**
 * Generic hover/focus popover built on Floating UI. Opens on pointer hover and
 * keyboard focus, flips/shifts to stay in view, and dismisses on Escape or
 * outside interaction. Content-agnostic — see docs/POPOVER.md.
 */
export function HoverPopover({
  children,
  render,
  interactive = true,
  placement = "top",
  className,
}: HoverPopoverProps) {
  const [open, setOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, {
    delay: { open: 150, close: 0 },
    handleClose: interactive ? safePolygon() : null,
  });
  const focus = useFocus(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: interactive ? "dialog" : "tooltip" });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
    dismiss,
    role,
  ]);

  return (
    <>
      <span ref={refs.setReference} className={className} {...getReferenceProps()}>
        {children}
      </span>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="z-50"
            {...getFloatingProps()}
          >
            {render()}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
