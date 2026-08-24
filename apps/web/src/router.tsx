import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

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
  // `q` is the booru search query (tags/metatags) the gallery filters by.
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = typeof search.q === "string" ? search.q.trim() : "";
    return q ? { q } : {};
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
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
