import { Monitor, Moon, Sun } from "lucide-react";

import { type ThemePreference, useThemeStore } from "../stores/theme";

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "auto", label: "Auto", Icon: Monitor },
];

/** Segmented Light · Dark · Auto theme control. */
export function ThemeSwitcher() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <div className="inline-flex overflow-hidden rounded border border-line">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
          className={`flex items-center px-1.5 py-0.5 ${
            theme === value ? "bg-link text-white" : "text-muted hover:text-link"
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
