# ARCHITECTURE.md

# Bunbooru Architecture

Version: 0.1

---

# Vision

Bunbooru is a plugin-first media management platform inspired by traditional
Booru imageboards.

The architecture prioritizes:

- Extensibility
- Performance
- Maintainability
- Simplicity
- Type Safety

It should support anything from a single-user home lab to millions of managed
assets without requiring fundamental redesign.

---

# Guiding Principles

## Core is forever

The Core should remain extremely small. If a feature can be optional, it does
**not** belong in Core. Core should be stable for years.

## Plugins own features

Comments, Favorites, Wiki, OCR, AI, and Translation are **not** Core.
Everything optional is a plugin.

## APIs over implementations

Every subsystem communicates through interfaces, never through concrete
implementations.

---

# High-Level Architecture

```
React UI
   │  REST / WebSocket
Elysia Controllers
   │
Services
   │
Repository Interfaces
   │
Drizzle Implementation
   │
PostgreSQL

Background Workers → Event Bus → Plugins → Storage → Search
```

---

# Monorepo

```
apps/
  api/
  web/

packages/
  core/
  db/
  auth/
  events/
  storage/
  search/
  plugin-sdk/

plugins/
docs/
```

---

# Responsibilities

## api

REST API, authentication, validation, OpenAPI. No business logic. Also the
composition root, so it hosts the job runner: inline by default, or alone as
`bunbooru worker` (no HTTP). See Background Jobs.

## web

React application. Consumes the public API only. Never directly accesses the
database.

## core

Contains: Asset, Tag, Collection, User, Permission. No optional features.

## db

Drizzle schemas, repositories, migrations, transactions, database adapters.

## search

Owns the Lexer, Parser, AST, and Optimizer. No HTTP, no Drizzle, no database:
the facts the optimizer needs from the database (tag aliases) are handed to it
as plain data. The SQL Builder lives in Core, next to the schema it targets.

## auth

Session-based authentication and the permission model. Issues and validates
sessions; resolves a request's identity and permissions for Services.

## events

Simple publish/subscribe system. Core emits events; plugins subscribe.

## storage

Defines `StorageProvider`. Implementations: Filesystem, S3, MinIO,
Cloudflare R2.

## plugin-sdk

The integration surface for feature modules. The single package plugins are
allowed to import — kept stable so features stay cleanly removable and Core
never has to know they exist.

---

# Dependency Rules

Allowed (inward only):

```
apps  →  plugins  →  plugin-sdk  →  core  →  db
```

Plugins may import **only** `plugin-sdk` — never `core` or `db` directly.

Forbidden:

- `db → core`
- `plugins → apps`
- `core → plugins`
- `plugins → core` / `plugins → db`

---

# Request Lifecycle

```
HTTP Request → Validation → Controller → Service → Repository → Database
            → Service → DTO → JSON
```

Routes never contain business logic.

---

# Upload Pipeline

```
Upload → Validation → Temporary Storage → Hash → Ingest Guards → Dedupe
       → Metadata → Persist Asset → Emit AssetCreated → Background Jobs
```

Every source (one-shot, resumable, importers) goes through one ingest
function, so a step there covers them all by construction.

**Ingest guards** are plugin checks every upload must pass (`banned-hashes`
refuses banned sha256/md5). They run after the hash pass, before dedupe (a
banned file can't be laundered through a stored copy) and before any decode (a
refusal costs one hash pass). The first refusal is a 403 with its reason.
Guards fail closed: a throw or a 5s overrun refuses the upload (503), and an
admin deactivates the broken plugin. Byte-rewriting transforms (EXIF strip)
are designed but not built: see `docs/03-ingest-hooks.md`.

Background jobs triggered: Thumbnail, OCR, AI, Notifications, Search Index.

---

# Search Pipeline

```
Query String → Lexer → Tokens → Parser → AST
             → (Core) fetch aliases for the AST's tag names, in one lookup
             → Optimizer (alias rewriting, flattening, dedupe) → AST
             → (Core) SQL Builder → Repository → Database
```

The AST is the canonical representation. Everything else consumes AST.

Tag implications are not expanded here: implied tags are materialized onto
posts when tagged (and backfilled when an implication is created), so a search
for `animal` is a plain tag lookup.

---

# Plugin Lifecycle

```
Startup → Load Enabled Plugins → Register Services → Register Routes
        → Register Events → Register Search Providers
        → Register Permissions → Ready
```

## Enabling Features

Plugins are optional, **first-party feature modules** that live in the repo
under `plugins/` — not separately distributed packages. Each is a
self-contained feature (Comments, Favorites, …) that integrates with the Core
through `plugin-sdk` and can be switched **on or off** without touching Core.

```
plugins/
  comments/
    index.ts   entry point — registers routes, tables, events via plugin-sdk
```

- On/off is switched **at runtime** from Admin → Extensions; the state lives
  in Core's `plugin_states` table (`ENABLED_PLUGINS` only seeds it on first
  boot). Every known plugin is loaded and its routes mounted at startup; an
  inactive one's routes 404 and its capabilities (mail transport, search
  metatags) are uninstalled, with no restart.
- No marketplace, no manifests to resolve, no network.
- Because features build and ship together with Core, they share one
  `plugin-sdk` version. Integration is a compile-time contract, not a runtime
  compatibility negotiation.

## Plugin UI

A plugin's backend lives in its package; its UI lives in the web app, since
`plugins → apps` is forbidden (a plugin can't import the Eden client, router
or styles). `apps/web/src/plugins/registry.tsx` lists, per plugin:

- **Slot widgets**: named places on a page (`admin`, `post-detail-aside`), a
  closed union, each with the props the app supplies there;
- **Pages**: plugin-owned routes (`/favorites`, `/pools/:id`), declared in
  `router.tsx` so links stay typed;
- **Menu links** in the header and home page.

Each renders only while its plugin is active (`GET /api/v1/plugins`). Every
widget and page is lazy-loaded (its own chunk) and isolated by its own error
and Suspense boundary, so one broken plugin can't take a page down. Visibility
(anonymous / member / moderator) is a UX hint; the plugin's routes enforce
their own authorization. Slots are added when a real widget needs one. See
[docs/01-plugin-ui-slots.md](./docs/01-plugin-ui-slots.md).

---

# Event Lifecycle

```
AssetCreated → Thumbnail → OCR → AI → Notification → Analytics
```

Plugins never call each other directly.

---

# Storage

Core never accesses files — always through a `StorageProvider`.

Required methods: `store()`, `delete()`, `exists()`, `stream()`, `copy()`,
`move()`, `getPublicUrl()`.

Future providers should require zero Core changes.

Keys are sharded so no directory (or object-store prefix) grows unbounded.
Originals are content-addressed: `assets/<aa>/<bb>/<sha256>.<ext>`, by hash
prefix. Thumbnails: `plugins/thumbnailer/<aa>/<bb>/<id>.webp`, by the id's low
16 bits. Files are never looked up by listing: each row stores its exact key.

---

# Search Providers

Search is extensible.

Core handles tags and its own metatags: `rating:`, `id:`, `width:`,
`height:`, `size:`, `views:`, `tagcount:`, `date:`, `user:`, `md5:`, plus
`order:`.

A plugin contributes metatags through `PluginRegistration.searchProviders`;
today `fav:` (favorites) and `pool:` (pools). A provider compiles one term to
a SQL condition over the plugin's OWN tables, correlated to the post being
matched through `asset.id`:

```
fav:alice → favorites plugin → exists (select 1 from favorites_posts f
                                        where f.asset_id = <asset.id> and f.user_id = $1)
```

Core composes it with every other term (AND, OR, negation) and stays unaware
of favorites. Providers are registered while their plugin is active, and a key
that collides with Core's or another plugin's fails that plugin's activation.

---

# Authentication

Session-based. On sign-in the server creates a session row and sets an
`httpOnly`, `SameSite` cookie; no token is exposed to JavaScript.

```
Sign-in → Verify credentials → Create session row → Set httpOnly cookie
Request → Read cookie → Load session → Resolve identity + permissions
```

- Sessions are server-side (Postgres), so revocation is immediate.
- Passwords hashed with `Bun.password`.
- Programmatic / CLI access uses long-lived API keys mapped to a user, checked
  the same way after the cookie step.

# Permissions

```
Role → Permission → Action → Resource
```

Never hardcode admin checks. Everything uses permissions.

---

# Database

Repositories are the only database access layer.

- Controllers never use Drizzle.
- Services never use SQL.
- Repositories never know HTTP.

---

# Background Jobs

Every long-running task becomes a Job (thumbnail, OCR, AI, metadata, virus
scan, watermark).

Jobs are retryable, resumable, and idempotent. The queue is **Postgres-backed**
(the `jobs` table) to satisfy these durability guarantees without a Redis
requirement; Redis may be added later as an optional accelerator only.

```
enqueue(kind, payload) → jobs row (queued) → runner claims (running, leased)
  → handler.run → done
                → throws → queued again after backoff (30s, 1m, 2m … 1h)
                         → out of attempts → failed (admin console: Retry,
                           refused while the same idempotency key is pending)
```

- **Kinds** are `<owner>:<name>`. A plugin registers handlers by local name
  (`jobs: { thumbnail: { run } }`) and queues with `ctx.jobs.enqueue("thumbnail",
  payload)`; both are namespaced to `<plugin>:thumbnail`. Handlers are a
  capability: installed while the plugin is active, removed when it isn't. Jobs
  whose kind has no handler wait for one.
- **Claiming** uses `FOR UPDATE SKIP LOCKED`, so any number of runners share one
  database without claiming the same job. A claim takes a lease (the handler's
  `timeoutMs`); a runner that dies leaves its job to be claimed again once the
  lease lapses. Attempts are counted at claim time, so a job that keeps
  crashing its runner still runs out. Outcomes are fenced by the lease: a
  runner that overran and lost its job can't complete or re-queue it.
- **Idempotency keys** dedupe *pending* jobs only (`thumb:42`): once a job
  finishes, the same key may be queued again.
- **Where jobs run:** the API runs them by default (`JOBS_RUNNER=inline`,
  `JOBS_CONCURRENCY`). For heavier loads, set `JOBS_RUNNER=off` and start
  `bunbooru worker` processes beside it: the same binary with no HTTP, which
  re-reads the plugin active set every 15s.
- **Retention:** done jobs are pruned after 7 days, failed ones after 30.

---

# API

REST first. JSON. Cursor pagination. Stable.

Versioned by URL path: `/api/v1/...`. A version is additive-only once shipped;
breaking changes ship under a new path (`/api/v2`). The old version stays until
formally deprecated.

GraphQL may exist later as a plugin.

---

# Images

```
Original → Sample → Thumbnail → Tiny Thumbnail
```

Generated asynchronously. Never resize originals during requests.

---

# Future Media

Asset is intentionally generic. Supported later: Video, GIF, Audio, PDF, 3D
Models, Archives. The Asset model should never assume "image".

---

# AI

AI is optional. Interfaces: `TagProvider`, `OCRProvider`, `EmbeddingProvider`,
`CaptionProvider`. Core never depends on AI.

---

# Configuration

Everything configurable: Storage, Search, Workers, AI, Authentication,
Plugins.

No feature flags inside Core. Features become plugins.

---

# Error Handling

- Errors are typed; never throw raw strings.
- Never expose stack traces.
- Use `Result<T, E>` where practical.

---

# Observability

- Every request has a Request ID.
- Every Job has a Job ID.
- Every Event has an Event ID.
- Structured logging only.

---

# Scalability

```
Single Node → Multiple Workers → Remote Storage → CDN
            → Read Replicas → Search Cluster (optional)
```

The architecture should remain identical across these stages.

---

# Testing

- **Unit** — Lexer, Parser, Repositories
- **Integration** — Plugins, Services
- **E2E** — REST API, Upload, Search, Authentication

---

# Non Goals

Microservices, Kubernetes, Redis requirement, Elasticsearch requirement,
Cloud-only deployment, heavy frameworks.

---

# Design Philosophy

The architecture should make simple things easy, complex things possible, and
incorrect things difficult.

The best code is code that plugins never have to modify.
