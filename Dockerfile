# syntax=docker/dockerfile:1

# ── Stage 1: build the single fullstack binary (API + embedded web SPA) ──────
# oven/bun:1 is Debian/glibc-based, so the compiled binary links glibc and runs
# on the distroless glibc runtime below. (Don't swap to an Alpine/musl builder
# without also swapping the runtime — the libc families must match.)
# Pinned to the toolchain the repo is developed and CI-tested on.
FROM oven/bun:1.4.3 AS builder
WORKDIR /app

# Manifests only, first — so the install layer is cached and only re-runs when a
# package.json or the lockfile changes, not on every source edit.
COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/extension/package.json apps/extension/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/events/package.json packages/events/
COPY packages/storage/package.json packages/storage/
COPY packages/search/package.json packages/search/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY plugins/banned-hashes/package.json plugins/banned-hashes/
COPY plugins/example/package.json plugins/example/
COPY plugins/favorites/package.json plugins/favorites/
COPY plugins/pools/package.json plugins/pools/
COPY plugins/reports/package.json plugins/reports/
COPY plugins/shimmie-import/package.json plugins/shimmie-import/
COPY plugins/smtp-mailer/package.json plugins/smtp-mailer/
COPY plugins/thumbnailer/package.json plugins/thumbnailer/

RUN bun install --frozen-lockfile

# Now the source, then build. `bun run build` embeds the migrations (scripts/),
# builds the web SPA, and compiles the API with that SPA inside it — one binary
# serving the site and /api/v1 on one port.
COPY apps ./apps
COPY packages ./packages
COPY plugins ./plugins
COPY scripts ./scripts
RUN bun run build

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
