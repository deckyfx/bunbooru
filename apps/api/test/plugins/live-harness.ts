import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime, type Core, type DB } from "@bunbooru/core";

import { jobsBinding, searchBinding } from "../../src/plugins/capability-bindings";
import { createPluginHost } from "../../src/plugins/host";
import { loadPlugins } from "../../src/plugins/loader";
import { createApp } from "../../src/server";

/** The opt-in destructive test database (see test-setup.ts for the guard). */
export const TEST_DATABASE_URL = Bun.env.TEST_DATABASE_URL?.trim();

/** A 1×1 PNG. Appending a suffix makes each copy a distinct upload (new sha256). */
const PNG_1x1 = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** Bytes of a unique tiny image. */
export function uniqueImage(label: string): Uint8Array {
  return new Uint8Array([...PNG_1x1, ...new TextEncoder().encode(label)]);
}

/** A running API over the real Core and the real, migrated plugins. */
export interface LiveApi {
  core: Core;
  db: DB;
  /** Send a request to `/api/v1…` (path relative to it), optionally as a user. */
  request(path: string, init?: RequestInit & { token?: string }): Promise<Response>;
  /** Register a user; the first one becomes admin. Returns their session token. */
  user(username: string): Promise<{ id: number; token: string }>;
  /** Upload a distinct post as `uploaderId`. */
  post(label: string, uploaderId: number): Promise<number>;
  close(): Promise<void>;
}

/**
 * Boot the API's composition (Core → plugin loader, which runs the plugins'
 * REAL embedded migrations → plugin host → app with plugin routes mounted)
 * against the test database, with `pluginIds` active. The integration tests for
 * a plugin go through this, so they cover exactly what production runs.
 */
export async function bootLive(pluginIds: string[]): Promise<LiveApi> {
  const storageRoot = await mkdtemp(join(tmpdir(), "bunbooru-live-"));
  const { core, db, storage } = createCoreRuntime({
    databaseUrl: TEST_DATABASE_URL as string,
    storageRoot,
    maxUploadBytes: 1_000_000,
    maxResumableUploadBytes: 1_000_000,
    requestBodyCeilingBytes: 2_000_000,
    sessionExpiryMs: 24 * 60 * 60 * 1000,
    publicBaseUrl: null,
    requireVerifiedEmailForReset: false,
  });
  const loaded = await loadPlugins({ core, db, storage, enabledIds: pluginIds });
  const host = createPluginHost({
    pluginState: core.pluginStateService,
    loaded,
    seedActiveIds: pluginIds,
    capabilityBindings: [searchBinding(core.searchProviders), jobsBinding(core.jobService)],
  });
  await host.init();
  for (const id of pluginIds) await host.activate(id);
  const app = createApp({ core, host, storage });
  for (const plugin of loaded) if (plugin.routes) app.use(plugin.routes);

  return {
    core,
    db,
    request(path, { token, headers, ...init } = {}) {
      return app.handle(
        new Request(`http://localhost/api/v1${path}`, {
          ...init,
          headers: {
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(headers as Record<string, string> | undefined),
          },
        }),
      );
    },
    async user(username) {
      const { token, user } = await core.authService.register({ username, password: "password123" });
      return { id: user.id, token };
    },
    async post(label, uploaderId) {
      const { asset } = await core.assetService.create({ bytes: uniqueImage(label), uploaderId });
      return asset.id;
    },
    async close() {
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}
