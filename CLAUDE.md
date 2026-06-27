# CLAUDE.md

## Purpose

This document defines the architecture and development philosophy of the project.

AI assistants should prioritize these rules over convenience.

---

# Philosophy

The project values:

- Simplicity
- Extensibility
- Type safety
- Performance
- Readability

Avoid unnecessary abstractions. Avoid overengineering.

---

# Core Rule

The Core must remain small.

The Core only owns:

- Assets
- Tags
- Collections
- Users
- Authentication
- Permissions
- Search Engine
- Event Bus
- Plugin SDK

Everything else belongs in plugins.

---

# Plugin Rule

If a feature can reasonably be optional, it MUST become a plugin.

Examples: Comments, Favorites, Notes, Pools, Wiki, AI, OCR, Notifications, RSS, Email.

---

# Dependency Rule

Packages may depend inward, never outward:

```
apps  →  plugins  →  plugin-sdk  →  core  →  db
```

Plugins may import **only** `plugin-sdk`. Reaching into `core` or `db`
directly is forbidden — `plugin-sdk` is the single integration surface that
keeps features cleanly removable and Core unaware of them.

Plugins are optional first-party feature modules (in-repo, toggled on/off via
config), not separately distributed packages.

Forbidden directions:

- `db → core`
- `core → plugins`
- `plugins → apps`
- `plugins → core` / `plugins → db` (go through `plugin-sdk` instead)

---

# Search Rule

Never generate SQL directly from text.

```
Query → Lexer → Parser → AST → Optimizer → SQL Builder
```

The AST is the source of truth.

---

# Database Rule

Never place SQL inside route handlers. Always go through the layers:

```
Repository → Service → Route
```

---

# Storage Rule

Never access the filesystem directly. Always use a `StorageProvider`.

Filesystem, S3, R2, and MinIO must all implement the same interface.

---

# Event Rule

Core communicates through events. Never tightly couple modules.

```
AssetCreated → Thumbnail → OCR → AI → Notification
```

---

# Plugin API

Plugins may register:

- Routes
- Database tables
- Search providers
- Storage providers
- Background jobs
- Permissions
- Admin pages
- Event listeners
- Navigation items
- Commands

---

# Performance

- Avoid N+1 queries; prefer batch operations.
- Prefer streaming uploads.
- Never load original images unless necessary.
- Generate thumbnails asynchronously.

---

# TypeScript

- Strict mode enabled.
- No `any`.
- Prefer inferred types.
- Use discriminated unions.
- Use `Result<T, E>` where appropriate.

---

# Testing

- Every parser requires tests.
- Every repository requires tests.
- Every plugin requires integration tests.

---

# Coding Style

- Small files, single responsibility.
- Pure functions whenever possible.
- Composition over inheritance.
- Avoid classes unless stateful behavior is required.

---

# Future

Design for **10 assets → 10 million assets** without changing architecture.

Optimize implementation later. Never sacrifice maintainability for premature optimization.
