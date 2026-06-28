import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { RootLayout } from "./routes/__root";
import { HomePage } from "./routes/home";
import { PostDetailPage } from "./routes/post-detail";
import { PostsPage } from "./routes/posts";
import { UploadPage } from "./routes/upload";

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

const routeTree = rootRoute.addChildren([
  homeRoute,
  postsRoute,
  postDetailRoute,
  uploadRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
