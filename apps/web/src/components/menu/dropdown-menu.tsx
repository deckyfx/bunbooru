import { type ReactNode, useState } from "react";

import {
  FloatingFocusManager,
  FloatingPortal,
  type Placement,
  autoUpdate,
  flip,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import { ChevronDown } from "lucide-react";

/**
 * Click-toggled dropdown menu (Danbooru-style "Size" / "Options" menus).
 * The trigger is a labelled button; the panel renders `children`.
 */
export function DropdownMenu({
  label,
  children,
  placement = "bottom-end",
}: {
  label: ReactNode;
  children: ReactNode;
  placement?: Placement;
}) {
  const [open, setOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "menu" });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  return (
    <>
      <button
        ref={refs.setReference}
        {...getReferenceProps()}
        type="button"
        className="flex items-center gap-0.5 rounded px-1 hover:text-link"
      >
        {label}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps()}
              className="z-50 min-w-40 rounded-md border border-line bg-surface p-2 text-[12px] shadow-lg"
            >
              {children}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
