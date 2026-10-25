/** Dates in the language of the UI. */
import { currentLocale } from "./i18n";

export function formatDate(
  iso: string | undefined | null,
  withTime = true,
): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: "medium",
    timeStyle: withTime ? "short" : undefined,
  }).format(date);
}

const UNITS = ["B", "KB", "MB", "GB"];

/** File sizes with binary steps, e.g. "1,5 MB" (KB = 1024 bytes). */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const number = new Intl.NumberFormat(currentLocale(), {
    maximumFractionDigits: unit === 0 || value >= 100 ? 0 : 1,
  }).format(value);
  return `${number} ${UNITS[unit] ?? "B"}`;
}
