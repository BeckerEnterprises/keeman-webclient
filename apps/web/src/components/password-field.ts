/** What PasswordInput.vue exposes to its parent (typed for ESLint, too). */
export interface PasswordField {
  value(): string;
  clear(): void;
  focus(): void;
}
