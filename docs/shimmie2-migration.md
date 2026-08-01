# Shimmie2 → bunbooru migration — findings & plan

> Status (updated 2026-08-01): the **plugin system is now BUILT** (branch
> `feat/plugin-system`: `@bunbooru/plugin-sdk` registration API, an API plugin
> loader gated by `ENABLED_PLUGINS`, plugin-owned migrations, and web `/admin`
> hosting — the `example` plugin is the reference). The **shimmie2 importer
> itself is NOT built yet** — the sections below are its design/plan. Decisions:
> (1) the importer is the **first real feature plugin**, built on the system
> above; (2) source access is via **HTTP scraping** of the running shimmie, not
> its Docker-internal DB.

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
- **Storage/hashing:** hash = **MD5 of file contents**; on-disk path is content-addressed. Shimmie's generic warehouse scheme is a multi-level fan-out, but **this live instance uses a single-level layout: `data/images/<md5[0:2]>/<md5>`** (originals) with thumbs under a parallel `data/thumbs/…` — the canonical path to rely on here, and the one the mapping table below (`data/images/<xx>/<md5>`) uses. Original filename kept in the DB. Files are downloadable over HTTP at `/_images/<md5>` regardless of on-disk layout, which is why the scrape path doesn't depend on it.
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
For each source post: obtain the **image bytes** + its **tags/rating/source/date/owner**, then run the bytes through bunbooru's **`assetService.createFromSource`** (hashes sha256+md5, sniffs dims/mime, dedupes on sha256, stores via StorageProvider, inserts) → then set `rating`/`source`/`createdAt`, then `tagService.setAssetTags(names)`.

> ⚠️ **sha256 is byte-level deduplication, NOT import idempotency.** sha256
> identifies *bytes*, not a shimmie *post*: two posts can share identical bytes
> but carry different tags/rating/owner/date, and a crash *between*
> `createFromSource` and the later metadata calls leaves a partially-imported
> post that a byte-only re-run would skip. So the importer needs its **own ledger
> table** (now possible — the plugin system supports plugin-owned tables) as the
> real unit of idempotency:
>
> - Schema: `(sourceInstance, sourcePostId) → { assetId, status:
>   pending|complete|failed, ownerToken, leaseExpiresAt, importedAt }`, with a
>   **UNIQUE constraint on `(sourceInstance, sourcePostId)`**.
> - Before `createFromSource`, do an **atomic insert-or-claim with exclusive
>   ownership**: `INSERT … ON CONFLICT DO UPDATE` that only succeeds when the row
>   is claimable — i.e. `status IN (failed)` OR (`status = pending` AND
>   `leaseExpiresAt < now()`, a stale/abandoned claim) — stamping a fresh
>   `ownerToken` + `leaseExpiresAt`. `status = pending` with a live lease means
>   **another runner owns it → skip**; `complete` → skip. Only the row's current
>   `ownerToken` holder may then call `createFromSource` and flip it to
>   `complete`. This prevents two concurrent runs from both ingesting the same
>   source post, and lets a crashed run's claim be reclaimed after its lease
>   expires (rather than being stuck `pending` forever). A retry **finishes** a
>   reclaimed row rather than creating a duplicate.
> - Define explicit **reapply/merge** behavior when the same *bytes* arrive from
>   multiple *source posts* (union tags? keep first? operator choice), rather than
>   silently skipping — sha256 dedup will collapse the asset, but each source post
>   still gets its own ledger row.
>
> Everywhere else in this doc, "sha256 dedupe" means byte-level dedup only — the
> ledger is what makes re-runs idempotent.

### Source access — 3 options
1. **HTTP scrape of the running shimmie (recommended; operator's instinct).** The web is exposed on `:5013`. No JSON API is enabled on this instance (`/post/list.json`, `/graphql`, danbooru_api all 404), BUT the HTML works: `/post/list/<page>` (200), `/post/view/<id>` (200, has tags/rating/source), and **direct file download `/_images/<md5>` (200)**. So: paginate the list, parse each post's metadata from HTML (or enable shimmie's `danbooru_api`/`graphql` ext for clean JSON), download bytes from `/_images/<hash>`. **Most general** (works for any reachable shimmie, no Docker/DB coupling) and avoids the sha256 problem (we have the bytes).
   - *Optional cleaner variant:* enable `ext/danbooru_api` (or `graphql`) on shimmie → structured JSON of posts (md5, tags, source, rating, file URL) instead of HTML parsing.
2. **Direct DB + files.** Read `shimmie-sql` rows + `data/images` files. Cleanest data, but the DB port is Docker-internal (would need a host port mapping) and files may be root-owned — more coupling/config. Rejected for now (operator: "the db is inside docker stack which will be hard to access").
3. **shimmie bulk_download export** → a ZIP + JSON manifest, then import the ZIP. Extra manual step; only worth it for offline/portable migration.

**Chosen direction: option 1 (HTTP scrape).** Source config in the admin UI = shimmie base URL (+ optional login cookie/API key for NSFW/private posts) + a query filter to pick user(s).

### Security requirements (must-haves for the importer PR)
Because the importer makes the **server** fetch an admin-configured URL and holds
source **credentials**, the plan has to address two classes of risk up front:

- **SSRF on the source URL.** An admin-set base URL that the API fetches is an
  SSRF vector (worse if a less-trusted role can set it). Constrain it:
  scheme allowlist (`http`/`https` only), **block private/link-local/loopback +
  metadata addresses** by default (allow them only via an explicit deployment
  allowlist for self-hosted same-LAN shimmie), **re-validate the target on every
  redirect** (don't blindly follow to an internal address), cap request time and
  response size, and **never forward the shimmie credentials across a redirect**
  to a different origin.
  - **DNS-rebinding:** validating the hostname isn't enough — a name can resolve
    to a public address at validation time and a private one at connect time.
    **Validate every resolved A/AAAA record immediately before connecting**, and
    since the HTTP client normally does its own connect-time lookup, either **pin
    the approved IP** for the connection or route egress through a **proxy** that
    enforces the address policy.
- **Credential handling.** The optional shimmie cookie/API key must **not** sit
  as a raw value in ordinary plugin settings. Store it encrypted-at-rest or as a
  secret reference, **redact it from logs and job payloads**, and support
  expiry/rotation/deletion. Prefer per-run credentials that aren't persisted at
  all when the operator is willing to re-enter them.

## Architecture decision: plugin system first (BUILT)
The operator chose to **build the plugin system first**, then ship the importer as
the **first real plugin** (per CLAUDE.md "everything optional is a plugin"; it
unblocks all the future plugins in the map above). That system is now
implemented (`feat/plugin-system`, PR #21).

### Plugin system — what shipped
- **Plugin contract** (`@bunbooru/plugin-sdk`): `definePlugin({ id, name, version, migrations?, register(ctx) }) → { routes?, adminPages? }`. `ctx` injects **Core services** (assets/tags/stats/settings/auth), the **event bus**, a request-**auth** helper, a scoped **`ctx.db`** for the plugin's OWN tables, and a **logger** — plugins import ONLY the SDK. `pluginRoutePrefix(id)` gives a template-literal type so the web gets a typed Eden client for `/api/v1/plugins/<id>`.
- **Plugin-owned tables/migrations**: a plugin ships its own schema + generated SQL; the host runs it via `applyMigrations` under a dedicated tracking table (`__drizzle_migrations_<id>`). ✅ implemented.
- **Loader** (`apps/api`): enabled via `ENABLED_PLUGINS`; lazily imports each plugin, runs its migrations (with per-step timeouts), calls `register`, mounts routes under `/api/v1/plugins/<id>`, and exposes the manifest at `GET /api/v1/plugins`. Every failure mode is isolated (one bad plugin can't take down the API).
- **Web**: `/admin` fetches the manifest and renders a section per enabled plugin from a client-side registry (a plugin can't import the app's Eden client — `plugins → apps` is forbidden — so its admin UI lives app-side).
- **Background jobs**: NOT part of the SDK yet — deferred until a plugin needs them (the importer's long-running scan is the first candidate, likely built as importer-owned job state initially).
- Boundaries stay green (`plugins → plugin-sdk → core → db`; dependency-cruiser passes).

### The importer plugin (once the system exists)
- **Admin UI** (`/admin` → "Import from Shimmie2"): fields for shimmie base URL (+ auth), a **preview/scan** step that lists source users + post counts, controls to **pick user(s) or "all"** and the **target bunbooru user**, a **dry-run**, then **Run** with progress + a summary (imported / skipped-dedup / failed).
- **Backend**: a job that scans → for each post fetches bytes + metadata → `createFromSource` → set rating/source/date → `setAssetTags`, recording each post in the **import ledger** (plugin-owned table, keyed by `(sourceInstance, sourcePostId)`) so it's genuinely idempotent + resumable across crashes — not merely byte-deduped. Rate-limited against the source; the source fetch goes through the **SSRF guard** and uses **redacted, non-persisted-by-default credentials** (see Security requirements above).
- **Tests**: parser/mapping unit tests, ledger idempotency/partial-retry tests (incl. concurrent-claim), an SSRF-guard test (rejects private/redirected targets **and DNS-rebinding** — a name whose resolved address flips to private at connect time), + an integration test against a fixture (recorded shimmie HTML/JSON + a sample image).

## Open questions / next steps
1. ~~Plugin-system design~~ — **DONE** (PR #21). Remaining importer-specific design: the shape of the import ledger table + the scan/run job model (in-plugin state vs a future SDK job capability).
2. **Thumbnailing** — not built; importing full images makes the gallery heavy. Decide whether to add thumbnail generation (core or plugin) before/with the import.
3. Scrape source of truth: parse HTML vs enable shimmie's `danbooru_api`/`graphql` ext (cleaner). Operator preference TBD.
4. Original filename / md5-only posts: drop filename, or add an optional field.

### Sequence when we resume
1. ~~Build the **plugin system**~~ — **DONE** (`feat/plugin-system`: SDK registration for routes/admin-pages/plugin-owned tables/service-access + loader + web hosting).
2. Build the **shimmie-import plugin** (scrape → core ingest) + admin UI — with the **import ledger**, **SSRF guard**, and **credential redaction** from the sections above baked in from the start.
3. (Maybe) thumbnailing, so imported posts render cheaply.

## Forward-looking: generalize to other sources (Pixiv, etc.)
> Deferred — noted for later, not part of this effort.

The importer shouldn't be shimmie-specific under the hood. Design it around a
small **`SourceAdapter`** interface — roughly `scanUsers()`, `listPosts(filter)`,
`fetchPost(id) → { bytes, tags, rating, source, createdAt, sourceUser }` — with
**shimmie2 as the first adapter**. Then Pixiv, Danbooru, Gelbooru, etc. become
additional adapters (each its own plugin or an adapter within the import plugin),
reusing the same admin UI, the same core-ingest path (`createFromSource` →
`setAssetTags`), byte-level sha256 dedup, and the **`(sourceInstance,
sourcePostId)` import ledger** for idempotency. This is another reason the plugin
system + a clean import/core-service boundary are worth building first.
(Per-source auth, rate limits, and ToS differ — handle per adapter when we get there.)
