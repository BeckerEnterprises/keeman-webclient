/**
 * Checks the confirmation of a displayed recovery key: the user types its
 * last group. Input rules as for the recovery key itself: spaces, tabs, line
 * breaks and hyphens are ignored, only `a`–`z` count as upper case.
 */
export function matchesRecoveryKeyGroup(
  display: string,
  input: string,
): boolean {
  const expected = /(?:^| )(\S{4})$/.exec(display.trim())?.[1] ?? "";
  const typed = input
    .replace(/[ \t\r\n-]/g, "")
    .replace(/[a-z]/g, (c) => c.toUpperCase());
  return expected !== "" && typed === expected;
}
