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
  worker/

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

REST API, authentication, validation, OpenAPI. No business logic.

## worker

Background jobs: thumbnail generation, OCR, AI, metadata extraction, image
conversion. Never exposes HTTP.

## web

React application. Consumes the public API only. Never directly accesses the
database.

## core

Contains: Asset, Tag, Collection, User, Permission. No optional features.

## db

Drizzle schemas, repositories, migrations, transactions, database adapters.

## search

Owns the Lexer, Parser, AST, Optimizer, and SQL Builder. No HTTP, no Drizzle,
no database.

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
Upload → Validation → Temporary Storage → Hash → Metadata
       → Persist Asset → Emit AssetCreated → Background Jobs
```

Background jobs triggered: Thumbnail, OCR, AI, Notifications, Search Index.

---

# Search Pipeline

```
Query String → Lexer → Tokens → Parser → AST → Optimization
             → Query Builder → Repository → Database
```

The AST is the canonical representation. Everything else consumes AST.

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

- On/off is controlled by central config (a list of enabled plugins). A
  disabled plugin is simply never registered — Core contains no branching
  logic for it.
- Turning a feature on = enable it in config and restart. No marketplace, no
  manifests to resolve, no network.
- Because features build and ship together with Core, they share one
  `plugin-sdk` version. Integration is a compile-time contract, not a runtime
  compatibility negotiation.

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

---

# Search Providers

Search is extensible.

Core registers: `tag:`, `rating:`, `width:`, `height:`, `score:`.

Plugins may register: `comment:`, `note:`, `favorite:`, `ocr:`, `embedding:`.

```
comment:"hello" → CommentPlugin → SQL fragment
```

Core remains unaware of comments.

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
to satisfy these durability guarantees without a Redis requirement; Redis may
be added later as an optional accelerator only.

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
