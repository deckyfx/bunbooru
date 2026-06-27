# syntax=docker/dockerfile:1

# ── Stage 1: build the standalone backend binary ──────────────────────────────
# oven/bun:1 is Debian/glibc-based, so the compiled binary links glibc and runs
# on the distroless glibc runtime below. (Don't swap to an Alpine/musl builder
# without also swapping the runtime — the libc families must match.)
FROM oven/bun:1 AS builder
WORKDIR /app

# Manifests only, first — so the install layer is cached and only re-runs when a
# package.json or the lockfile changes, not on every source edit.
COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/auth/package.json packages/auth/
COPY packages/events/package.json packages/events/
COPY packages/storage/package.json packages/storage/
COPY packages/search/package.json packages/search/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY plugins/example/package.json plugins/example/

RUN bun install --frozen-lockfile

# Now the source, then build the API binary.
COPY apps ./apps
COPY packages ./packages
COPY plugins ./plugins
RUN bun run build:api

# ── Stage 2: minimal runtime ──────────────────────────────────────────────────
# Distroless `nonroot` runs as UID 65532 (no shell, no package manager) so the
# bunbooru process never runs as root.
FROM gcr.io/distroless/base-debian12:nonroot AS runtime
WORKDIR /app

COPY --from=builder /app/apps/api/dist/bunbooru /app/bunbooru

ENV NODE_ENV=production
# Runtime config (DATABASE_URL, etc.) is injected at `docker run`, never baked in.
EXPOSE 3000
ENTRYPOINT ["/app/bunbooru"]
