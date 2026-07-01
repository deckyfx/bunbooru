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
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";

import { formatCount, tagTextClass, useTagAutocomplete } from "../../lib/tags";

const MAX_SUGGESTIONS = 8;

/**
 * Search input with a live tag-autocomplete dropdown (real API — completes the
 * last whitespace-separated token, keyboard-navigable, category-coloured with
 * post counts). Submitting navigates to the filtered gallery (`/posts?q=…`);
 * choosing a suggestion completes the token so several tags can be combined.
 */
export function SearchBox({
  placeholder,
  className,
}: {
  placeholder?: string;
  className?: string;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<Array<HTMLElement | null>>([]);

  // Autocomplete the last token being typed (empty token → no query).
  const lastToken = query.split(/\s+/).pop() ?? "";
  const { data: suggestionsData } = useTagAutocomplete(lastToken, MAX_SUGGESTIONS);
  const suggestions = lastToken.length > 0 ? (suggestionsData ?? []) : [];
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

  /** Replace the last token with `name` and keep typing (combine tags). */
  function choose(name: string) {
    const tokens = query.split(/\s+/);
    tokens[tokens.length - 1] = name;
    setQuery(`${tokens.join(" ")} `);
    setActiveIndex(null);
    setOpen(false);
    inputRef.current?.focus();
  }

  /** Run the current query — navigate to the filtered gallery. */
  function runSearch() {
    const q = query.trim();
    setOpen(false);
    void navigate({ to: "/posts", search: q ? { q } : {} });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        runSearch();
      }}
    >
      <div className={`flex h-7 ${className ?? ""}`}>
        <input
          {...getReferenceProps({
            onFocus: () => setOpen(true),
            onKeyDown: (event) => {
              // Enter with a highlighted suggestion completes the token instead of
              // submitting; otherwise the form submits and runs the search.
              if (event.key === "Enter" && activeIndex !== null) {
                const selected = suggestions[activeIndex];
                if (selected) {
                  event.preventDefault();
                  choose(selected.name);
                }
              }
            },
          })}
          ref={inputRefs}
          type="search"
          aria-label={placeholder ?? "Search"}
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
          type="submit"
          aria-label="Search"
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
            {suggestions.map((tag, index) => (
              <li
                key={tag.name}
                ref={(node) => {
                  listRef.current[index] = node;
                }}
                {...getItemProps({ onClick: () => choose(tag.name) })}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1 ${
                  activeIndex === index ? "bg-line/40" : ""
                }`}
              >
                <span className={tagTextClass(tag.category)}>{tag.name}</span>
                <span className="ml-auto text-[11px] text-muted">{formatCount(tag.postCount)}</span>
              </li>
            ))}
          </ul>
        </FloatingPortal>
      )}
    </form>
  );
}
