import { treaty } from "@elysiajs/eden";

import type { PoolsPluginApp } from "@bunbooru/plugin-pools";

import { treatyOptions, treatyOrigin } from "../../lib/api";

/**
 * Typed Eden client for the pools plugin's routes, built from the plugin's own
 * exported {@link PoolsPluginApp} type (paths include `/api/v1/plugins/pools`).
 */
export const poolsApi = treaty<PoolsPluginApp>(treatyOrigin, treatyOptions);

/** The pools routes, one level down (every call starts here). */
export const pools = poolsApi.api.v1.plugins.pools;

/** A pool name for display: underscores (how names are stored) as spaces. */
export const displayName = (name: string) => name.replace(/_/g, " ");
