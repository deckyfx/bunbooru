import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { queryClient } from "./lib/query";
import { registerPwa } from "./pwa/register";
import { router } from "./router";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");

registerPwa();

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
