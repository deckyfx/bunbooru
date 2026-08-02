import type { AnyElysia } from "elysia";

import {
  AuthenticationError,
  AuthorizationError,
  canModerate,
  canWrite,
  isOwnerOrAdmin,
} from "@bunbooru/core";
import type {
  AssetService,
  AuthService,
  CoreEvents,
  DB,
  SettingsService,
  StatsService,
  StorageProvider,
  TagService,
  User,
} from "@bunbooru/core";

/**
 * `@bunbooru/plugin-sdk` — the single integration surface for feature modules.
 *
 * Plugins (optional, first-party, toggled on/off via config) import ONLY this
 * package — never `core` or `db` directly. Keeping this surface stable is what
 * lets features stay cleanly removable and keeps Core unaware they exist.
 *
 * A plugin declares itself with {@link definePlugin}; the host (the API
 * composition root) applies its {@link BunbooruPlugin.migrations}, then calls
 * {@link BunbooruPlugin.register} with a live {@link PluginContext} (Core
 * services, the event bus, a scoped DB handle, request auth, a logger) and
 * mounts the returned {@link PluginRegistration.routes} under
 * `/api/v1/plugins/<id>`.
 */
export const PLUGIN_SDK_VERSION = "0.3.0" as const;

/** Storage contract re-exported for plugins that register storage providers. */
export type { StorageProvider };

/**
 * The integration points a plugin may register through this SDK.
 *
 * This vocabulary is SDK-owned and part of the public contract — intentionally
 * decoupled from internal package identifiers, so refactors inside
 * `core`/`auth`/`events`/`search` never become breaking SDK changes. Not every
 * capability is wired yet; `routes`, `admin-pages`, and `tables` are the ones
 * the current registration API supports.
 */
export const SDK_CAPABILITIES = [
  "routes",
  "tables",
  "events",
  "search-providers",
  "storage-providers",
  "permissions",
  "jobs",
  "admin-pages",
  "navigation-items",
  "commands",
] as const;

/** A single capability a plugin may register through the SDK. */
export type SdkCapability = (typeof SDK_CAPABILITIES)[number];

/**
 * The Core application services a plugin may compose over. These are the same
 * service instances the API routes use — a plugin never reaches into
 * repositories or the raw schema for Core data, it goes through these.
 */
export interface PluginServices {
  /** Assets: ingest (hash → dedupe → sniff → store), list, fetch, update. */
  assets: AssetService;
  /** Tag taxonomy + asset↔tag application (normalization, set/diff, postCount). */
  tags: TagService;
  /** Traffic counters — per-post views + daily unique visitors. */
  stats: StatsService;
  /** Admin-editable runtime settings (upload caps). */
  settings: SettingsService;
  /** Accounts + sessions + API keys — used to resolve the request's caller. */
  auth: AuthService;
}

/**
 * Per-request auth helper, bound by the host: resolves the caller from an HTTP
 * request (Bearer header or session cookie) so a plugin route can gate itself.
 * Pair it with {@link canModerate}/{@link isOwnerOrAdmin} and throw
 * {@link AuthenticationError}/{@link AuthorizationError} to return 401/403.
 */
export interface PluginAuth {
  /** The authenticated user for this request, or null when anonymous. */
  currentUser(request: Request): Promise<User | null>;
}

/** Structured, plugin-namespaced logger the host injects. */
export interface PluginLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Everything a plugin receives at registration time, injected by the host.
 *
 * `db` is the full Core Drizzle handle — a plugin MUST only read/write tables it
 * declares itself (via {@link BunbooruPlugin.migrations}) and go through
 * {@link PluginContext.services} for all Core data. This is the pragmatic
 * shimmie-style tradeoff: plugins own their tables, Core stays unaware of them.
 */
export interface PluginContext {
  /** Core application services (see {@link PluginServices}). */
  services: PluginServices;
  /** Typed domain event bus — subscribe to `asset.created`, etc. */
  events: CoreEvents;
  /** Request-scoped auth resolution (see {@link PluginAuth}). */
  auth: PluginAuth;
  /** Drizzle handle for the plugin's OWN tables (see the note above). */
  db: DB;
  /**
   * A {@link StorageProvider} for the plugin's OWN binary artifacts (e.g. a
   * thumbnailer's generated images). The host injects a handle **namespaced to
   * the plugin** (keys are transparently prefixed with `plugins/<id>/`), so a
   * plugin can't read or clobber Core's `assets/…` objects or another plugin's.
   * Pass plain keys (e.g. `<sha>.webp`); the namespacing is invisible to the plugin.
   */
  storage: StorageProvider;
  /** Namespaced logger. */
  log: PluginLogger;
}

/**
 * A plugin admin page, surfaced to the web `/admin` console. Metadata only — the
 * UI component is registered app-side, keyed by plugin id. The server enforces
 * its own authorization on the plugin's routes regardless of this listing.
 */
export interface AdminPage {
  /** Stable slug, unique within the plugin. */
  id: string;
  /** Section/nav label shown in the admin console. */
  title: string;
}

/**
 * Where a plugin's generated SQL lives and how its applied migrations are
 * tracked. The host runs these (via Drizzle's migrator) before {@link
 * BunbooruPlugin.register}, so a plugin's tables exist by the time its routes
 * run.
 */
export interface PluginMigrations {
  /** Absolute path to the plugin's Drizzle output folder (its `drizzle/`). */
  migrationsFolder: string;
  /**
   * Dedicated tracking table so plugin migrations never collide with Core's
   * `__drizzle_migrations`. Convention: `__drizzle_migrations_<pluginId>`.
   */
  migrationsTable: string;
}

/** What {@link BunbooruPlugin.register} returns: the plugin's routes + pages. */
export interface PluginRegistration {
  /**
   * An Elysia app carrying the plugin's routes. It MUST be constructed with the
   * prefix from {@link pluginRoutePrefix} so paths resolve under
   * `/api/v1/plugins/<id>` and a typed Eden client on the web lines up. Typed as
   * {@link AnyElysia} so a plugin's concrete route/prefix generics are accepted.
   */
  routes?: AnyElysia;
  /** Admin pages this plugin contributes to the web console. */
  adminPages?: AdminPage[];
}

/**
 * The plugin contract. `migrations` is read statically (before `register`) so
 * the host can apply schema changes first; `register` wires routes and admin
 * pages over the injected {@link PluginContext}.
 */
export interface BunbooruPlugin {
  /** Stable, unique plugin id — also its route prefix segment. */
  id: string;
  /** Human-readable name for the admin console + logs. */
  name: string;
  /** Plugin version (independent of the SDK version). */
  version: string;
  /**
   * One-line summary shown on the admin "Extensions" management cards. Read
   * statically (no `register`), so it's available for inactive plugins too.
   */
  description?: string;
  /**
   * The SDK capabilities this plugin uses (e.g. `["routes", "admin-pages"]`) —
   * surfaced as badges in the management UI. Purely descriptive; the host does
   * not gate on it.
   */
  capabilities?: readonly SdkCapability[];
  /** Optional plugin-owned tables + migration tracking. */
  migrations?: PluginMigrations;
  /** Wire routes/pages over the injected context. May be async. */
  register(context: PluginContext): PluginRegistration | Promise<PluginRegistration>;
}

/**
 * Declare a plugin. An identity helper — it exists purely so a plugin gets full
 * type inference/checking against {@link BunbooruPlugin} at its single import
 * surface.
 */
export function definePlugin(plugin: BunbooruPlugin): BunbooruPlugin {
  return plugin;
}

/**
 * The canonical HTTP mount prefix for a plugin's routes:
 * `/api/v1/plugins/<id>`. A plugin builds its Elysia app with this prefix so the
 * host can mount it directly and the web's typed client resolves the same paths.
 *
 * Returns a template-LITERAL type (not `string`) so, when called with a literal
 * id, Elysia captures the exact prefix in its type — which is what lets a typed
 * Eden client on the web resolve the full `/api/v1/plugins/<id>/…` path.
 */
export function pluginRoutePrefix<Id extends string>(id: Id): `/api/v1/plugins/${Id}` {
  return `/api/v1/plugins/${id}`;
}

// Authorization predicates + auth errors, re-exported so plugin routes gate
// themselves through the SDK (never importing `@bunbooru/core` directly).
export { AuthenticationError, AuthorizationError, canModerate, canWrite, isOwnerOrAdmin };

// Domain types plugins need in their signatures, re-exported from Core.
export type {
  AssetService,
  AuthService,
  CoreEvents,
  DB,
  SettingsService,
  StatsService,
  TagService,
  User,
};
