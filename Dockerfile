# syntax=docker/dockerfile:1

# ── Stage 1: build the standalone backend binary ──────────────────────────────
# oven/bun:1 is Debian/glibc-based, so the compiled binary links glibc and runs
# on the distroless glibc runtime below. (Don't swap to an Alpine/musl builder
# without also swapping the runtime — the libc families must match.)
FROM oven/bun:1 AS builder
WORKDIR /app

# Manifests first for layer caching; workspace members are needed before install.
COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY plugins ./plugins

RUN bun install --frozen-lockfile
RUN bun run build:api

# ── Stage 2: minimal runtime ──────────────────────────────────────────────────
# Distroless: no shell, no package manager — just glibc + the binary.
FROM gcr.io/distroless/base-debian12 AS runtime
WORKDIR /app

COPY --from=builder /app/apps/api/dist/bunbooru /app/bunbooru

ENV NODE_ENV=production
# Runtime config (DATABASE_URL, etc.) is injected at `docker run`, never baked in.
EXPOSE 3000
ENTRYPOINT ["/app/bunbooru"]
