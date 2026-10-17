import type { ComponentType } from "react";

import type { LinkProps } from "@tanstack/react-router";

import type { AssetDto, UserDto } from "@bunbooru/api";

/**
 * Plugin UI slots: named places in the app a plugin's widget renders into.
 *
 * A plugin's backend lives in its package, but its UI lives here in the app
 * (`plugins → apps` is forbidden, so a plugin can't import the Eden client,
 * router or styles). Each slot names the props the app supplies at that spot;
 * a widget gets exactly those, never the raw API client.
 *
 * The catalog is deliberately small. Slots are added when a real widget needs
 * one, since each is a rendering contract to keep.
 */
export interface SlotPropsMap {
  /** A plugin's section in the admin console. */
  admin: Record<string, never>;
  /** The post page's sidebar, under the tags and history. */
  "post-detail-aside": { asset: AssetDto };
  /** The post page's main column, under the image (comments). */
  "post-detail-main": { asset: AssetDto };
  /**
   * A layer exactly covering the post's image (notes). Positioned over the
   * image box and click-through by default: a widget makes its own elements
   * interactive with `pointer-events-auto`. Lay things out in percentages of
   * the box, which scales with the displayed image.
   */
  "post-detail-image": { asset: AssetDto };
  /** Above the search results, for the current query (a tag's wiki excerpt). Empty when browsing all posts. */
  "posts-search": { query: string };
}

/** A slot name. Closed: a typo is a type error, not a widget that never renders. */
export type UiSlot = keyof SlotPropsMap;

/**
 * Who a widget is shown to. A UX hint only: the plugin's own routes must still
 * enforce authorization, because hiding a widget hides nothing about the
 * endpoint behind it.
 */
export type Visibility = "anonymous" | "member" | "moderator";

/** One widget a plugin contributes to slot `S`. */
export interface SlotEntry<S extends UiSlot> {
  /** The owning plugin; the widget renders only while it's active. */
  pluginId: string;
  /** Unique within the plugin, so one plugin can fill several spots. */
  id: string;
  /** Label: the nav entry in the admin console, a heading elsewhere. */
  title: string;
  /** Sort key within the slot (default 0); ties break by plugin id, then id. */
  order?: number;
  /** Minimum audience (default everyone). */
  visibility?: Visibility;
  /** The widget. Lazy-loaded, so a plugin's UI isn't in the main bundle. */
  component: ComponentType<SlotPropsMap[S]>;
}

/** Every slot's widgets, keyed by slot. */
export type PluginUiRegistry = { [S in UiSlot]: readonly SlotEntry<S>[] };

/** A plugin's link in the site menus (to one of its pages). */
export interface PluginNavLink {
  pluginId: string;
  label: string;
  to: NonNullable<LinkProps["to"]>;
  order?: number;
  visibility?: Visibility;
}

/** Whether `user` may see something with `visibility`. */
export function isVisibleTo(visibility: Visibility | undefined, user: UserDto | null | undefined): boolean {
  switch (visibility ?? "anonymous") {
    case "anonymous":
      return true;
    case "member":
      return user != null;
    case "moderator":
      return user?.role === "admin";
  }
}

/**
 * The entries to render: owned by an active plugin, visible to `user`, sorted
 * by `order`, then plugin id, then entry id, so the result is fully
 * deterministic whatever order the registry lists them in.
 */
export function selectEntries<T extends { pluginId: string; order?: number; visibility?: Visibility }>(
  entries: readonly T[],
  activeIds: ReadonlySet<string>,
  user: UserDto | null | undefined,
  idOf: (entry: T) => string,
): T[] {
  return entries
    .filter((entry) => activeIds.has(entry.pluginId) && isVisibleTo(entry.visibility, user))
    .sort(
      (a, b) =>
        (a.order ?? 0) - (b.order ?? 0) ||
        a.pluginId.localeCompare(b.pluginId) ||
        idOf(a).localeCompare(idOf(b)),
    );
}
