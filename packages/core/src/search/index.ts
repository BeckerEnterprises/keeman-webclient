/**
 * Entry search: runs on the decrypted data in the client. Fields are
 * normalised once per parsed entry; passwords, `otp`, history and
 * attachments are never searched.
 */
import type { Entry } from "../model/entry";
import { normalizeSearchText } from "./normalize";

export type SearchScope =
  | { kind: "all" }
  | { kind: "vault"; vaultId: string }
  | { kind: "group"; vaultId: string; groupId: string };

export interface SearchQuery {
  text: string;
  scope: SearchScope;
  /** Include the recycle bin; always within a trashed group. */
  includeTrash: boolean;
  /** `user_data.settings.searchProtectedFields`. */
  searchProtected: boolean;
}

interface Haystacks {
  plain: string;
  protected: string | undefined;
}

// Fields are joined with a character no term contains, so a term never
// matches across two fields.
const SEPARATOR = "\u0000";

export class SearchIndex {
  #cache = new WeakMap<Entry, Haystacks>();

  #haystacks(entry: Entry): Haystacks {
    let cached = this.#cache.get(entry);
    if (!cached) {
      const plain = [
        entry.title,
        entry.username,
        entry.url,
        entry.notes,
        ...entry.tags,
        ...entry.fields.map((field) => field.name),
        ...entry.fields.filter((f) => !f.protected).map((f) => f.value),
      ];
      cached = {
        plain: plain.map(normalizeSearchText).join(SEPARATOR),
        protected: undefined,
      };
      this.#cache.set(entry, cached);
    }
    return cached;
  }

  matches(
    entry: Entry,
    terms: readonly string[],
    searchProtected: boolean,
  ): boolean {
    const haystacks = this.#haystacks(entry);
    let text = haystacks.plain;
    if (searchProtected) {
      haystacks.protected ??= entry.fields
        .filter((field) => field.protected)
        .map((field) => normalizeSearchText(field.value))
        .join(SEPARATOR);
      text = `${text}${SEPARATOR}${haystacks.protected}`;
    }
    return terms.every((term) => text.includes(term));
  }
}
