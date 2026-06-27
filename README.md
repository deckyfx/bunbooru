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

## Current Status

🚧 Early Development

See [PROJECTPRD.md](./PROJECTPRD.md) for the roadmap and
[ARCHITECTURE.md](./ARCHITECTURE.md) for the design.
