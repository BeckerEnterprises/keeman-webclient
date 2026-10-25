/** Shared state of the password strength meter. */
import { onMounted, ref, type Ref } from "vue";
import { loadScorer, userInputs, type Scorer } from "./password";

export function usePasswordStrength(email: Ref<string>) {
  const state = ref<"loading" | "ready" | "failed">("loading");
  const score = ref<number | undefined>();
  let scorer: Scorer | undefined;

  onMounted(async () => {
    try {
      scorer = await loadScorer();
      state.value = "ready";
    } catch {
      state.value = "failed";
    }
  });

  /** Keeps only the score, never the password. */
  function rate(password: string): void {
    score.value =
      scorer && password.length > 0
        ? scorer(password, userInputs(email.value))
        : undefined;
  }

  return { state, score, rate, scorer: (): Scorer | undefined => scorer };
}
