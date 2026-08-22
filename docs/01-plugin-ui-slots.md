# Plugin UI Slots — Design Plan

**Status:** draft, not implemented. Revisit before building.

Generalizes the web app's admin-only plugin registry into **named UI slots**, so
plugins can contribute widgets to public and member-facing surfaces (sidebar
panels, post-detail sections, account settings) — not just the admin console.

Motivating first consumer: a **trending tags** sidebar panel, which turns out to
need two Core prerequisites (§9).

Related: [ingest-hooks.md](./ingest-hooks.md) and
[mail-and-password-reset.md](./mail-and-password-reset.md) also propose SDK
version bumps — see §8.

---

## 1. The gap

`apps/web/src/plugins/registry.tsx` is a single flat map:

```ts
export const PLUGIN_ADMIN_SECTIONS: Record<string, ComponentType> = { … }
```

Its own comment scopes it: *"The admin console renders the section for each
enabled plugin."* There is exactly one rendering location, and it is
admin-only. Nothing can place a widget on a gallery page, a post detail page, or
an account page.

`SDK_CAPABILITIES` lists `navigation-items`, but the SDK notes it is not wired —
and a navigation *item* is a link, not a widget. There is no extension point for
public UI.

### What stays the same

The boundary and the discovery mechanism are already right and should not change:

- **Plugin UI lives in `apps/web`, not in the plugin package.** `plugins → apps`
  is forbidden, so a plugin cannot import the app's Eden client, router, or
  styles. Widgets are app-side code keyed by plugin id.
- **The server declares, the client renders.** `GET /api/v1/plugins` returns the
  enabled-plugin manifest; the app renders only entries it has components for.
- **Version skew degrades quietly.** An enabled plugin with no entry in this
  build simply renders nothing — the existing rule, extended per-slot.

The change is narrow: one map becomes a map *per slot*, plus placement metadata.

---

## 2. Slot model

A **slot** is a named rendering location in the web app. A plugin declares which
slots it contributes to; the app decides where each slot lives on the page.

```ts
/** Rendering locations a plugin may contribute a widget to. */
export const UI_SLOTS = [
  "sidebar",            // left panel, list + gallery pages
  "gallery-header",     // above the grid
  "post-detail-aside",  // beside a post (metadata column)
  "post-detail-below",  // under a post (comments, related)
  "account-settings",   // member's own settings page
  "admin",              // the existing admin console section
] as const;

export type UiSlot = (typeof UI_SLOTS)[number];
```

**A closed union, not free strings.** Both sides compile against it, so a typo
is a build error rather than a widget that silently never renders. New slots are
an additive SDK change.

`"admin"` is included deliberately: the existing `PLUGIN_ADMIN_SECTIONS` becomes
*one slot among several* rather than a parallel mechanism. One concept, not two.

### Server side — declaration only

`PluginRegistration` gains:

```ts
export interface UiContribution {
  slot: UiSlot;
  /** Stable id, unique within the plugin — the web registry key. */
  id: string;
  /** Heading the app may render around the widget. */
  title: string;
  /** Sort key within the slot; defaults to 0. */
  order?: number;
  /** Minimum audience; the app hides below this. NOT a security boundary (§5). */
  visibility?: "anonymous" | "member" | "moderator";
}
```

Metadata only — no components, no markup. It flows through
`PluginManifestEntry` (which today carries `adminPages`) so the app can discover
contributions without a second endpoint.

### Client side — the registry

```ts
export const PLUGIN_UI: Record<UiSlot, Record<string, ComponentType<SlotProps>>> = {
  sidebar: { "tag-trends:panel": lazy(() => import("./tag-trends/TrendingPanel")) },
  admin:   { "thumbnailer:main": ThumbnailsSection, … },
  …
};
```

Keyed by `"<pluginId>:<contributionId>"` so one plugin can contribute several
widgets to one slot. A slot component receives a small typed `SlotProps` —
context the location can supply (e.g. the current `assetId` for
`post-detail-*`), never the raw Eden client.

---

## 3. Placement and ordering

The **app** owns where a slot renders; the **plugin** owns its order within it.
A plugin must not be able to reposition site chrome.

Ordering mirrors the ingest-hooks rule verbatim, for consistency: sort by
`order` (default `0`), then plugin id, then contribution id. Fully deterministic
across restarts and independent of registration timing.

**Operator override is out of scope for v1** but the shape allows it later —
a settings-backed `order`/`hidden` per contribution, since placement is already
data rather than code.

---

## 4. Failure isolation (non-negotiable)

Admin-only widgets fail in front of one admin. **Public widgets fail in front of
every visitor**, so the blast radius changes completely.

- Every slot entry is wrapped in its own **React error boundary**. A throwing
  widget renders a small inline "this panel failed" and the page is otherwise
  untouched. One broken plugin must never white-screen the gallery.
- Every slot entry gets its own **Suspense boundary**, so a slow widget's
  fallback is local and never delays first paint.
- A widget that throws repeatedly should be suppressed for the session rather
  than remounted in a loop.

This is the single biggest difference between the admin registry and this one,
and the main reason it deserves a design rather than a one-line map change.

---

## 5. Visibility is a hint, never a control

`visibility` exists so the app doesn't render a member-only panel to anonymous
visitors — a UX affordance, nothing more. **The plugin's own routes must
independently enforce authorization**, exactly as they do today via
`PluginContext.auth` plus `canModerate`/`isOwnerOrAdmin`.

Stated explicitly because the manifest is client-visible: hiding a widget hides
nothing about the endpoint behind it.

### Manifest exposure changes

`GET /api/v1/plugins` is currently **unauthenticated** (mounted before the auth
routes, commented "public metadata") and consumed only by the admin console.
Making public pages depend on it means anonymous visitors routinely fetch the
enabled-plugin list with names and versions.

That is arguably already the status quo, but it becomes load-bearing. Two
options: keep it public and accept that the plugin roster is discoverable, or
split into a public slot manifest (ids/slots/titles only) and an authenticated
full manifest (versions, admin pages). **Leaning the split** — version numbers
are reconnaissance and nothing on a public page needs them. Open question 2.

---

## 6. Performance

Public pages are the hot path; the admin console never was.

- **Lazy-load every widget** (`React.lazy` + dynamic import). Otherwise every
  plugin's UI ships in the main bundle whether or not the plugin is enabled on
  this deployment — pure dead weight for a self-hosted instance running two
  plugins.
- **Widgets fetch their own data, independently.** Never block the gallery query
  on a sidebar panel.
- **Watch request fan-out.** Five sidebar widgets on every page view is five
  extra requests per page. Widgets over slowly-changing data (trending tags,
  counts) must cache client-side with a generous `staleTime` and, where it
  matters, be cached server-side too. A "trending tags" panel recomputing per
  page view is exactly the sort of thing that quietly degrades a 10M-asset
  instance.
- Slot rendering must not shift layout as widgets resolve — reserve space or
  render nothing until ready.

---

## 7. What this does *not* solve

- **Plugin-provided routes/pages** in the public app (a plugin owning
  `/pools/:id`). Different problem — needs router integration, not slots.
- **Third-party/out-of-tree plugin UI.** Widgets are compiled into the app, so
  UI still ships with the app build. In-repo first-party plugins are the stated
  model (CLAUDE.md), so this is consistent, not a regression.
- **Styling isolation.** Widgets are app code using app styles. Fine today;
  revisit only if out-of-tree plugins ever happen.

---

## 8. SDK changes

- Add `UI_SLOTS` / `UiSlot` / `UiContribution`.
- Add `ui?: UiContribution[]` to `PluginRegistration`.
- Extend `PluginManifestEntry` with the contributions.
- Replace the `navigation-items` capability with `ui-slots`, or keep both if a
  plain nav link is still wanted (open question 3).
- Bump `PLUGIN_SDK_VERSION`.

**Three drafts now propose a bump** — [ingest-hooks.md](./ingest-hooks.md) §8,
[mail-and-password-reset.md](./mail-and-password-reset.md) §8, and this one.
Single rule: **versions are claimed in merge order, not draft order**
(`0.3.0`, `0.4.0`, `0.5.0`). No draft reserves a number in advance.

**Migration:** `PLUGIN_ADMIN_SECTIONS` becomes `PLUGIN_UI.admin`. Three existing
entries (`example`, `thumbnailer`, `shimmie-import`) move over; those plugins
declare an `"admin"` contribution. Mechanical, and it validates the model
against real plugins before any new one is written.

---

## 9. First consumer: trending tags

Deliberately chosen because it exercises the whole stack — and it surfaced two
Core gaps.

### Where the feature splits

| Piece | Home | Why |
|---|---|---|
| Most-used tags | **Core** | `tags.postCount` already exists and ships in `TagDto`. This is a sort parameter on the existing tags endpoint, not a feature. |
| `asset.tagged` event | **Core** | Prerequisite — see below |
| Trending computation + rollup + panel | **plugin** (`tag-trends`) | Optional, own tables, own job |

### Blocker: Core emits no tag event

`CoreEventMap` contains exactly one event, `asset.created`, and its payload
carries **no tags** — tags are applied afterwards through a separate
`setAssetTags` call. Meanwhile `PluginContext.db` is contractually limited to
tables the plugin declares itself.

So a tag-analytics plugin today can neither read the tag tables nor observe
writes to them. It is unbuildable. Core needs:

```ts
"asset.tagged": {
  assetId: number;
  added: string[];
  removed: string[];
  at: Date;
}
```

emitted from `TagService.setAssetTags`. Small, and generic — it also unlocks
auto-tagging feedback, co-occurrence suggestions, and tag-change audit.

### Consequence worth naming

The plugin keeps its own rollup table **because of the dependency boundary, not
because of scale**. At small scale a direct query would be fine; the plugin
maintains counts because it is not permitted to ask Core for them. That is the
architecture working as designed, but it should be a conscious cost, not a
surprise discovered mid-implementation.

Rollup shape: `tag_daily_counts(tag_name, day, applied, removed)`, incremented
from the event, queried as a windowed sum with recency weighting. Bounded by
window, not library size — so it stays flat as the collection grows.

---

## 10. Open questions

1. Initial slot catalog (§2) — is six too many to start? Could ship with
   `sidebar` + `admin` only and add on demand.
2. Split `GET /api/v1/plugins` into public and authenticated manifests (§5)?
3. Keep `navigation-items` as a separate capability, or fold plain links into
   slots as a link-only contribution?
4. Do slot widgets need per-route context beyond `assetId` (e.g. current search
   query for a "related tags" panel)? Shapes `SlotProps`.
5. Should a slot cap the number of contributions (a sidebar with 12 panels is
   unusable), and if so, is that operator config or a hard limit?

---

## 11. Phased implementation

**Phase 1 — slot mechanism, no new features**
`UI_SLOTS`/`UiContribution` in the SDK, manifest extension, `PLUGIN_UI` registry
with error + Suspense boundaries and lazy loading, `sidebar` and `admin` slots
wired. Migrate the three existing admin sections onto it. Ships with **zero**
user-visible change — pure refactor, which makes it safe to review and validates
the model against real plugins.

**Phase 2 — Core tag plumbing**
`asset.tagged` event from `TagService.setAssetTags`, plus the top-tags sort on
the tags endpoint (independently useful, and it may satisfy the original request
on its own).

**Phase 3 — `tag-trends` plugin**
Rollup table, event listener, backfill for existing tags, windowed query with
caching, sidebar panel.

**Phase 4 — remaining slots on demand**
`post-detail-*`, `account-settings`, `gallery-header` as real consumers appear
(favorites, comments, related posts). Don't build slots speculatively — each one
is a rendering contract to keep.

Phase 1 is worth doing even if trending is never built: it is the extension
point every future member-facing plugin needs, and it removes a parallel
mechanism rather than adding one.
