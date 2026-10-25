/**
 * Master password rules: at least 12 code points after NFC and a
 * zxcvbn score of 3 or more. The dictionaries are loaded only when needed.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MIN_PASSWORD_SCORE = 3;

export type Scorer = (password: string, userInputs: string[]) => number;

let scorer: Promise<Scorer> | undefined;

export function loadScorer(): Promise<Scorer> {
  scorer ??= (async () => {
    const [{ ZxcvbnFactory }, common, de, en] = await Promise.all([
      import("@zxcvbn-ts/core"),
      import("@zxcvbn-ts/language-common"),
      import("@zxcvbn-ts/language-de"),
      import("@zxcvbn-ts/language-en"),
    ]);
    const factory = new ZxcvbnFactory({
      dictionary: { ...common.dictionary, ...de.dictionary, ...en.dictionary },
      graphs: common.adjacencyGraphs,
      translations: en.translations,
    });
    return (password, userInputs) => factory.check(password, userInputs).score;
  })();
  scorer.catch(() => {
    scorer = undefined;
  });
  return scorer;
}

export type PasswordProblem =
  "too_short" | "too_weak" | "mismatch" | "unchanged" | "malformed";

export interface PasswordCheck {
  password: string;
  confirmation: string;
  email: string;
  /** The current password when changing it. */
  previous?: string;
}

/** Inputs that make a password guessable: the e-mail, its local part, the product. */
export function userInputs(email: string): string[] {
  const normalized = email.trim().toLowerCase();
  return [normalized, normalized.split("@")[0] ?? "", "keeman"].filter(
    (input) => input.length > 0,
  );
}

export function checkNewPassword(
  check: PasswordCheck,
  score: Scorer,
): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  if (!check.password.isWellFormed()) return ["malformed"];
  const normalized = check.password.normalize("NFC");
  if (Array.from(normalized).length < MIN_PASSWORD_LENGTH)
    problems.push("too_short");
  else if (score(check.password, userInputs(check.email)) < MIN_PASSWORD_SCORE)
    problems.push("too_weak");
  if (normalized !== check.confirmation.normalize("NFC"))
    problems.push("mismatch");
  if (
    check.previous !== undefined &&
    normalized === check.previous.normalize("NFC")
  )
    problems.push("unchanged");
  return problems;
}

/** Leading or trailing spaces are kept but pointed out. */
export function hasOuterSpace(password: string): boolean {
  return password !== password.trim();
}
