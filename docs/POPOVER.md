# Popover System — Design

Status: **Planned** · Owner: frontend (`apps/web`) + Core API · Inspired by Danbooru's tag popovers.

## Goal

One reusable, accessible floating-overlay engine that surfaces tag and post
information across three surfaces, with content composed from Core data plus
plugin-contributed sections.

| Surface | Trigger | Content |
|---|---|---|
| **Tag popover** | hover / focus a tag link (posts sidebar, post detail, any tag list) | category, post count, aliases, implications, wiki excerpt (plugin), quick actions |
| **Gallery preview** | hover a thumbnail | larger sample image, rating / score / dimensions, tags grouped by category |
| **Search autocomplete** | typing in a search box | tag suggestions: category colour, post count, alias resolution; keyboard-navigable |

One engine, three content templates. First iteration builds the **tag popover
and autocomplete together** so the shared primitive is proven reusable.

## Architecture

```
1. Popover primitive   headless floating layer — positioning, hover/focus/dismiss, a11y, portal
2. Content cards       <TagPopoverCard> <PostPreviewCard> <TagSuggestList>   (pure presentational)
3. Data hooks          useTagInfo(name) · usePostPreview(id) · useTagAutocomplete(q)   (TanStack Query)
4. API contract        Core endpoints (mocked with static data until the DB lands)
```

Proposed `apps/web` layout:

As implemented (Phase 0):

```
src/components/popover/
  hover-popover.tsx      generic hover/focus primitive (Floating UI)
  tag-popover-card.tsx   tag content (related tags)
  post-tags-card.tsx     thumbnail content (a post's tags)
  search-box.tsx         autocomplete combobox
src/components/menu/
  dropdown-menu.tsx      generic click menu (Floating UI)
src/components/tags/     shared TagRow / TagGroups
src/lib/tags.ts          tag catalog, colours, helpers (shared with the sidebar)
src/lib/post-fixtures.ts deterministic post metadata
```

Phase 1 adds data hooks (`useTagInfo`, `useTagAutocomplete`, `usePostPreview`).

### 1. Popover primitive — Floating UI

Built on `@floating-ui/react` (headless, accessible). It provides:

- **Positioning**: `flip`, `shift`, `offset`, `arrow` — stays in the viewport.
- **Interactions**: `useHover` (with `safePolygon` so moving the cursor *toward*
  an interactive popover doesn't dismiss it), `useFocus` (keyboard), `useDismiss`
  (Escape / outside-click), `useRole`.
- **Portal** so the layer escapes overflow/stacking contexts.

The primitive is content-agnostic: it takes a `trigger` element and a `content`
render and manages open state, delay, placement, and a11y wiring.

Why not hand-roll (what Danbooru does): we'd re-implement flip/shift/safePolygon/
ARIA. Why not Radix `HoverCard`: heavier and more opinionated markup; Floating UI
fits the Tailwind/headless approach and covers all three surfaces with one API.

### 2. Content cards

Pure presentational components fed by data. Render Core sections always, and
plugin sections when present (see Extensibility). Tag categories use the shared
colour map (`artist`/`copyright`/`character`/`general`/`meta`).

### 3. Data hooks (TanStack Query)

- Fetch **on hover-intent** (lazy) — never prefetch every tag on a page.
- `staleTime` long (tag metadata changes slowly); cache keyed by tag name.
- Concurrent-request **dedup** + autocomplete **debounce** (~150ms, min length).
- Optional prefetch of the currently-highlighted autocomplete row.

### 4. API contract (Core-owned)

```http
GET /api/v1/tags/:name
  → { name, category, postCount, aliases[], implications[], sections?: PluginSection[] }

GET /api/v1/tags/autocomplete?q=<prefix>&limit=10
  → [{ name, category, postCount, antecedent?: string }]

GET /api/v1/posts/:id
  → { id, rating, score, width, height, sampleUrl, tags: { [category]: string[] } }
```

`antecedent` is the alias that matched the query (when a suggestion resolves via
an alias). Autocomplete is served by the **search package's** tag index (prefix lookup),
supporting the `<50ms` latency goal. Until the DB exists these are mocked with
static fixtures behind the same hook signatures.

## Extensibility — the popover is a composition surface

This is where the popover showcases the plugin-first architecture:

- **Core** owns and returns the base tag fields: name, category, postCount,
  aliases, implications.
- **Plugins** enrich the payload server-side via the event/hook system:
  - **Wiki plugin** → `sections: [{ type: "wiki", excerpt, url }]`
  - **Favorites plugin** → favorited state / count
- The frontend renders `sections[]` by known `type`, ignoring unknown ones.

Core never knows about wiki/favorites — they reach the payload through
`plugin-sdk`, matching `plugins → plugin-sdk → core`. (Frontend-side plugin UI
injection is a later, separate concern; for now plugin data arrives via the API
payload and the frontend renders known section types.)

## Behavior / UX spec

- **Open**: hover (≈200ms delay) **and** keyboard focus (Tab) — a11y parity.
- **Close**: `safePolygon` for interactive popovers; Escape; outside-click; blur.
- **Interactive vs not**: tag popover is interactive (clickable related tags /
  wiki link) → `role="dialog"`, kept open via safePolygon. Gallery preview is
  passive → `role="tooltip"`.
- **One at a time**: opening a popover closes the previous.
- **Touch**: pointers without hover get a small "?" / info affordance that opens
  the popover on tap (hover must not be the only path).
- **Autocomplete**: debounced, alias-aware, ordered by post count; full keyboard
  nav (↑/↓/Enter/Esc); highlights the matched substring.
- Respect `prefers-reduced-motion`.

## Accessibility

- Correct roles (`tooltip` vs `dialog`/`listbox`), `aria-describedby`/
  `aria-controls`, `aria-expanded` on triggers.
- Keyboard-operable open/close and in-popover navigation; focus management for
  interactive popovers.
- Sufficient colour contrast for tag-category colours (don't rely on colour
  alone — category is also labelled/iconned).

## Performance & caching

- Lazy fetch on hover-intent; dedup; cache per tag; debounce autocomplete.
- Avoid N+1: the tag **list** already carries category + count (from the post
  payload) for colouring/sorting; the popover only fetches the heavier extras
  (aliases, implications, wiki) on demand.
- Optional `POST /api/v1/tags/batch` later, only if profiling shows a need.

## Phasing

- **Phase 0 — frontend shell, static data (first):** Floating UI primitive +
  `TagPopoverCard` + autocomplete dropdown (`TagSuggestList`), wired to the posts
  sidebar tags and the search boxes with static fixtures. Full UX, no backend.
- **Phase 1 — data hooks:** TanStack Query + Eden Treaty client against the
  contracts above; swap fixtures → live.
- **Phase 2 — backend:** Core tag-info + autocomplete endpoints
  (Repository → Service → Route) + search-index autocomplete.
- **Phase 3 — enrichment:** Wiki-plugin sections, gallery-preview popover, touch
  polish.

## Decisions

- Library: **`@floating-ui/react`** (headless, accessible, safePolygon).
- First iteration: **tag popover + autocomplete together** on the shared engine.
- Tag data is **Core**; wiki/favorites enrichment is **plugin** via the API payload.

## Open questions

- Frontend plugin-UI injection mechanism (how plugins add *rendered* popover
  sections, not just data) — deferred until the backend plugin system is real.
- Gallery preview image source/size (sample vs thumbnail) — pin once storage +
  thumbnailing exist.
- Touch affordance shape (inline "?" vs long-press) — validate with a device.
