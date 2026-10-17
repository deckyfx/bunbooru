import { treaty } from "@elysiajs/eden";

import type { ReportsPluginApp } from "@bunbooru/plugin-reports";

import { treatyOptions, treatyOrigin } from "../../lib/api";

/**
 * Typed Eden client for the reports plugin's routes, built from the plugin's
 * own exported {@link ReportsPluginApp} type (paths include the
 * `/api/v1/plugins/reports` prefix).
 */
export const reportsPluginApi = treaty<ReportsPluginApp>(treatyOrigin, treatyOptions);

/** The plugin's routes. */
export const reportsApi = reportsPluginApi.api.v1.plugins.reports;

/** Query keys: every report query sits under this prefix, so a change refreshes them all. */
export const REPORTS_KEY = ["reports"] as const;

/** The statuses the queue can be filtered by. */
export const REPORT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Whether an Eden error is the HTTP status `status`. */
export function isStatus(error: unknown, status: number): boolean {
  return error !== null && typeof error === "object" && (error as { status?: unknown }).status === status;
}
