# Product Requirements Document

# Vision

Create the modern Booru engine.

Not another clone of Danbooru. Instead, create a platform capable of managing
any media library while preserving the excellent tagging and searching
experience Boorus are known for.

---

# Core Principles

## API First

Everything is accessible through REST APIs. The Web UI is just another client.

## Plugin First

Every feature should be removable. Comments, Favorites, Notes, Wiki, AI, and
OCR must all exist as plugins.

## Event Driven

Core emits events. Plugins subscribe.

```
AssetCreated → Thumbnail → OCR → AI Tag → Notification
```

## Database Agnostic (Future)

Current implementation is PostgreSQL. Future targets — MySQL, SQLite,
CockroachDB — are reached through repository adapters.

---

# MVP

- Users
- Authentication
- Assets
- Upload
- Tags
- Collections
- Search
- Permissions
- Admin Panel

---

# Version 0.2

- Comments
- Favorites
- Notes
- Wiki
- Pools
- Aliases
- Tag implications

---

# Version 0.3

- AI Tagging
- OCR
- Reverse Image Search
- Embedding Search
- Translation

---

# Version 1.0

- Stable Plugin SDK
- Public API
- CLI
- Import tools
- Docker deployment
- Documentation

---

# Non Goals

- Microservices
- Kubernetes
- GraphQL (core)
- Elasticsearch
- Redis requirement
- Cloud-only deployment

---

# Key Technical Decisions

These follow from the Non Goals above and are recorded here so they are not
re-litigated per feature:

- **Job queue** — Postgres-backed (no Redis requirement). Jobs must be
  durable, retryable, resumable, and idempotent, so the queue lives in the
  same database. Redis may be used as an optional accelerator later, never a
  hard dependency.
- **Search index** — `< 50ms` on 1M+ assets is met in Postgres via deliberate
  indexing (GIN / trigram on text, a junction/bitmap strategy for tags), not a
  separate search cluster. Elasticsearch stays optional and plugin-shaped.
- **Authentication** — session-based (`httpOnly` cookie + Postgres session
  table). Immediate revocation, no JS-exposed token. CLI / programmatic clients
  use long-lived API keys. No third-party auth dependency required.
- **Plugins** — optional **first-party feature modules** in-repo under
  `plugins/`, toggled on/off via central config. Not separately distributed
  packages; no marketplace, manifest negotiation, or network requirement. They
  build with Core and integrate through `plugin-sdk`.
- **API versioning** — URL path (`/api/v1`). Additive within a version;
  breaking changes ship under a new path.

---

# Success Metrics

- Fresh install: **< 2 minutes**
- Search latency: **< 50ms**
- Thumbnail generation: background jobs
- Toggle a feature (plugin) on/off: one config change + restart
- Supports **1M+ assets** and **100+ plugins**

---

# Long Term

Become the de facto modern Booru engine. Provide a foundation for:

- Imageboards
- Personal galleries
- Photography
- AI datasets
- Manga / Anime
- Game assets
- Document archives
- Research datasets
