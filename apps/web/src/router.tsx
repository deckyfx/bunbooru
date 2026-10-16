import type { ComponentType } from "react";

import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { PluginPage } from "./components/plugin-page";
import { PLUGIN_PAGES } from "./plugins/registry";
import { AccountPage } from "./routes/account";
import { AdminPage } from "./routes/admin";
import { RootLayout } from "./routes/__root";
import { ForgotPasswordPage } from "./routes/forgot-password";
import { HomePage } from "./routes/home";
import { LoginPage } from "./routes/login";
import { PostDetailPage } from "./routes/post-detail";
import { PostsPage } from "./routes/posts";
import { ResetPasswordPage } from "./routes/reset-password";
import { SetupPage } from "./routes/setup";
import { SignupPage } from "./routes/signup";
import { UploadPage } from "./routes/upload";
import { VerifyEmailPage } from "./routes/verify-email";

const rootRoute = createRootRoute({ component: RootLayout });

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

const postsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/posts",
  component: PostsPage,
  // `q` is the booru search query (tags/metatags) the gallery filters by;
  // `cursor` is the keyset position (an opaque token from the API), kept in the
  // URL so back/forward, refresh and shared links land on the same page.
  validateSearch: (search: Record<string, unknown>): { q?: string; cursor?: string } => {
    const q = typeof search.q === "string" ? search.q.trim() : "";
    const cursor =
      typeof search.cursor === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(search.cursor)
        ? search.cursor
        : "";
    return { ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) };
  },
});

const postDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/posts/$id",
  component: PostDetailPage,
});

const uploadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/uploads/new",
  component: UploadPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signup",
  component: SignupPage,
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: ForgotPasswordPage,
});

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  component: ResetPasswordPage,
});

const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/verify-email",
  component: VerifyEmailPage,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminPage,
});

const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account",
  component: AccountPage,
});

/**
 * First-run setup. The root layout redirects every other route here while the
 * instance has no accounts, and redirects away from here once one exists — so
 * this route is only ever reachable in exactly one state.
 */
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

/**
 * A route a plugin owns. Declared here like any page, so `<Link to=…>` stays
 * typed, but rendered through `PluginPage`: not-found while the plugin is
 * inactive, and isolated from the app shell when active.
 */
function pluginRoute<const Path extends string>(pluginId: string, title: string, path: Path, page: ComponentType) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <PluginPage pluginId={pluginId} title={title} page={page} />,
  });
}

const favoritesRoute = pluginRoute("favorites", "Favorites", "/favorites", PLUGIN_PAGES.favorites);
const poolsRoute = pluginRoute("pools", "Pools", "/pools", PLUGIN_PAGES.pools);
const poolRoute = pluginRoute("pools", "Pools", "/pools/$poolId", PLUGIN_PAGES.pool);

const routeTree = rootRoute.addChildren([
  homeRoute,
  postsRoute,
  postDetailRoute,
  uploadRoute,
  loginRoute,
  signupRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  verifyEmailRoute,
  adminRoute,
  accountRoute,
  setupRoute,
  favoritesRoute,
  poolsRoute,
  poolRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
