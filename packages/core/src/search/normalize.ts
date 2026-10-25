/**
 * Normalisation for the search: compatibility decomposition, no
 * combining marks, then case folding that turns "ß" into "ss".
 */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .toLowerCase();
}

/** The whitespace-separated terms of a query; all must match. */
export function searchTerms(query: string): string[] {
  return normalizeSearchText(query)
    .split(/\s+/u)
    .filter((term) => term !== "");
}
