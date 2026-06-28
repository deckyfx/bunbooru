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

Requires [Bun](https://bun.sh) and Docker.

```bash
cp .env.example .env       # configure local environment
bun install                # install workspace dependencies
bun run services:up        # start Postgres (the required service)
bun run migrate            # apply database migrations
bun run typecheck          # verify the workspace compiles
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

## Current Status

🚧 Early Development

See [PROJECTPRD.md](./PROJECTPRD.md) for the roadmap and
[ARCHITECTURE.md](./ARCHITECTURE.md) for the design.
