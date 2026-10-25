/** Short status messages (copied, cleared); never contain values. */
import { defineStore } from "pinia";

export interface Toast {
  id: number;
  key: string;
  values: Record<string, string | number>;
}

let next = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useToastStore = defineStore("toast", {
  state: () => ({ toasts: [] as Toast[] }),
  actions: {
    show(
      key: string,
      values: Record<string, string | number> = {},
      ms = 4000,
    ): number {
      const id = next++;
      this.toasts = [...this.toasts.slice(-2), { id, key, values }];
      timers.set(
        id,
        setTimeout(() => {
          this.dismiss(id);
        }, ms),
      );
      return id;
    },
    dismiss(id: number): void {
      clearTimeout(timers.get(id));
      timers.delete(id);
      this.toasts = this.toasts.filter((t) => t.id !== id);
    },
  },
});
