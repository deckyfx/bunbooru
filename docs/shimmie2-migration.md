# Shimmie2 → bunbooru migration — findings & plan

> Status: **research/plan only, nothing built.** Captured 2026-07-02 to revisit.
> Decisions taken so far: (1) the importer will be the **first real bunbooru
> plugin** — so the plugin system gets built first; (2) source access will most
> likely be **HTTP scraping** of the running shimmie, not its Docker-internal DB.

## Why
The operator currently runs **shimmie2** (a PHP booru) and wants to migrate their
posts/tags into bunbooru, driven from a **bunbooru admin-area UI** (choose which
shimmie user(s) to import from — or all — and the target bunbooru user).

## The live shimmie instance (this machine, Docker)
- `shimmie2` container (`shish2k/shimmie2:latest`) — web UI on **host `:5013`** → container `:8000`.
- `shimmie-sql` container (`postgres:15`) — DB `shimmie`, user `shimmie`. **Port NOT exposed to the host** (Docker-internal only).
- Image files: host bind mount **`/DATA/AppData/shimmie/data`** → `/app/data` (content-addressed by MD5; see storage below).
- **Data size (small, core-only):** 59 images, 59 tags, 202 image↔tag links, 2 users (1 real `admin` + shimmie's system `anonymous`). **Every optional table is empty** (comments, pools, notes, favorites, forum, wiki, aliases) — so migrating today = **core only**.

## Shimmie architecture (relevant bits)
Source studied at `reference/shimmie2/` (gitignored study clone; NOT a submodule).

- **Everything is an extension** (`ext/<name>`). Core-ish: `image`, `handle_*` (per-MIME ingest), `media` (thumbs), `mime`, `upload`, `index` (search), `rating`, `user`/`user_config`/`user_api_keys`, post-metadata exts (`post_tags`, `post_source`, `tag_history`, …). This maps 1:1 to bunbooru's **Core**.
- **Optional exts = bunbooru's future plugins** (see map below).
- **Admin UI pattern:** an ext listens for `AdminBuildingEvent` → renders a form `Block` on `/admin`; the form POSTs to its own route or the generic `admin/{action}` bus; a handler runs the server-side action (long tasks bump timeouts). → bunbooru's existing `/admin` + settings/API-key pages are the same shape.
- **Storage/hashing:** hash = **MD5 of file contents**; on-disk path is content-addressed fan-out `data/<base>/<hh>/<hh>/<md5>` (media base + a `thumbs` base). Original filename kept in the DB.
- **Thumbnails:** generated **synchronously on upload** (GD / ImageMagick / ffmpeg). ⚠️ **bunbooru has NO thumbnailing yet** — it serves full images. Importing real images will work but the gallery loads full-size until we add thumbs. (Candidate follow-up feature/plugin.)
- **DB per-ext migrations:** each ext guards steps by a stored `ext_<key>_version` and runs `create_table`/`ALTER` on `DatabaseUpgradeEvent`; features often add columns to the shared `images` table. → informs bunbooru's per-plugin migration model.

## Feature → bunbooru mapping
| shimmie | bunbooru | status |
|---|---|---|
| image/tags/image_tags/user/rating/search/index | Core (`assets`, `tags`, `asset_tags`, `users`, search) | ✅ built |
| view counts (`image_views`) | stats (views/visitors) | ✅ built (#17) |
| config | runtime settings | ✅ built (#19) |
| `comment` | Comments plugin | ⬜ future plugin |
| `favorites`/`user_favorites` | Favorites plugin | ⬜ |
| `pools`/`pool_images` | Pools plugin | ⬜ |
| `notes` | Notes plugin | ⬜ |
| `forum_*` | Forum plugin | ⬜ |
| `wiki_pages` | Wiki plugin | ⬜ |
| `alias_editor`/`tag_categories` | Tag aliases / categories | partial (categories exist; aliases ⬜) |
| `auto_tagger` | Auto-tagger plugin | ⬜ |
| `report_image` | Reports/moderation plugin | ⬜ |
| `numeric_score` | Scoring/votes plugin | ⬜ |
| **bulk import/export** | **Shimmie import plugin** | ⬜ **this effort** |

## Shimmie DB schema (from the live instance) → bunbooru field mapping
`images` (core columns): `id, owner_id, owner_ip, filename, filesize, hash(md5,32), ext, source, width, height, posted, locked, rating(char1), title, mime, video/audio/image flags, approved, favorites, notes, …`

| shimmie `images` | bunbooru `assets` | notes |
|---|---|---|
| `hash` (md5) | `md5` **+ compute `sha256`** from file | sha256 is bunbooru's unique key; shimmie doesn't store it → must hash the bytes |
| `mime` / `ext` | `mimeType` | |
| `width`/`height`/`filesize` | `width`/`height`/`sizeBytes` | |
| `source` | `source` | |
| `rating` `s`/`q`/`e`/`?` | `safe`/`questionable`/`explicit`/`unrated` | in the data: s=13, q=15, e=7, ?=24 |
| `posted` | `createdAt` | preserve original date |
| `owner_id` | `uploaderId` | mapped per import config (see below) |
| `filename` | — (bunbooru has no original-filename column) | dropped, or future field |
| file `data/images/<xx>/<md5>` | ingest via StorageProvider → `storageKey` | re-ingest through core so hashing/sniffing/dedupe/storage are consistent |

`tags(id, tag, count)` → `tags` (name normalized to canonical lowercase/underscore; `postCount` auto-rebuilt by bunbooru's trigger — don't copy `count`). No category column in core shimmie → everything imports as `general` (categories set later via the admin tag route). `image_tags(image_id, tag_id)` → `asset_tags` (applied via `tagService.setAssetTags` using tag names).

`users(id, name, pass, joindate, class, email)`:
- **Passwords can't migrate** — shimmie's hash ≠ bunbooru's Argon2id. There's 1 real user; expectation is the operator registers in bunbooru fresh.
- `class` `admin`/`user` → role `admin`/`member`; `anonymous` is shimmie's system user (owner of nothing real).

## Import approach (re-ingest, don't raw-insert)
For each source post: obtain the **image bytes** + its **tags/rating/source/date/owner**, then run the bytes through bunbooru's **`assetService.createFromSource`** (hashes sha256+md5, sniffs dims/mime, dedupes on sha256, stores via StorageProvider, inserts) → then set `rating`/`source`/`createdAt`, then `tagService.setAssetTags(names)`. **Idempotent**: the sha256 dedupe means re-runs skip already-imported posts.

### Source access — 3 options
1. **HTTP scrape of the running shimmie (recommended; operator's instinct).** The web is exposed on `:5013`. No JSON API is enabled on this instance (`/post/list.json`, `/graphql`, danbooru_api all 404), BUT the HTML works: `/post/list/<page>` (200), `/post/view/<id>` (200, has tags/rating/source), and **direct file download `/_images/<md5>` (200)**. So: paginate the list, parse each post's metadata from HTML (or enable shimmie's `danbooru_api`/`graphql` ext for clean JSON), download bytes from `/_images/<hash>`. **Most general** (works for any reachable shimmie, no Docker/DB coupling) and avoids the sha256 problem (we have the bytes).
   - *Optional cleaner variant:* enable `ext/danbooru_api` (or `graphql`) on shimmie → structured JSON of posts (md5, tags, source, rating, file URL) instead of HTML parsing.
2. **Direct DB + files.** Read `shimmie-sql` rows + `data/images` files. Cleanest data, but the DB port is Docker-internal (would need a host port mapping) and files may be root-owned — more coupling/config. Rejected for now (operator: "the db is inside docker stack which will be hard to access").
3. **shimmie bulk_download export** → a ZIP + JSON manifest, then import the ZIP. Extra manual step; only worth it for offline/portable migration.

**Chosen direction: option 1 (HTTP scrape).** Source config in the admin UI = shimmie base URL (+ optional login cookie/API key for NSFW/private posts) + a query filter to pick user(s).

## Architecture decision: build the plugin system first
bunbooru's plugin system is a **stub** today: `packages/plugin-sdk` exports only `PLUGIN_SDK_VERSION` + a *list of capability names* (`routes`, `tables`, `admin-pages`, …) with **no registration API**, and `apps/api` has **no plugin loader** (both marked "to be built"). The operator chose to **build the plugin system first**, then ship the importer as the **first real plugin** (correct per CLAUDE.md "everything optional is a plugin", and it unblocks all the future plugins in the map above).

### Plugin system — minimum the importer needs (scope for the foundational PR)
- **Plugin contract** in `plugin-sdk`: a `definePlugin({ name, version, register(ctx) })` shape where `ctx` can register: **API routes** (Elysia sub-app under `/api/v1/plugins/<name>` or similar), **admin pages** (surfaced to the web `/admin`), **DB tables + migrations** (per-plugin, versioned), **background jobs**, and access to **Core's public services** (assetService/tagService/authService) — never `core`/`db` internals directly.
- **Loader** in `apps/api`: discover enabled plugins (config-toggled), run their migrations, mount their routes, expose their admin-page manifest.
- **Web**: a way for `/admin` to render plugin-contributed admin pages (a registry the SPA reads; or plugin admin pages served as data + a generic renderer). This is the least-defined part and needs design.
- Respect boundaries (`plugins → plugin-sdk → core → db`; dependency-cruiser must stay green).

### The importer plugin (once the system exists)
- **Admin UI** (`/admin` → "Import from Shimmie2"): fields for shimmie base URL (+ auth), a **preview/scan** step that lists source users + post counts, controls to **pick user(s) or "all"** and the **target bunbooru user**, a **dry-run**, then **Run** with progress + a summary (imported / skipped-dedup / failed).
- **Backend**: a job that scans → for each post fetches bytes + metadata → `createFromSource` → set rating/source/date → `setAssetTags`. Idempotent, resumable, rate-limited against the source.
- **Tests**: parser/mapping unit tests + an integration test against a fixture (recorded shimmie HTML/JSON + a sample image).

## Open questions / next steps
1. **Plugin-system design** (esp. how the web `/admin` hosts plugin pages) — needs its own design pass before coding. Biggest unknown.
2. **Thumbnailing** — not built; importing full images makes the gallery heavy. Decide whether to add thumbnail generation (core or plugin) before/with the import.
3. Scrape source of truth: parse HTML vs enable shimmie's `danbooru_api`/`graphql` ext (cleaner). Operator preference TBD.
4. Original filename / md5-only posts: drop filename, or add an optional field.

### Sequence when we resume
1. Design + build the **plugin system** (loader + SDK registration for routes/admin-pages/tables/service-access) — foundational PR.
2. Build the **shimmie-import plugin** (scrape → core ingest) + admin UI.
3. (Maybe) thumbnailing, so imported posts render cheaply.

## Forward-looking: generalize to other sources (Pixiv, etc.)
> Deferred — noted for later, not part of this effort.

The importer shouldn't be shimmie-specific under the hood. Design it around a
small **`SourceAdapter`** interface — roughly `scanUsers()`, `listPosts(filter)`,
`fetchPost(id) → { bytes, tags, rating, source, createdAt, sourceUser }` — with
**shimmie2 as the first adapter**. Then Pixiv, Danbooru, Gelbooru, etc. become
additional adapters (each its own plugin or an adapter within the import plugin),
reusing the same admin UI, the same core-ingest path (`createFromSource` →
`setAssetTags`), and the same idempotent sha256 dedupe. This is another reason
the plugin system + a clean import/core-service boundary are worth building first.
(Per-source auth, rate limits, and ToS differ — handle per adapter when we get there.)
