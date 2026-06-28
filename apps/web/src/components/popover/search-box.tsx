import { useRef, useState } from "react";

import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useMergeRefs,
  useRole,
} from "@floating-ui/react";

import { Search } from "lucide-react";

import { TAG_NAMES, TAG_TEXT_CLASS, formatCount, lookupTag } from "../../lib/tags";

const MAX_SUGGESTIONS = 8;

/** Suggestions for the last whitespace-separated token of `query`. */
function suggest(query: string): string[] {
  const token = (query.split(/\s+/).pop() ?? "").toLowerCase();
  if (token.length === 0) return [];
  return TAG_NAMES.filter((n) => n.includes(token))
    .sort((a, b) => Number(b.startsWith(token)) - Number(a.startsWith(token)))
    .slice(0, MAX_SUGGESTIONS);
}

/**
 * Search input with a tag-autocomplete dropdown. Completes the last token,
 * keyboard-navigable, category-coloured with post counts. Phase 0 filters the
 * static catalog; Phase 1 swaps in `useTagAutocomplete(q)` (see docs/POPOVER.md).
 */
export function SearchBox({
  placeholder,
  className,
}: {
  placeholder?: string;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<Array<HTMLElement | null>>([]);

  const suggestions = suggest(query);
  const isOpen = open && suggestions.length > 0;

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setOpen,
    placement: "bottom-start",
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      size({
        apply({ rects, elements }) {
          elements.floating.style.width = `${rects.reference.width}px`;
        },
        padding: 8,
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const role = useRole(context, { role: "listbox" });
  const dismiss = useDismiss(context);
  const listNav = useListNavigation(context, {
    listRef,
    activeIndex,
    onNavigate: setActiveIndex,
    virtual: true,
    loop: true,
  });

  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    role,
    dismiss,
    listNav,
  ]);

  const inputRefs = useMergeRefs([refs.setReference, inputRef]);

  function choose(name: string) {
    const tokens = query.split(/\s+/);
    tokens[tokens.length - 1] = name;
    setQuery(`${tokens.join(" ")} `);
    setActiveIndex(null);
    setOpen(false);
    inputRef.current?.focus();
  }

  return (
    <>
      <div className={`flex h-7 ${className ?? ""}`}>
        <input
          {...getReferenceProps({
            onFocus: () => setOpen(true),
            onKeyDown: (event) => {
              if (event.key === "Enter" && activeIndex !== null) {
                const selected = suggestions[activeIndex];
                if (selected) {
                  event.preventDefault();
                  choose(selected);
                }
              }
            },
          })}
          ref={inputRefs}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(null);
            setOpen(true);
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-l border border-line px-2 text-[12px] outline-none focus:border-link"
        />
        <button
          type="button"
          aria-label="Search"
          onClick={() => inputRef.current?.focus()}
          className="flex items-center rounded-r border border-l-0 border-line bg-line/40 px-2 text-muted hover:text-link"
        >
          <Search className="h-3.5 w-3.5" />
        </button>
      </div>
      {isOpen && (
        <FloatingPortal>
          <ul
            {...getFloatingProps()}
            ref={refs.setFloating}
            style={floatingStyles}
            className="z-50 overflow-hidden rounded-md border border-line bg-surface py-1 text-[13px] shadow-lg"
          >
            {suggestions.map((name, index) => {
              const tag = lookupTag(name);
              return (
                <li
                  key={name}
                  ref={(node) => {
                    listRef.current[index] = node;
                  }}
                  {...getItemProps({ onClick: () => choose(name) })}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-1 ${
                    activeIndex === index ? "bg-line/40" : ""
                  }`}
                >
                  <span className={TAG_TEXT_CLASS[tag.category]}>{name}</span>
                  <span className="ml-auto text-[11px] text-muted">
                    {formatCount(tag.postCount)}
                  </span>
                </li>
              );
            })}
          </ul>
        </FloatingPortal>
      )}
    </>
  );
}
