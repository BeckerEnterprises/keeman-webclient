/**
 * Opening a resolved URL: only an allowed scheme, never a
 * forbidden one, in a new tab without opener and referrer. Errors and
 * cycles block opening as well.
 */
import {
  checkScheme,
  type ResolvedUrl,
  type SchemeProblem,
  type UrlError,
} from "@keeman/core";

export type UrlProblem = UrlError | SchemeProblem | "cycle";

/** Why a resolved URL may not be opened; `undefined` if it may. */
export function urlProblem(
  result: ResolvedUrl,
  allowed: readonly string[],
): UrlProblem | undefined {
  if (!result.ok) return result.error;
  if (result.warnings.includes("cycle")) return "cycle";
  return checkScheme(result.url, allowed);
}

/** Opens the URL, or returns why it may not be opened. */
export function openUrl(
  result: ResolvedUrl,
  allowed: readonly string[],
): UrlProblem | undefined {
  const problem = urlProblem(result, allowed);
  if (problem === undefined && result.ok)
    window.open(result.url, "_blank", "noopener,noreferrer");
  return problem;
}
