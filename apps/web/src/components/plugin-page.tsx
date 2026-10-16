import type { ComponentType } from "react";

import { Link } from "@tanstack/react-router";

import { IsolatedWidget, useActivePluginIds } from "./plugin-slot";

/**
 * A page a plugin owns (`/favorites`, `/pools/12`). The route is compiled into
 * the app like any other, so links to it stay typed, but it shows a not-found
 * page while its plugin is inactive. The page itself is isolated like a slot
 * widget: a broken plugin page can't take the app shell down with it.
 */
export function PluginPage({
  pluginId,
  title,
  page: Page,
}: {
  pluginId: string;
  title: string;
  page: ComponentType;
}) {
  const { ids, isLoading, isError, retry } = useActivePluginIds();
  if (isLoading) return null;
  // Couldn't load the plugin list: say so (with a retry) rather than claiming
  // the plugin doesn't exist.
  if (isError) {
    return (
      <div className="py-16 text-center">
        <p className="mb-2 font-bold">Couldn’t load this page</p>
        <button type="button" onClick={retry} className="text-[12px] text-link hover:underline">
          Retry
        </button>
      </div>
    );
  }
  if (!ids.has(pluginId)) {
    return (
      <div className="py-16 text-center">
        <p className="mb-2 font-bold">Not found</p>
        <p className="text-[12px] text-muted">
          {title} isn’t available on this site.{" "}
          <Link to="/posts" className="text-link hover:underline">
            Browse posts
          </Link>
        </p>
      </div>
    );
  }
  return (
    <IsolatedWidget label={title}>
      <Page />
    </IsolatedWidget>
  );
}
