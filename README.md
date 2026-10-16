# Bunbooru

A modern, extensible Booru engine built with Bun.

> Not a Danbooru clone.
> A plugin-first media platform inspired by Booru imageboards.

## Goals

- Fast
- Type-safe
- API-first
- Self-hostable
- Plugin-based
- AI-ready
- Home-lab friendly
- Scalable to millions of assets

## Tech Stack

**Backend** — Bun, ElysiaJS, Drizzle ORM, PostgreSQL

**Frontend** — React, TailwindCSS, TanStack Router, TanStack Query

**Storage** — Filesystem, S3-compatible storage (future)

## Features

### Core

- Asset management
- Tagging
- Collections
- Search language
- Authentication
- Permissions
- Upload pipeline

### Optional Plugins

Built: **Favorites**, **Pools**, **Thumbnails**, **Shimmie2 import**,
**SMTP mail**. Switched on and off at runtime under Admin → Extensions.

Planned:

- Comments
- Notes
- Wiki
- AI Tagging
- OCR
- Translation
- Similar Image Search
- Embeddings

## Search Syntax

Terms are separated by spaces and all must match. Tag aliases apply to every
tag term (`kitty` finds posts tagged `cat`).

| Term | Meaning |
|---|---|
| `cat solo` | tagged both `cat` and `solo` |
| `-monochrome` | not tagged `monochrome` |
| `~cat ~dog` | tagged `cat` or `dog` |
| `cat*` | any tag starting with `cat` |
| `rating:safe` | `safe`, `questionable`, `explicit` or `unrated` |
| `id:` `width:` `height:` `size:` `views:` `tagcount:` | numbers: `id:42`, `width:>1920`, `tagcount:0`, `size:1000..5000` (bytes) |
| `date:` | upload date, whole UTC days: `date:2026-10-15`, `date:>=2026-01-01`, `date:2026-01-01..2026-03-31` |
| `user:alice` | uploaded by `alice` |
| `md5:<digest>` | the post with that file hash |
| `order:` | sort: `id`, `id_desc` (default), `date`, `date_asc`, `views`, `views_asc`, `size`, `size_asc`, `tagcount`, `tagcount_asc`, `random` |
| `fav:alice` | favorited by `alice` (Favorites plugin) |
| `pool:12`, `pool:my_comic` | in that pool, by id or name (Pools plugin) |

Comparisons are `>`, `>=`, `<`, `<=`, or a range `lo..hi` (either end may be
left open). A term that can't be understood, such as an unknown key or a
malformed date, is ignored rather than matching nothing.

## Philosophy

Everything is a plugin.

The core should only understand:

- Assets
- Tags
- Collections
- Users
- Search
- Plugins

Everything else extends the core.

## Project Structure

```
apps/
  api/        REST API (Elysia), and the background job worker
  web/        React client

packages/
  core/       Domain: Asset, Tag, Collection, User, Permission
  db/         Drizzle schemas, repositories, migrations
  search/     Lexer, parser, AST, optimizer, SQL builder
  events/     Publish/subscribe event bus
  storage/    StorageProvider interface + implementations
  auth/       Authentication & permissions
  plugin-sdk/ Public API for plugins

plugins/
docs/
```

## Getting Started

Requires [Bun](https://bun.sh) ≥ 1.4.3 (for `bun check`) and Docker.

```bash
cp .env.example .env       # configure local environment
bun install                # install workspace dependencies
bun run services:up        # start Postgres (the required service)
bun run migrate            # apply database migrations
bun run typecheck          # type-check every workspace (`bun check`)
bun run test               # run the test suite
```

Service data is bind-mounted under `./data` (git-ignored), so all state lives in
the project folder — `bun run services:down` keeps it; delete `./data` to wipe it.

After editing `packages/db/src/schema.ts`, regenerate and apply migrations:

```bash
bun run db:generate        # emit SQL from the schema into packages/db/drizzle
bun run migrate            # apply pending migrations
```

Redis is optional — Core never requires it. Start it only when needed:

```bash
bun run services:up:redis  # Postgres + Redis
bun run services:down      # stop services
```

## Development

One server, one port, the same shape as production:

```bash
bun run dev                # API + web app on :3000 (SERVER_PORT), with hot reload
```

`scripts/dev.ts` boots the API and serves the web app's HTML entry from the same
port; Bun bundles it on the fly. Web changes hot-reload in the browser; server
changes restart the process. The API and web app remain separate projects: only
this launcher imports both.

Two separate servers are still available when you want them:

```bash
bun run dev:api            # API only, on :3000
bun run dev:web            # web on :3001 (WEB_PORT), proxies /api/* to the API
```

## Production: one binary, one port

`bun run build` produces a single self-contained executable at
`apps/api/dist/bunbooru`:

1. embeds every package's and plugin's migrations (applied automatically at boot);
2. builds the web SPA (`apps/web/build.ts`) into static files;
3. compiles the API with those files embedded.

The binary serves the site and `/api/v1` from one port (`SERVER_PORT`, default
3000), with no `dist/` or `drizzle/` folder needed beside it. Configure it
through the environment: `DATABASE_URL`, `STORAGE_ROOT` and `PUBLIC_BASE_URL` at
minimum (see `.env.example`).

```bash
bun run build              # → apps/api/dist/bunbooru
bun run docker:build       # the same binary in a distroless image (port 3000)
```

## Background jobs

Long or retryable work (thumbnails, imports) goes through a durable job queue in
Postgres: jobs survive restarts, retry with backoff, and each runs on one runner
at a time (unless it overruns its lease, when another runner may take it over).
By default the server runs them itself. To move them to a separate process, run
the API with `JOBS_RUNNER=off` and start a worker beside it, with the same
environment as the server (it runs the same boot checks):

```bash
bun run worker             # dev: the job runner alone, no HTTP
./bunbooru worker          # the production binary, likewise
docker run … <image> worker  # the Docker image (the binary is its entrypoint)
```

Several workers may run at once. `JOBS_CONCURRENCY` (default 2) sets how many
jobs each runs in parallel.

## Current Status

🚧 Early Development

See [PROJECTPRD.md](./PROJECTPRD.md) for the roadmap and
[ARCHITECTURE.md](./ARCHITECTURE.md) for the design.
