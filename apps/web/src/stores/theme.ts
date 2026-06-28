import { useEffect } from "react";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePreference = "light" | "dark" | "auto";

interface ThemeState {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}

/** Persisted theme preference (light · dark · auto/system). */
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: "auto",
      setTheme: (theme) => set({ theme }),
    }),
    { name: "bunbooru:theme" },
  ),
);

/** Whether the effective theme should be dark, given the preference + system. */
function resolveDark(theme: ThemePreference): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Apply the resolved theme to `<html>` (toggles the `dark` class) and, in auto
 * mode, follow the OS preference live. Mount once near the app root.
 */
export function useApplyTheme(): void {
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const apply = () => {
      document.documentElement.classList.toggle("dark", resolveDark(theme));
    };
    apply();

    if (theme !== "auto") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}
