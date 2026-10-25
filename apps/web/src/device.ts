/** Session name `<Browser> · <OS>`, never the full user agent. */
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

function match(
  table: [RegExp, string][],
  userAgent: string,
): string | undefined {
  return table.find(([pattern]) => pattern.test(userAgent))?.[1];
}

export function deviceName(userAgent: string): string {
  const parts = [match(BROWSERS, userAgent), match(SYSTEMS, userAgent)].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 0 ? parts.join(" · ") : "Web";
}
