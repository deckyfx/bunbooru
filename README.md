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

- Comments
- Notes
- Wiki
- Pools
- Favorites
- AI Tagging
- OCR
- Translation
- Similar Image Search
- Embeddings

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
  api/        REST API (Elysia)
  web/        React client
  worker/     Background jobs

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

The API and the web app are separate Bun projects and run as two servers in
development, so the web app gets hot reload:

```bash
bun run dev                # API on :3000 (SERVER_PORT)
bun run dev:web            # web on :3001 (WEB_PORT), proxies /api/* to the API
```

Open the web port; it proxies `/api/*` to the API, so the browser sees one origin.

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

## Current Status

🚧 Early Development

See [PROJECTPRD.md](./PROJECTPRD.md) for the roadmap and
[ARCHITECTURE.md](./ARCHITECTURE.md) for the design.
