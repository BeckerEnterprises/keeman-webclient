import { loadTheme, saveTheme, type Theme } from "./storage";

/** Device-local theme; `system` follows prefers-color-scheme. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function initTheme(): Theme {
  const theme = loadTheme();
  applyTheme(theme);
  return theme;
}

export function setTheme(theme: Theme): void {
  saveTheme(theme);
  applyTheme(theme);
}
